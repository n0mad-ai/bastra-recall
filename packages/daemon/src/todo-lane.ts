/**
 * TodoWrite/update_plan lane, daemon-side (#369/#15 — the #343/#344 pattern, applied to the
 * third of the three lanes that were still booting a full node interpreter).
 *
 * The pipeline that lived in `todo-hook.ts` (#36), moved verbatim: topic
 * extraction, the min-confidence gate, the recall self-call, the #161
 * empty-streak backoff, the hint block, telemetry, usage ping. The hook file
 * is a thin client now — stdin -> POST /hook/todo -> stdout — so the client
 * side pays process start alone (measured 75ms of node interpreter start
 * against ~25ms for the compiled stub; the extraction itself was never the
 * cost).
 *
 * Same two non-changes as prompt-lane.ts / write-lane.ts, same reasons:
 * recall stays a LOOPBACK SELF-CALL to /hook/recall on this same server (so
 * the todo_hook_call telemetry series keeps measuring the same thing across
 * the migration), and session state stays on the file bus (session-state.ts).
 */
// #305: subpath leafs, never the core barrel — measured +40ms of process
// start against +0.8ms for the three leafs, on a fresh spawn per event.
import { detectProject } from "@bastra-recall/core/topics";
import { RRF_K, RRF_SCALE } from "@bastra-recall/core/rrf";
import { requiredHeadline, unfusedHeadline } from "./band-wording.js";
import { applyLaneScopeFilter, projectConfidence, projectForFilter, type ScopeFilterMode } from "./scope-filter.js";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { request } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { reportHinted } from "./hook-hinted.js";
import { hookClient } from "./hook-surface.js";
import {
  decideBackoff,
  loadSessionState,
  recordSourceEmit,
  recordSourceSuppressed,
  saveSessionState,
  wasEmitConsumed,
} from "./session-state.js";

// 600ms — same recall path, same reasoning as hook.ts.
const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 600, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.2.0";
const SCORE_FLOOR = 50;
const MUST_LOAD_SCORE = 100;
// #161: backoff source key — todo-plan hints back off independently.
const BACKOFF_SOURCE = "todo-plan";
const TOPIC_WORD_CAP = 3;
const MIN_QUERY_LEN_WITHOUT_TOPICS = 10;

export interface TodoItem {
  content?: unknown;
  status?: unknown;
  activeForm?: unknown;
}

export interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { todos?: unknown; plan?: unknown } & Record<string, unknown>;
}

export interface RecallHit {
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  score: number;
}

interface RecallResponse {
  hits: RecallHit[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
  /**
   * Der Recall lief OHNE Vektor-Arm — keine Fusion, keine Bänder, rohe
   * BM25-Werte auf offener Skala (#302 maß Spitzentreffer sechsstellig).
   * Diese Lane las das Feld gar nicht (Codex-Gegenreview): Formatter und
   * Backoff maßen die rohen Werte an 50/100, als wären es RRF-Scores — also
   * war für BM25-only-Maschinen praktisch ALLES "REQUIRED". Prompt- und
   * Write-Lane behandeln das Feld seit P0, die Todo-Lane jetzt genauso.
   */
  unfused?: boolean;
  /** Codex-Gegenreview: Kennt der VAULT den mitgeschickten Projektnamen als
   *  Scope (oder Familienmitglied)? Nur der Daemon kann das beantworten — die
   *  Lane sieht den Vault nicht. `false` heißt: nicht filtern. */
  project_known?: boolean;
}

// Tiny stopword list — covers the most-common DE/EN noise tokens that would
// otherwise dominate the topic-frequency map ("add", "fix", "the", "und"…).
const STOPWORDS = new Set([
  // EN
  "the", "a", "an", "and", "or", "but", "if", "then", "for", "to", "of", "in",
  "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be",
  "this", "that", "these", "those", "it", "its", "we", "i", "you", "they",
  "add", "fix", "update", "make", "do", "use", "run", "set", "get", "new",
  "all", "any", "into", "via", "out", "up", "down", "also",
  // DE
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem",
  "und", "oder", "aber", "wenn", "dann", "für", "fur", "zu", "von", "in",
  "an", "auf", "mit", "bei", "aus", "als", "ist", "sind", "war", "waren",
  "im", "am", "zur", "zum", "auch", "noch", "nicht", "kein", "keine",
  "neu", "neue", "alle", "alles",
]);

export interface TopicExtraction {
  query: string;
  topics: string[];
  todoCount: number;
}

/**
 * Pull a topic-rich query out of a TodoWrite payload. Strategy:
 * 1. Use the first 1–2 `content` strings verbatim as the spine of the query.
 * 2. Tokenize ALL todo contents to a-z/0-9 words (length >= 3, no stopwords).
 * 3. Pick the top words that appear in >= 2 todos as `topics`.
 * 4. Final query = "<topics joined>  <first 2 todos joined>".
 */
export function extractTopicsFromTodos(todosRaw: unknown): TopicExtraction {
  if (!Array.isArray(todosRaw)) {
    return { query: "", topics: [], todoCount: 0 };
  }
  const todos: TodoItem[] = todosRaw.filter(
    (t): t is TodoItem => typeof t === "object" && t !== null,
  );
  const contents: string[] = todos
    .map((t) => (typeof t.content === "string" ? t.content : ""))
    .filter((c) => c.length > 0);

  if (contents.length === 0) {
    return { query: "", topics: [], todoCount: todos.length };
  }

  // Per-todo unique word sets — count "appears in >= N todos", not raw freq,
  // so a single chatty todo can't dominate the topic list.
  const perTodoWords: Set<string>[] = contents.map((c) => {
    const words = c
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s-]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    return new Set(words);
  });

