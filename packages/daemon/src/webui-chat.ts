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
  /** Raw `task_list` result (`tasks` array) of the daemon's task store, for
   *  questions asked in the tasks area; null = tasks disabled. */
  listTasks?: () => Promise<unknown>;
}

/** What the tasks area hands the answer prompt about one task. */
export interface TaskBrief {
  title: string;
  state: string;
  armed: boolean;
  /** Next contact time, same order as the UI's dueAt(); null = none. */
  dueAt: number | null;
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

const TERMINAL_TASK_STATES = new Set(["resolved", "cancelled", "expired"]);
const TASKS_MAX = 25;

/** Long goals stay readable in a one-line chat answer: cut at a word
 *  boundary; double quotes would break the model's JSON reply. */
function shortTitle(title: string): string {
  const plain = title.replace(/"/g, "'");
  if (plain.length <= 90) return plain;
  const cut = plain.slice(0, 90);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 50 ? cut.lastIndexOf(" ") : 90).replace(/[\s,.;:-]+$/, "")}…`;
}

/** `task_list` result → task briefs. External data: every field is checked. */
export function tasksFromList(raw: unknown): TaskBrief[] {
  const list = Array.isArray(raw) ? raw : [];
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out: TaskBrief[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, any>;
    if (t.archived) continue;
    const title = typeof t.goal === "string" ? t.goal.replace(/\s+/g, " ").trim() : "";
    if (!title) continue;
    const dueAt = num(t.snoozed_until) ?? num(t.next_slot?.at) ?? num(t.schedule?.at) ?? num(t.next_check_at);
    out.push({ title: shortTitle(title), state: typeof t.state === "string" ? t.state : "unknown", armed: t.armed === true, dueAt });
  }
  return out;
}

function localParts(at: number, timeZone?: string): { day: string; text: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(at)).map((p) => [p.type, p.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { day, text: `${parts.weekday} ${day} ${parts.hour}:${parts.minute}` };
}

const STATE_WORDS: Record<string, string> = {
  pending: "planned, not due yet",
  due: "due, waiting for the user",
  snoozed: "snoozed",
};

/** Real tasks as prompt context, bucketed by local day (overdue / today /
 *  later) so even a small model can answer "what is due today" without
 *  date arithmetic. null tasks = the task list could not be read. */
export function buildTaskContext(tasks: TaskBrief[] | null, now: number, timeZone?: string): string {
  const today = localParts(now, timeZone);
  const head = `Current local date and time: ${today.text}.`;
  if (!tasks) return `${head}\nTASK LIST: unavailable (tasks are disabled or could not be read). Say so; do not guess tasks.`;
  const open = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state));
  const done = tasks.length - open.length;
  const line = (t: TaskBrief) => {
    const when = t.dueAt === null ? "no due time" : `due ${localParts(t.dueAt, timeZone).text}`;
    const state = STATE_WORDS[t.state] ?? t.state;
    return `- ${t.title} — ${when}; status: ${state}${t.armed ? "" : "; draft, not approved yet"}`;
  };
  const bucket = (pick: (t: TaskBrief) => boolean) => open.filter(pick).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  const dayOf = (t: TaskBrief) => (t.dueAt === null ? null : localParts(t.dueAt, timeZone).day);
  const overdue = bucket((t) => { const d = dayOf(t); return d !== null && d < today.day; });
  const dueToday = bucket((t) => dayOf(t) === today.day);
  const later = bucket((t) => { const d = dayOf(t); return d === null || d > today.day; });
  const section = (label: string, list: TaskBrief[]) =>
    `${label} (${list.length}):\n${list.length ? list.slice(0, TASKS_MAX).map(line).join("\n") : "(none)"}`;
  return [
    head,
    "TASK LIST — the user's real tasks from the task manager (the ONLY source of truth for tasks, due dates and reminders):",
    section("DUE TODAY", dueToday),
    section("OVERDUE (due before today, still open)", overdue),
    section("LATER or without due time", later),
    `Finished or cancelled tasks: ${done}.`,
  ].join("\n");
}

export function buildAnswerPrompt(
  message: string,
  hits: RecallHit[],
  getBody?: (id: string) => string | null,
  taskContext?: string,
  lang?: string,
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
  const langHint = lang ? ` (if unclear: language code "${lang}")` : "";
  if (taskContext) {
    return [
      "You are the assistant in the TASKS area of a personal memory app. You know the user's real tasks:",
      taskContext,
      "The vault search additionally returned these notes (background only, never a source for tasks):",
      listing,
      `User question: "${message}"`,
      "Reply with STRICT JSON, nothing else:",
      `{"reply": "<answer in the language of the user's question${langHint}, plain prose without line breaks and without double quotes>", "relevant": ["<ids of notes that actually helped; usually []>"]}`,
      "Questions about tasks, due dates, reminders or the schedule are answered ONLY from the TASK LIST: name each relevant task with its title, when it is due or since when it is overdue (weekday and date, time if useful) and its status in plain words. If DUE TODAY is empty, say clearly that nothing is due today, then mention overdue open tasks if there are any. Keep it short. Never invent tasks, dates or rules, and never derive tasks from notes or describe how the app works instead of answering.",
      "For other questions answer from the notes as usual, grounded only in them.",
    ].join("\n\n");
  }
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
  deps: { search: SearchIndex; chat: ChatFn; getBody?: (id: string) => string | null; taskContext?: string; lang?: string },
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

  const answer = parseAnswer(await deps.chat(buildAnswerPrompt(message, top, deps.getBody, deps.taskContext, deps.lang)));
  // model picked → trust it (including an explicit "nothing fits" = []);
  // unparseable reply → surface the strongest hits rather than none
  // (in the tasks area the answer rests on the task list, so a failed parse
  // must not dress it up with unrelated notes as sources)
  const chosen = answer.parsed
    ? top.filter((h) => answer.relevant.includes(h.id))
    : deps.taskContext ? [] : top.slice(0, 3);
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
  let area = "";
  let lang: string | undefined;
  try {
    const body = JSON.parse(raw) as { message?: unknown; history?: unknown; conversation_id?: unknown; area?: unknown; lang?: unknown };
    area = typeof body.area === "string" ? body.area : "";
    lang = typeof body.lang === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(body.lang) ? body.lang : undefined;
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
    // The tasks area answers from the real task store; the area — not words
    // in the question — decides the context (Recall is multilingual).
    let taskContext: string | undefined;
    if (area === "tasks" && deps.listTasks) {
      let tasks: TaskBrief[] | null;
      try {
        const raw = await deps.listTasks();
        tasks = raw === null ? null : tasksFromList(raw);
      } catch {
        tasks = null;
      }
      taskContext = buildTaskContext(tasks, Date.now());
    }
    const result = await runSearchCopilot(message, history, {
      search: deps.search,
      chat: deps.chat,
      getBody: deps.getBody,
      taskContext,
      lang,
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
