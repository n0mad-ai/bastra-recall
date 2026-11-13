/**
 * Agent window history (chat-history.ts): app-database migration v2
 * (backup, idempotence), the store, POST /ui/chat persistence (private
 * sources stay out) and the /ui/chat/conversations routes with the local
 * Origin / Content-Type gate on DELETE.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SearchIndex } from "@bastra-recall/core";
import { APP_MIGRATIONS, openAppDatabase } from "../src/app-database.js";
import { ChatHistory, conversationTitle, dispatchChatHistory } from "../src/chat-history.js";
import { handleUiChat } from "../src/webui-chat.js";

const fixture = () => join(mkdtempSync(join(tmpdir(), "bastra-chat-db-")), "recall.db");
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chat_%' ORDER BY name").all().map((r) => r.name);

test("migration v2 adds the chat tables after a backup of v1, once", () => {
  const path = fixture();
  const v1 = openAppDatabase({ path, migrations: APP_MIGRATIONS.slice(0, 1) });
  v1.sqlite.prepare("INSERT INTO app_records(namespace,key,value) VALUES('t','k','1')").run();
  v1.close();
  const db = openAppDatabase({ path, migrations: APP_MIGRATIONS.slice(0, 2) });
  assert.equal(db.sqlite.prepare("PRAGMA user_version").get()?.user_version, 2);
  assert.deepEqual(tables(db.sqlite), ["chat_conversations", "chat_messages"]);
  assert.equal(db.sqlite.prepare("SELECT value FROM app_records WHERE key='k'").get()?.value, "1", "v1 rows survive");
  db.close();
  const backups = readdirSync(`${path}.backups`).filter((x) => x.startsWith("before-v2-"));
  assert.equal(backups.length, 1);
  const snap = new DatabaseSync(join(`${path}.backups`, backups[0]!), { readOnly: true });
  assert.equal(snap.prepare("PRAGMA user_version").get()?.user_version, 1);
  assert.deepEqual(tables(snap), [], "backup is the state before v2");
  assert.equal(snap.prepare("SELECT value FROM app_records WHERE key='k'").get()?.value, "1");
  snap.close();
  const all = readdirSync(`${path}.backups`);
  openAppDatabase({ path, migrations: APP_MIGRATIONS.slice(0, 2) }).close();
  assert.deepEqual(readdirSync(`${path}.backups`), all, "reopening migrates nothing and backs up nothing");
});

test("store: new / continued conversations, order, cascade delete, title cut", () => {
  const db = openAppDatabase({ path: fixture() });
  const h = new ChatHistory(db);
  const a = h.append(null, "Erste Frage", "Antwort A", [{ id: "m1", type: "reference", title: "M1" }], 1000);
  assert.equal(h.append(a, "Zweite Frage", "Antwort B", [], 2000), a);
  const b = h.append("00000000-0000-4000-8000-000000000000", "Andere", "C", [], 3000);
  assert.notEqual(b, a, "unknown id starts a new conversation");
  assert.notEqual(h.append("../etc", "x", "y", [], 500), a);
  const list = h.list();
  assert.equal(list[0]!.id !== a, true, "most recently updated first");
  assert.deepEqual(list.find((c) => c.id === a), { id: a, title: "Erste Frage", created: 1000, updated: 2000, count: 2 });
  const conv = h.get(a)!;
  assert.deepEqual(conv.messages.map((m) => [m.role, m.text]), [["user", "Erste Frage"], ["assistant", "Antwort A"], ["user", "Zweite Frage"], ["assistant", "Antwort B"]]);
  assert.deepEqual(conv.messages[1]!.sources, [{ id: "m1", type: "reference", title: "M1" }]);
  assert.equal(h.remove(a), true);
  assert.equal(h.get(a), null);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM chat_messages WHERE conversation_id=?").get(a)?.n, 0, "messages go with it");
  assert.equal(h.remove(a), false);
  const long = conversationTitle(`${"wort ".repeat(30)}ende`);
  assert.ok(long.length <= 80 && long.endsWith("…"), long);
  db.close();
});

function settings(): string {
  const p = join(mkdtempSync(join(tmpdir(), "bastra-chat-settings-")), "settings.json");
  writeFileSync(p, JSON.stringify({ ui: { enabled: true } }));
  return p;
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("POST /ui/chat stores the exchange without private sources; routes list, open and delete", async () => {
  const db = openAppDatabase({ path: fixture() });
  const h = new ChatHistory(db);
  const sp = settings();
  const hit = (id: string, title: string) => ({ id, title, type: "reference", score: 1, summary: title });
  const search = { recallHybrid: async () => [hit("pub", "Öffentlich"), hit("sec", "Geheim")] } as unknown as SearchIndex;
  const chat = async (prompt: string) => (prompt.includes("STRICT JSON") ? '{"reply":"Antwort","relevant":["pub","sec"]}' : "q");
  const { base, server } = await serve((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/ui/chat") { void handleUiChat(req, res, { search, chat, history: () => h, isPrivate: (id) => id === "sec" }, sp); return; }
    if (!dispatchChatHistory(req, res, req.method ?? "GET", url, () => h, sp)) { res.statusCode = 404; res.end(); }
  });
  try {
    const post = (body: object) => fetch(`${base}/ui/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ conversation_id: string }>);
    const first = await post({ message: "Was weiß ich?" });
    assert.match(first.conversation_id, /^[0-9a-f-]{36}$/);
    const again = await post({ message: "Und weiter?", conversation_id: first.conversation_id });
    assert.equal(again.conversation_id, first.conversation_id);

    const list = await (await fetch(`${base}/ui/chat/conversations`)).json() as { conversations: Array<{ id: string; title: string; count: number }> };
    assert.deepEqual(list.conversations.map((c) => [c.id, c.title, c.count]), [[first.conversation_id, "Was weiß ich?", 2]]);
    const conv = await (await fetch(`${base}/ui/chat/conversations/${first.conversation_id}`)).json() as { messages: Array<{ sources: Array<{ id: string }> }> };
    assert.deepEqual(conv.messages[1]!.sources.map((s) => s.id), ["pub"], "the private source is not stored");
    assert.ok(!JSON.stringify(conv).includes("Geheim"));

    const del = (headers: Record<string, string>) => fetch(`${base}/ui/chat/conversations/${first.conversation_id}`, { method: "DELETE", headers });
    assert.equal((await del({ "Content-Type": "application/json", Origin: "https://evil.example" })).status, 403, "foreign origin");
    assert.equal((await del({})).status, 415, "no JSON content type");
    assert.equal((await del({ "Content-Type": "application/json", Origin: base })).status, 200);
    assert.equal((await fetch(`${base}/ui/chat/conversations/${first.conversation_id}`)).status, 404);
    assert.equal((await del({ "Content-Type": "application/json" })).status, 404);
  } finally {
    server.close(); db.close();
  }
});

test("routes answer 404 while the web UI is disabled", async () => {
  const db = openAppDatabase({ path: fixture() });
  const off = join(mkdtempSync(join(tmpdir(), "bastra-chat-off-")), "settings.json");
  writeFileSync(off, JSON.stringify({ ui: { enabled: false } }));
  const { base, server } = await serve((req, res) => { dispatchChatHistory(req, res, req.method ?? "GET", req.url ?? "", () => new ChatHistory(db), off); });
  try { assert.equal((await fetch(`${base}/ui/chat/conversations`)).status, 404); }
  finally { server.close(); db.close(); }
});