  const docFreq = new Map<string, number>();
  for (const set of perTodoWords) {
    for (const w of set) {
      docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
    }
  }

  const topics = [...docFreq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOPIC_WORD_CAP)
    .map(([w]) => w);

  const firstTwo = contents.slice(0, 2).join("  ");
  const queryParts: string[] = [];
  if (topics.length > 0) queryParts.push(topics.join(" "));
  queryParts.push(firstTwo);
  const query = queryParts.join("  ").trim();

  return { query, topics, todoCount: todos.length };
}

/** Min-confidence gate — reject extractions that are too thin to be useful. */
export function isLowConfidence(extraction: TopicExtraction): boolean {
  if (extraction.todoCount === 0) return true;
  if (extraction.query.length === 0) return true;
  if (extraction.topics.length < 2 && extraction.query.length < MIN_QUERY_LEN_WITHOUT_TOPICS) {
    return true;
  }
  return false;
}

/**
 * Run the TodoWrite pipeline and return the exact JSON string the thin client
 * writes to stdout. Never throws; every failure degrades to `{}` plus
 * telemetry, matching the CLI's fail-open contract.
 */
export async function runTodoLane(
  payload: ClaudeHookPayload,
  selfBaseUrl: string,
): Promise<string> {
  const startedAt = Date.now();
  const client = hookClient(payload);

  if (payload.hook_event_name !== "PreToolUse") return "{}";
  if (payload.tool_name !== "TodoWrite" && payload.tool_name !== "update_plan") return "{}";

  const planItems = payload.tool_name === "update_plan" && Array.isArray(payload.tool_input?.plan)
    ? payload.tool_input.plan.map((item) => {
        if (!item || typeof item !== "object") return item;
        const step = (item as Record<string, unknown>).step;
        return { ...(item as Record<string, unknown>), content: step };
      })
    : payload.tool_input?.todos;
  const extraction = extractTopicsFromTodos(planItems);
  if (isLowConfidence(extraction)) {
    await writeTelemetry({
      session_id: payload.session_id ?? null,
      topic: extraction.topics.join(",") || null,
      todo_count: extraction.todoCount,
      query_chars: extraction.query.length,
      daemon_url: null,
      // #352: null = never asked (gate branch, no POST)
      daemon_reachable: null,
      hit_count: 0,
      top_score: null,
      latency_ms_total: Date.now() - startedAt,
      status: "low-confidence",
      error: null,
    });
    return "{}";
  }

  const cwd = payload.cwd ?? process.cwd();
  const project = detectProject(cwd);
  // §20.5: geratenes Projekt filtert nicht — siehe projectForFilter.
  const filterProject = projectForFilter(cwd);
  // The self-call target is passed in by the route (this server's own
  // address), not read from the environment: the lane IS the daemon.
  const url = selfBaseUrl;
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" | "low-confidence" =
    "ok";
  let errMsg: string | null = null;
  try {
    resp = await postRecall(
      url,
      {
        query: extraction.query,
        topics: extraction.topics,
        project,
        tool_name: payload.tool_name,
        k: 5,
        type: "project-fact",
        // #445: die drei Identitätsfelder, die diese Lane als einzige gar
        // nicht sendete. Ohne sie ist ihr Ereignis weder nach Quelle noch
        // nach Session gruppierbar.
        session_id: payload.session_id ?? null,
        client,
        hook_source: "todo",
      },
      remainingMs,
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
      status = "daemon-unreachable";
    } else if (e.message === "timeout") {
      status = "timeout";
    } else {
      status = "error";
      errMsg = e.message ?? String(err);
    }
  }

  const aboveFloor: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (h.score < SCORE_FLOOR) continue;
      aboveFloor.push(h);
    }
  }
  // §20.5: Diese Lane filterte nie nach Projekt-Scope. Sie fragt ausdrücklich
  // nach `type: project-fact` für den AKTUELLEN Arbeitsplan — ein fremder
  // Projekt-Fakt ist hier fast immer Kontamination, nicht Kontext. Deshalb
  // ohne Cross-Scope-Ausnahme, anders als in der Prompt-Lane. Läuft zuerst im
  // SHADOW-Modus: misst, verwirft nichts (BASTRA_SCOPE_FILTER_LANES=enforce).
  const scopeFilter = applyLaneScopeFilter(
    aboveFloor,
    filterProject,
    {
      allowAnchoredCrossScope: false,
      mustLoadScore: MUST_LOAD_SCORE,
      unfused: resp?.unfused === true,
      exemptReflex: true,
      projectKnown: resp?.project_known,
    },
  );
  const filtered = scopeFilter.hits;
  if (resp && filtered.length === 0) status = "no-hits";

  let backoffStreak = 0;
  let suppressed = false;
  let suppressedTokensEst = 0;
  let out = "{}";
  if (filtered.length === 0) {
    // stays "{}"
  } else {
    // #161 empty-streak backoff (see session-state.ts): unconsumed injection
    // streaks widen the cadence; any load of an emitted candidate resets.
    // REQUIRED-band hits (score >= MUST_LOAD_SCORE) bypass suppression.
    const sessionId = payload.session_id ?? "";
    const state = await loadSessionState(sessionId);
    const entry = state.sources?.[BACKOFF_SOURCE];
    const consumed = await wasEmitConsumed(entry);
    // Auf der unfused Skala ist `>= MUST_LOAD_SCORE` keine Aussage — ein
    // Bypass daraus hieße: Der Backoff hört genau dann auf zu greifen, wenn
    // der Recall am wenigsten weiß. Wortgleich zu prompt-lane.ts.
    const unfused = resp?.unfused === true;
    const hasRequired = !unfused && filtered.some((h) => h.score >= MUST_LOAD_SCORE);
    const decision = decideBackoff(entry, consumed, hasRequired);
    backoffStreak = decision.streak;
    suppressed = decision.suppress;
    const block = formatHintBlock(filtered, project, extraction.topics, unfused, client, payload.tool_name);
    if (suppressed) {
      // Suppressed emits {} exactly like the empty path (#161).
      suppressedTokensEst = Math.ceil(block.length / 4);
      recordSourceSuppressed(state, BACKOFF_SOURCE);
      await saveSessionState(sessionId, state);
    } else {
      out = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: block,
        },
      });
      recordSourceEmit(state, BACKOFF_SOURCE, filtered.map((h) => h.id), consumed);
      await saveSessionState(sessionId, state);
      // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
      await reportHinted(url, filtered.map((h) => h.id));
    }
  }

  await writeTelemetry({
    session_id: payload.session_id ?? null,
    topic: extraction.topics.join(",") || null,
    todo_count: extraction.todoCount,
    query_chars: extraction.query.length,
    daemon_url: url,
    daemon_reachable: resp !== null,
    hit_count: suppressed ? 0 : filtered.length,
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: Date.now() - startedAt,
    backoff_streak: backoffStreak,
    suppressed,
    suppressed_tokens_est: suppressedTokensEst,
    status: suppressed ? "suppressed" : status,
    error: errMsg,
    scope_filter_mode: scopeFilter.mode,
    dropped_scope_count: scopeFilter.droppedCount,
    project_confidence: projectConfidence(cwd),
    filter_project: scopeFilter.filterProject,
    ...(scopeFilter.skipped ? { scope_filter_skipped: scopeFilter.skipped } : {}),
    ...(scopeFilter.droppedScopes.length > 0
      ? { dropped_scopes: scopeFilter.droppedScopes }
      : {}),
    ...(resp?.unfused === true ? { unfused: true } : {}),
  });
  return out;
}

