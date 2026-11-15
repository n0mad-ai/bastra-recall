/**
 * Conversation history of the web UI's agent window (Daniel, 13.11.2026).
 * UI state lives in the local app database (recall.db, migration v2
 * "agent-chat-history"); memories stay Markdown in the vault and nothing here
 * is written to the vault. Retention is unlimited; a conversation is deleted
 * as a whole by the user.
 *
 * Routes (loopback-only, ui.enabled, same gates as POST /ui/chat):
 *   GET    /ui/chat/conversations        → { conversations: [{ id, title, created, updated, count }] }
 *   GET    /ui/chat/conversations/<id>   → { id, title, created, updated, messages: [{ role, text, sources, at }] }
 *   DELETE /ui/chat/conversations/<id>   → { ok: true }   (Origin/Content-Type gate as for POST)
 * POST /ui/chat appends question + answer + sources (webui-chat.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { openAppDatabase, type AppDatabase } from "./app-database.js";
import { gateLocalPost } from "./http-auth.js";
import { getUiEnabled } from "./settings.js";
import { sendJsonPlain } from "./webui.js";

export interface ChatSource {
  id: string;
  type: string;
  title: string;
}
export interface ChatConversation {
  id: string;
  title: string;
  created: number;
  updated: number;
  count: number;
}
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sources: ChatSource[];
  at: number;
}

const TITLE_MAX = 80;
const LIST_MAX = 200;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** First question, whitespace collapsed, cut at a word near TITLE_MAX. */
export function conversationTitle(question: string): string {
  const q = question.replace(/\s+/g, " ").trim();
  if (q.length <= TITLE_MAX) return q;
  const cut = q.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export class ChatHistory {
  constructor(private readonly db: AppDatabase) {}

  /** Appends one exchange. An unknown, deleted or missing id starts a new conversation. */
  append(
    conversationId: string | null | undefined,
    question: string,
    answer: string,
    sources: ChatSource[],
    now = Date.now()
  ): string {
    return this.db.transaction(() => {
      let id = typeof conversationId === "string" && ID_RE.test(conversationId) ? conversationId : null;
      if (id && !this.db.sqlite.prepare("SELECT 1 FROM chat_conversations WHERE id=?").get(id)) id = null;
      if (!id) {
        id = randomUUID();
        this.db.sqlite
          .prepare("INSERT INTO chat_conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)")
          .run(id, conversationTitle(question), now, now);
      } else this.db.sqlite.prepare("UPDATE chat_conversations SET updated_at=? WHERE id=?").run(now, id);
      const insert = this.db.sqlite.prepare(
        "INSERT INTO chat_messages(conversation_id,role,text,sources,created_at) VALUES(?,?,?,?,?)"
      );
      insert.run(id, "user", question, "[]", now);
      insert.run(
        id,
        "assistant",
        answer,
        JSON.stringify(sources.map((s) => ({ id: s.id, type: s.type, title: s.title }))),
        now
      );
      return id;
    });
  }

  list(): ChatConversation[] {
    return this.db.sqlite
      .prepare(
        `SELECT c.id, c.title, c.created_at, c.updated_at, (SELECT count(*) FROM chat_messages m WHERE m.conversation_id=c.id AND m.role='user') AS n
      FROM chat_conversations c ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`
      )
      .all(LIST_MAX)
      .map((r) => ({
        id: String(r.id),
        title: String(r.title),
        created: Number(r.created_at),
        updated: Number(r.updated_at),
        count: Number(r.n),
      }));
  }

  get(id: string): (Omit<ChatConversation, "count"> & { messages: ChatMessage[] }) | null {
    if (!ID_RE.test(id)) return null;
    const c = this.db.sqlite
      .prepare("SELECT id,title,created_at,updated_at FROM chat_conversations WHERE id=?")
      .get(id);
    if (!c) return null;
    const messages = this.db.sqlite
      .prepare("SELECT role,text,sources,created_at FROM chat_messages WHERE conversation_id=? ORDER BY id")
      .all(id)
      .map((r) => ({
        role: r.role === "user" ? ("user" as const) : ("assistant" as const),
        text: String(r.text),
        sources: JSON.parse(String(r.sources)) as ChatSource[],
        at: Number(r.created_at),
      }));
    return {
      id: String(c.id),
      title: String(c.title),
      created: Number(c.created_at),
      updated: Number(c.updated_at),
      messages,
    };
  }

  /** true when the conversation existed. Its messages go with it (ON DELETE CASCADE). */
  remove(id: string): boolean {
    if (!ID_RE.test(id)) return false;
    return Number(this.db.sqlite.prepare("DELETE FROM chat_conversations WHERE id=?").run(id).changes) > 0;
  }
}

let shared: ChatHistory | null = null;
/** One connection per process on the default recall.db (BASTRA_DB_PATH, ~/.bastra/recall.db). */
export function chatHistory(): ChatHistory {
  shared ??= new ChatHistory(openAppDatabase());
  return shared;
}

/** Handles /ui/chat/conversations[/<id>]. Returns false for other paths. */
export function dispatchChatHistory(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  history: () => ChatHistory = chatHistory,
  settingsPath?: string
): boolean {
  const path = url.split("?", 1)[0]!;
  const m = /^\/ui\/chat\/conversations(?:\/([^/]+))?$/.exec(path);
  if (!m) return false;
  const id = m[1] ? decodeURIComponent(m[1]) : null;
  if (!(method === "GET" || (method === "DELETE" && id))) return false;
  void (async () => {
    if (!(await getUiEnabled(settingsPath))) {
      sendJsonPlain(res, 404, { error: "ui disabled" });
      return;
    }
    if (method === "DELETE") {
      // Same Origin / Content-Type rule as every local POST (http.ts gateLocalPost).
      const gate = gateLocalPost({
        origin: req.headers.origin,
        host: req.headers.host,
        contentType: req.headers["content-type"],
        path,
      });
      if (gate !== 200) {
        sendJsonPlain(res, gate, { error: gate === 403 ? "origin not allowed" : "unsupported content type" });
        return;
      }
      if (!history().remove(id!)) {
        sendJsonPlain(res, 404, { error: "no such conversation" });
        return;
      }
      sendJsonPlain(res, 200, { ok: true });
      return;
    }
    if (!id) {
      sendJsonPlain(res, 200, { conversations: history().list() });
      return;
    }
    const conv = history().get(id);
    if (!conv) {
      sendJsonPlain(res, 404, { error: "no such conversation" });
      return;
    }
    sendJsonPlain(res, 200, conv);
  })().catch(() => sendJsonPlain(res, 500, { error: "chat history error" }));
  return true;
}
