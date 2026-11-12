/**
 * Search copilot for the vault map (#207) — a small local agent behind the
 * search box. The user chats to deepen a search that didn't surface what
 * they were after; the agent turns the conversation into several recall
 * queries, runs them against the vault, and answers GROUNDED in the hits.
 *
 * Everything stays on the machine: the chat model is the same local Ollama
 * generation model doc2query uses; the route is loopback-only and gated on
 * ui.enabled like the rest of /ui.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SearchIndex, RecallHit } from "@bastra-recall/core";
import { getUiEnabled } from "./settings.js";
import { sendJsonPlain } from "./webui.js";
import type { ChatHistory } from "./chat-history.js";

/** Same shape as the doc2query ChatFn: prompt in, raw model reply out. */
export type ChatFn = (prompt: string) => Promise<string>;

export interface CopilotDeps {
  search: SearchIndex;
  chat: ChatFn | null;
  /** Full body of a (non-private) memory — the answer grounds in real
   *  content, not just summary snippets. */
  getBody?: (id: string) => string | null;
  /** Stores each exchange (chat-history.ts); absent → nothing is stored. */
  history?: () => ChatHistory;
  /** Private memories are never kept as a stored source title. */
  isPrivate?: (id: string) => boolean;
}

export interface CopilotHit {
  id: string;
  title: string;
  type: string;
  score: number;
}

const MAX_MESSAGE = 2000;
const MAX_HISTORY = 8;
const QUERIES_MAX = 3;
const HITS_PER_QUERY = 6;
const HITS_TOTAL = 8;

export function buildQueryPrompt(message: string, history: Array<{ role: string; content: string }>): string {
  const ctx = history
    .slice(-4)
    .map((h) => `${h.role === "user" ? "User" : "Copilot"}: ${h.content}`)
    .join("\n");
  return [
    "You turn a user's question about their personal note vault into search queries.",
    ctx ? `Conversation so far:\n${ctx}` : "",
    `Question: "${message}"`,
    `Reply with 1-${QUERIES_MAX} short search queries, ONE PER LINE, no numbering, no commentary.`,
    "Vary the angle: key terms, synonyms, related concepts. Use the question's language AND English.",
    "FIX obvious typos and misspellings in your queries (the raw question may contain them).",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildAnswerPrompt(
  message: string,
  hits: RecallHit[],
  getBody?: (id: string) => string | null,
): string {
  // the strongest hits contribute their real content — a summary snippet is
  // too thin to answer "what did I say about X" with substance
  const listing = hits.length
    ? hits
        .map((h, i) => {
          const body = i < 3 ? getBody?.(h.id) : null;
          const content = body
            ? body.replace(/\s+/g, " ").trim().slice(0, 600)
            : h.summary.slice(0, 220);
          return `- id: ${h.id}\n  title: ${h.title} (${h.type})\n  content: ${content}`;
        })
        .join("\n")
    : "(no notes found)";
  return [
    "You are the search copilot of a personal note vault. The vault search returned these notes:",
    listing,
    `User question: "${message}"`,
    "Reply with STRICT JSON, nothing else:",
    '{"reply": "<2-5 sentences in the user\'s language, grounded ONLY in the notes above — quote their actual rules/content where it answers the question, never invent>", "relevant": ["<ids of the notes that actually answer the question>"]}',
    'If none of the notes fit, say the SEARCH did not surface it and suggest a sharper search term — never claim the thing does not exist (the vault may hold it under different words). Return "relevant": [] in that case.',
  ].join("\n\n");
}

/** Model reply → clean query list; the raw message is always included so a
 *  rambling model can never make the search WORSE than a plain recall. */
export function parseQueries(raw: string, message: string): string[] {
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length >= 2 && l.length <= 120 && !l.includes("{"));
  const out = [message, ...lines.slice(0, QUERIES_MAX)];
  return [...new Set(out.map((q) => q.toLowerCase()))].map(
    (q) => out.find((o) => o.toLowerCase() === q) as string,
  );
}

/** Tolerant JSON extraction: models wrap JSON in prose/fences. `parsed:false`
 *  means the caller should fall back to its own hit selection. */
export function parseAnswer(raw: string): { reply: string; relevant: string[]; parsed: boolean } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const json = JSON.parse(match[0]) as { reply?: unknown; relevant?: unknown };
      if (typeof json.reply === "string" && json.reply.trim()) {
        const relevant = Array.isArray(json.relevant)
          ? json.relevant.filter((r): r is string => typeof r === "string")
          : [];
        return { reply: json.reply.trim(), relevant, parsed: true };
      }
    } catch {
      /* fall through to the reply-value rescue below */
    }
  }
  // truncated/malformed JSON: the reply VALUE is usually intact even when the
  // closing braces never arrived — extract it so raw JSON never hits the chat
  const replyValue = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (replyValue) {
    let text: string;
    try {
      text = JSON.parse(`"${replyValue[1]}"`) as string;
    } catch {
      text = replyValue[1]; // ends mid-escape — keep it readable as-is
    }
    if (text.trim()) return { reply: text.trim(), relevant: [], parsed: false };
  }
  return { reply: raw.trim(), relevant: [], parsed: false };
}