function formatHintLine(h: RecallHit, hideScore = false): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  // Auf der unfused Skala ist die Zahl weder mit den Bändern noch zwischen
  // zwei Aufrufen vergleichbar — sie wegzulassen ist ehrlicher, als eine
  // Größenordnung zu zeigen, die zum Vergleichen einlädt.
  return hideScore
    ? `- ${h.id} (${h.type}): ${summary}`
    : `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}`;
}

export function formatHintBlock(
  hits: RecallHit[],
  project: string | null,
  topics: string[],
  unfused = false,
  surface = "claude-code",
  toolName = "TodoWrite",
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const topicsAttr = topics.length > 0 ? ` topics="${escapeAttr(topics.join(","))}"` : "";
  const head = `<recall-hints surface="${escapeAttr(surface)}" trigger="todo-plan"${projAttr}${topicsAttr}>`;
  const tail = `</recall-hints>`;

  // Ohne Fusion gibt es keine Bänder: die Werte stammen aus einer offenen
  // Skala, auf der die 100 kein Signal ist. Dann wird nicht gebandet, sondern
  // gesagt, woran das Modell die Treffer stattdessen misst — Titel und Summary.
  const required = unfused ? [] : hits.filter((h) => h.score >= MUST_LOAD_SCORE);
  const optional = unfused ? [] : hits.filter((h) => h.score < MUST_LOAD_SCORE);
  const sections: string[] = [];

  sections.push(
    `You just produced a multi-step plan via ${toolName}. ` +
      `Before starting these todos, load the project-facts above to understand ` +
      `the current file layout / past decisions in this area. ` +
      `load_memory(id) the hits relevant to these todos; treat the rest as candidates (hints, not obligations).`,
  );

  if (unfused) {
    sections.push("");
    sections.push(unfusedHeadline("these todos"));
    sections.push("");
    for (const h of hits) sections.push(formatHintLine(h, true));
  }

  if (required.length > 0) {
    sections.push("");
    sections.push(
      `${requiredHeadline("these todos", MUST_LOAD_SCORE, { k: RRF_K, scale: RRF_SCALE })} ` +
        `load_memory(id) the ones relevant to them (hints, not obligations):`,
    );
    for (const h of required) sections.push(formatHintLine(h));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      `OPTIONAL (score ${SCORE_FLOOR}–${MUST_LOAD_SCORE - 1}) — load only if title/summary maps to a concrete todo:`,
    );
    for (const h of optional) sections.push(formatHintLine(h));
  }

  return [head, HINT_FRAME_NOTE, stripFenceMarkers(sections.join("\n")), tail].join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface RecallRequestBody {
  query: string;
  topics: string[];
  project: string | null;
  tool_name: string;
  k: number;
  scope?: string;
  type?: string;
  /** #445: die Identitätsfelder aus #263. Sie fehlten in diesem Typ, und das
   *  ist der Grund, warum die Lane sie nie mitschickte — der Empfänger liest
   *  sie aus genau diesem Body. */
  session_id: string | null;
  client: string;
  hook_source: string;
}

