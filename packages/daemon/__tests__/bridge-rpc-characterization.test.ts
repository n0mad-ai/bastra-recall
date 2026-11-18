/**
 * #1529: the app bridge's stdio protocol pinned before `main` is cut into its
 * start steps and a method table: every method, its errors, an unknown method,
 * a malformed line and the disabled task tools.
 *
 * Runs src/bridge.ts in a child process against a temp vault. Paths, times and
 * ids are replaced by placeholders. Expected replies: fixtures/bridge-rpc-golden.json;
 * record replies again after a deliberate change with BASTRA_GOLDEN_WRITE=1.
 * Watcher duplicates have no fixed count: their full payload and position are
 * checked separately from each mutation's mandatory notification before reply.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const memory = {
  title: "Bridge golden memory",
  type: "lesson",
  summary: "A memory written through the bridge for the protocol characterization.",
  body: "The bridge answers line by line on stdout.",
  topic_path: ["bridge", "golden"],
  tags: ["bridge"],
  scope: "golden",
  recall_when: ["checking the bridge protocol"],
};

const REQUESTS: Array<Record<string, unknown> | string> = [
  "this is not json",
  { method: "vault_status" },
  { method: "save_memory", params: { ...memory, dry_run: true } },
  { method: "save_memory", params: { ...memory, dry_run: "true" } },
  { method: "vault_status" },
  { method: "audit_history", params: { memory_id: "bridge-golden-memory" } },
  { method: "save_memory", params: { ...memory, title: "" } },
  { method: "save_memory", params: memory },
  { method: "vault_status" },
  { method: "list_memorys" },
  { method: "list_memorys", params: { type: "decision" } },
  { method: "list_memorys", params: { scope: "golden" } },
  { method: "load_memory", params: { id: "bridge-golden-memory" } },
  { method: "load_memory", params: { id: "absent" } },
  { method: "recall", params: { query: "bridge protocol", k: 3 } },
  { method: "recall", params: { query: "nothing matches zzzz" } },
  { method: "reindex_file", params: {} },
  { method: "docs_settings_get" },
  { method: "docs_settings_set", params: { mode: "bogus" } },
  { method: "docs_settings_set", params: { language: "not a tag" } },
  { method: "docs_settings_set", params: { mode: "suggest", language: "DE" } },
  { method: "audit_history", params: {} },
  { method: "audit_history", params: { memory_id: "bridge-golden-memory" } },
  { method: "audit_recent", params: {} },
  { method: "audit_recent", params: { since: "2000-01-01T00:00:00.000Z", operation: "save" } },
  { method: "delete_memory", params: {} },
  { method: "delete_memory", params: { id: "bridge-golden-memory" } },
  { method: "restore_memory", params: {} },
  { method: "restore_memory", params: { id: "bridge-golden-memory" } },
  { method: "vault_status" },
  { method: "no_such_method" },
  { method: ["vault_status"] },
  { method: "task_list", params: {} },
];

interface NotificationWindow {
  request: Record<string, unknown>;
  reply: Record<string, unknown>;
  events: unknown[];
}

function checkNotifications(windows: NotificationWindow[], trailing: unknown[] = []): void {
  let present = false;
  const batches: NotificationWindow[] = [...windows, { request: {}, reply: {}, events: trailing }];
  for (const { request, reply, events } of batches) {
    const mutation =
      !reply.error && ["save_memory", "delete_memory", "restore_memory"].includes(String(request.method));
    const required = mutation ? (request.method === "delete_memory" ? "remove" : "add") : undefined;
    let seen = false;
    for (const event of events) {
      assert.ok(event && typeof event === "object", "notification is an object");
      const kind = (event as Record<string, unknown>).kind;
      assert.deepEqual(event, { event: "vault_changed", kind, memory_id: "bridge-golden-memory" });
      assert.ok(kind === "add" || kind === "remove" || kind === "change", "known vault event kind");
      if (kind === "change") {
        assert.ok(present, "watcher change requires an existing memory");
      } else {
        assert.equal(kind, required, "notification belongs to this mutation");
        assert.equal(seen, false, "one primary notification per mutation");
        assert.equal(present, kind === "remove", "add/remove follow memory lifetime order");
        present = kind === "add";
        seen = true;
      }
    }
    if (required) assert.ok(seen, `${String(request.method)} notification must precede its reply`);
  }
}

async function run(): Promise<unknown[]> {
  const root = await mkdtemp(join(tmpdir(), "bastra-bridge-golden-"));
  const vault = join(root, "vault");
  const home = join(root, "home");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("../src/bridge.ts", import.meta.url))],
    {
      env: {
        ...process.env,
        HOME: home,
        BASTRA_VAULT_PATH: vault,
        BASTRA_VAULT_RECONCILE_MS: "0",
        BASTRA_TASKS: "0",
        BASTRA_EMBEDDING_PROVIDER: "none",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let out = "",
    err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const until = async (ok: () => boolean, what: string) => {
    const deadline = Date.now() + 15000;
    while (!ok()) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`${what}; stderr: ${err}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    await until(() => err.includes("] ready"), "bridge did not become ready");
    const replies: unknown[] = [];
    const windows: NotificationWindow[] = [];
    let consumed = 0;
    let id = 0;
    for (const request of REQUESTS) {
      if (typeof request === "string") {
        child.stdin.write(request + "\n");
        continue;
      }
      id++;
      child.stdin.write(JSON.stringify({ id, ...request }) + "\n");
      const want = `"id":${id},`;
      await until(() => out.split("\n").some((l) => l.startsWith(`{${want}`)), `no reply to ${request.method}`);
      const lines = out.split("\n").filter(Boolean);
      const at = lines.findIndex((l) => l.startsWith(`{${want}`));
      const reply = JSON.parse(lines[at]) as Record<string, unknown>;
      windows.push({ request, reply, events: lines.slice(consumed, at).map((l) => JSON.parse(l)) });
      consumed = at + 1;
      replies.push({ request, reply });
    }
    checkNotifications(
      windows,
      out
        .split("\n")
        .filter(Boolean)
        .slice(consumed)
        .map((l) => JSON.parse(l))
    );
    const text = JSON.stringify(replies)
      .split(vault)
      .join("<VAULT>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>")
      .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
      .replace(/"[a-z0-9]{8}-[a-z0-9]{6}"/g, '"<AUDIT>"')
      .replace(/"(score|bm25|vector|rrf|score_[a-z_]+)":-?[\d.e+-]+/g, '"$1":"<N>"');
    return JSON.parse(text);
  } finally {
    child.stdin.end();
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
    await rm(root, { recursive: true, force: true });
  }
}

const golden = new URL("./fixtures/bridge-rpc-golden.json", import.meta.url);

test("#1529: bridge replies per method are unchanged", { timeout: 60000 }, async () => {
  const actual = await run();
  const expected = JSON.parse(await readFile(golden, "utf8")) as unknown[];
  // The legacy last row records only a timing-dependent watcher event count.
  // Every actual event is checked above, including kind, id and reply boundary.
  assert.deepEqual(expected.at(-1), { unsolicited: Array(4).fill("vault_changed") });
  if (process.env.BASTRA_GOLDEN_WRITE === "1") {
    await writeFile(golden, JSON.stringify([...actual, expected.at(-1)], null, 2) + "\n");
    return;
  }
  assert.deepEqual(actual, expected.slice(0, -1));
});

test("#1529: notification checks require ordered mutation events and validate optional watcher duplicates", () => {
  const event = (kind: string) => ({ event: "vault_changed", kind, memory_id: "bridge-golden-memory" });
  const window = (method: string, ...kinds: string[]): NotificationWindow => ({
    request: { method },
    reply: { result: {} },
    events: kinds.map(event),
  });
  const sequence = () => [
    window("save_memory", "add"),
    window("delete_memory", "remove"),
    window("restore_memory", "add"),
  ];
  checkNotifications(sequence()); // Watcher suppressed/delayed: primary events are sufficient.
  checkNotifications(
    [
      window("save_memory", "add", "change"),
      window("vault_status", "change"),
      window("delete_memory", "change", "remove"),
      window("restore_memory", "add", "change"),
    ],
    [event("change")]
  );
  for (const index of [0, 1, 2]) {
    const missing = sequence();
    missing[index].events = [];
    assert.throws(() => checkNotifications(missing), /notification must precede/);
  }
  for (const bad of [
    { ...event("add"), memory_id: "wrong" },
    { ...event("add"), event: "unexpected" },
    { ...event("add"), extra: true },
    event("wrong"),
    event("remove"),
  ]) {
    const wrong = sequence();
    wrong[0].events = [bad];
    assert.throws(() => checkNotifications(wrong));
  }
  assert.throws(() => checkNotifications([window("save_memory", "change", "add")]), /existing memory/);
  assert.throws(() => checkNotifications([window("vault_status", "add")]), /belongs to this mutation/);
  assert.throws(() => checkNotifications([window("save_memory", "add", "add")]), /one primary/);
  assert.throws(() => checkNotifications(sequence(), [event("remove")]));
});