export async function runSearchCopilot(
  message: string,
  history: Array<{ role: string; content: string }>,
  deps: { search: SearchIndex; chat: ChatFn; getBody?: (id: string) => string | null },
): Promise<{ reply: string; hits: CopilotHit[] }> {
  const queries = parseQueries(await deps.chat(buildQueryPrompt(message, history)), message);
  const merged = new Map<string, RecallHit>();
  for (const q of queries) {
    const hits = await deps.search.recallHybrid(q, { k: HITS_PER_QUERY, allow_private: false });
    for (const h of hits) {
      const prev = merged.get(h.id);
      if (!prev || prev.score < h.score) merged.set(h.id, h);
    }
  }
  const top = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, HITS_TOTAL);

  const answer = parseAnswer(await deps.chat(buildAnswerPrompt(message, top, deps.getBody)));
  // model picked → trust it (including an explicit "nothing fits" = []);
  // unparseable reply → surface the strongest hits rather than none
  const chosen = answer.parsed
    ? top.filter((h) => answer.relevant.includes(h.id))
    : top.slice(0, 3);
  return {
    reply: answer.reply || "…",
    hits: chosen.map((h) => ({ id: h.id, title: h.title, type: h.type, score: h.score })),
  };
}

/** POST /ui/chat — { message, history? } → { reply, hits }. 503 when no
 *  local generation model is wired (embeddings off / non-Ollama setups). */
export async function handleUiChat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CopilotDeps,
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  if (!deps.chat) {
    sendJsonPlain(res, 503, { error: "no local chat model available" });
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      sendJsonPlain(res, 413, { error: "body too large" });
      return;
    }
  }
  let message = "";
  let history: Array<{ role: string; content: string }> = [];
  let conversationId: string | null = null;
  try {
    const body = JSON.parse(raw) as { message?: unknown; history?: unknown; conversation_id?: unknown };
    conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;
    message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
    if (Array.isArray(body.history)) {
      history = body.history
        .filter(
          (h): h is { role: string; content: string } =>
            typeof h === "object" &&
            h !== null &&
            typeof (h as { role?: unknown }).role === "string" &&
            typeof (h as { content?: unknown }).content === "string",
        )
        .slice(-MAX_HISTORY)
        .map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.content.slice(0, MAX_MESSAGE) }));
    }
  } catch {
    sendJsonPlain(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (!message) {
    sendJsonPlain(res, 400, { error: "message required" });
    return;
  }
  try {
    const result = await runSearchCopilot(message, history, {
      search: deps.search,
      chat: deps.chat,
      getBody: deps.getBody,
    });
    let conversation_id: string | null = null;
    if (deps.history) {
      // A failing store must not cost the user the answer.
      try {
        const sources = result.hits.filter((h) => !deps.isPrivate?.(h.id)).map((h) => ({ id: h.id, type: h.type, title: h.title }));
        conversation_id = deps.history().append(conversationId, message, result.reply, sources);
      } catch (err) {
        process.stderr.write(`[bastra-recall] chat history not stored: ${(err as Error).message}\n`);
      }
    }
    sendJsonPlain(res, 200, { ...result, conversation_id });
  } catch (err) {
    sendJsonPlain(res, 502, { error: `copilot failed: ${(err as Error).message}` });
  }
}