function postRecall(
  baseUrl: string,
  body: RecallRequestBody,
  timeoutMs: number,
): Promise<RecallResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL("/hook/recall", baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.byteLength.toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as RecallResponse);
          } catch {
            reject(new Error("invalid JSON response from daemon"));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

interface TodoHookTelemetry {
  /** #356: the Claude Code session this call belongs to — the payload's
   *  session_id, so per-session aggregation is possible. A synthetic UUID is
   *  the fallback only when the payload carried none. */
  session_id?: string | null;
  topic: string | null;
  todo_count: number;
  query_chars: number;
  daemon_url: string | null;
  /** #352: true/false = asked the daemon (and it answered / did not);
   *  null = never asked (gate branch). */
  daemon_reachable: boolean | null;
  hit_count: number;
  top_score: number | null;
  latency_ms_total: number;
  /** #161: resolved streak of this event's backoff decision. */
  backoff_streak?: number;
  /** Der Recall lief ohne Vektor-Arm — die Scores sind roh und nicht mit den
   *  Bändern vergleichbar. Ohne dieses Feld ist `top_score` in der Auswertung
   *  eine Zahl ohne Skala. */
  unfused?: boolean;
  /**
   * §20.5 Shadow-Messung, gleiche Felder wie in der Prompt-Lane, damit sich
   * beide Lanes in einer Auswertung vergleichen lassen: der harte Filter hier
   * gegen den anker-tolerierenden dort.
   */
  scope_filter_mode?: ScopeFilterMode;
  dropped_scope_count?: number;
  dropped_scopes?: string[];
  /** §20.5, siehe Prompt-Lane. */
  project_confidence?: "git-root" | "root-match" | "fallback" | "none";
  /** Der Name, gegen den verglichen wurde — null heißt: nicht gefiltert. */
  filter_project?: string | null;
  scope_filter_skipped?: "no-project" | "no-scope-evidence";
  /** #161: true when the empty-streak backoff suppressed the injection. */
  suppressed?: boolean;
  /** #161: est. tokens of the NOT-injected block — the savings side of ROI. */
  suppressed_tokens_est?: number;
  status:
    | "ok"
    | "no-hits"
    | "daemon-unreachable"
    | "timeout"
    | "error"
    | "low-confidence"
    | "suppressed";
  error: string | null;
}

async function writeTelemetry(payload: TodoHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // The session_id from the Claude payload is real session state — fall
    // back to a synthetic UUID only if no payload session was given (#356).
    const { session_id: payloadSessionId, ...rest } = payload;
    const event = {
      kind: "todo_hook_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}
