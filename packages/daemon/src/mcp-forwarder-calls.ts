/**
 * Forwarder → daemon tool calls — split out of mcp-forwarder.ts (file-size
 * convention, #680): the plain `/api/v1/<tool>` POST, the streaming recall
 * against `/hook/recall` (SSE), and the one-shot session-context inject for
 * hookless clients.
 */
import { type RecallStage } from "@bastra-recall/core";
import { mergeBatchResults, projectRecallResult } from "./recall-batch.js";
import { withDraftBudget } from "./draft-search.js";
import { fitRecallWithReflexToBudget } from "./recall-budget.js";
import { projectForFilter } from "./scope-filter.js";
import { envInt, envOff } from "./env.js";
import {
  DAEMON_URL,
  API_TOKEN,
  REQUEST_TIMEOUT_MS,
  FORWARDER_HOOK_BUDGET_MS,
  fetchWithTimeout,
} from "./forwarder-daemon-client.js";
import { liveStatusline } from "./mcp-forwarder-statusline.js";

function ccTurnHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (typeof liveStatusline.cc_session_id === "string" && liveStatusline.cc_session_id) {
    h["x-bastra-cc-session"] = liveStatusline.cc_session_id;
    if (liveStatusline.turn_id > 0) h["x-bastra-cc-turn"] = String(liveStatusline.turn_id);
  }
  return h;
}

export async function callDaemon(tool: string, args: unknown): Promise<unknown> {
  const url = `${DAEMON_URL}/api/v1/${tool}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...ccTurnHeaders(),
  };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const doFetch = async (): Promise<Response> => {
    return await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(args ?? {}),
      },
      REQUEST_TIMEOUT_MS,
    );
  };

  let resp: Response;
  try {
    resp = await doFetch();
  } catch (err) {
    // Netzwerk-Fehler: einmaliger Retry — vielleicht ist der Daemon gerade
    // restartet. Beim zweiten Fehler durchreichen.
    await new Promise((r) => setTimeout(r, 300));
    try {
      resp = await doFetch();
    } catch (err2) {
      throw new Error(
        `daemon unreachable at ${DAEMON_URL}: ${(err2 as Error).message}`,
      );
    }
  }

  const text = await resp.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`invalid JSON response from daemon: ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const errMsg =
      (body as { error?: string })?.error ?? `HTTP ${resp.status}`;
    throw new Error(errMsg);
  }
  return body;
}

/**
 * Session-context inject for hookless clients (Claude Desktop, Cursor): the
 * forwarder process lives exactly one client session, so the FIRST tool call
 * of this process ≈ session start — its result gets the same context block
 * the SessionStart hook injects in Claude Code (pinned memories, durable
 * user hints, conventions, open care/import/onboarding state). Claude Code
 * sessions are skipped: the prompt-hook stamps cc_session_id into the
 * statusline feed, which hookless clients never have. 404 = old daemon
 * without the endpoint → give up for this session; transient error → retry
 * on the next call. Opt out with BASTRA_MCP_SESSION_CONTEXT=0.
 */
let sessionContextPending = !envOff("BASTRA_MCP_SESSION_CONTEXT");

export async function maybeSessionContextItem(): Promise<{ type: "text"; text: string } | null> {
  if (!sessionContextPending) return null;
  if (typeof liveStatusline.cc_session_id === "string" && liveStatusline.cc_session_id) {
    sessionContextPending = false; // Claude Code — the SessionStart hook already injected
    return null;
  }
  try {
    const resp = await fetchWithTimeout(`${DAEMON_URL}/hook/session-context`, {}, 1200);
    if (resp.status === 404) {
      sessionContextPending = false;
      return null;
    }
    if (!resp.ok) return null;
    const body = (await resp.json()) as { context?: string };
    sessionContextPending = false;
    return typeof body.context === "string" && body.context ? { type: "text", text: body.context } : null;
  } catch {
    return null;
  }
}

const VALID_STAGE_NAMES: ReadonlySet<RecallStage["name"]> = new Set([
  "query.parse",
  "cache.hit",
  "bm25.search",
  "vector.search",
  "rrf.fuse",
  "hops.expand",
  "staleness.rank",
  "done",
  "error",
]);

/**
 * Streaming recall path. Posts to `/hook/recall` with `Accept:
 * text/event-stream`, parses SSE frames, fires `onStage` for each stage
 * event, returns the final result shaped like `/api/v1/recall` so the
 * client JSON is consistent regardless of which path was taken.
 *
 * Note: this reuses `/hook/recall` — that endpoint is open (no token)
 * and already SSE-capable. The side-effect is that hook_recall telemetry
 * gets logged for MCP recalls too; since #263 the `hook_source: "mcp"`
 * dimension says so as its own column (the `tool_name: "mcp-forwarder"`
 * marker stays for the events written before it existed).
 */
interface HookRecallDonePayload {
  hits: unknown[];
  draft_hits?: import("./draft-search.js").DraftHit[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
  /** Die Ehrlichkeitsfelder des Daemons. Sie standen schon immer im
   *  `done`-Event, fehlten aber hier — und was der Typ nicht kennt, hat die
   *  Projektion unten nicht weitergereicht. Siehe `projectRecallResult`. */
  weak_result?: boolean;
  no_home?: boolean;
  score_kind?: "rrf" | "bm25";
  score_arms?: string[];
  score_version?: string;
  unfused?: boolean;
  degraded?: string;
  vault_missing?: string;
  /** #421: Pool-Reflexe, von `projectRecallResult` durchgereicht. */
  reflex_hits?: Array<{ id: string; score: number } & Record<string, unknown>>;
}

/**
 * #421: Das Projekt dieses MCP-Clients, für den Scope-Filter der gemeinsamen
 * Pipeline. Der Forwarder läuft im cwd des Clients (Claude Code startet ihn im
 * Projektverzeichnis); dasselbe Konfidenz-Gate wie in den Lanes — ein
 * geratenes Projekt (Claude Desktop startet in `/` oder `~`) ist `null`, und
 * dann filtert niemand. Einmal beim Start: das cwd eines stdio-Servers ändert
 * sich nicht.
 */
const CLIENT_FILTER_PROJECT = projectForFilter(process.cwd());

/** Dense-arm deadline for model-triggered recalls (see body.vector_deadline_ms). */
const MCP_VECTOR_DEADLINE_MS = envInt("BASTRA_MCP_VECTOR_DEADLINE_MS", 1500);

export async function callRecallStreaming(
  args: unknown,
  onStage: (s: RecallStage) => void | Promise<void>,
): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  // #351 batch mode: several phrasings, ONE tool round trip. Sub-recalls run
  // in parallel against /hook/recall — each gets its own recall_id/telemetry
  // (the reach-join keys per query); only the first streams stages (the
  // statusline shows one recall either way). Results interleave by BEST
  // original score, so the tool description's score bands stay valid.
  if (Array.isArray(a.queries) && a.queries.length > 0 && a.queries.every((q) => typeof q === "string")) {
    const queries = (a.queries as string[]).slice(0, 4);
    const subs = (await Promise.all(
      queries.map((q, i) =>
        callRecallStreaming(
          // #487: Das Budget gilt für die GEMERGTE Antwort, nicht je
          // Phrasierung — drei Sub-Recalls, jeder für sich im Budget, ergeben
          // zusammen das Dreifache. Es wird unten auf das Ergebnis angewandt.
          { ...a, queries: undefined, max_tokens: undefined, query: q, batch_of: queries.length },
          i === 0 ? onStage : () => undefined,
        ),
      ),
    )) as Parameters<typeof mergeBatchResults>[1];
    const merged = mergeBatchResults(queries, subs, typeof a.k === "number" ? a.k : 5);
    // #421: Die Pool-Reflexe zählen wie auf der Einzelquery ins Budget.
    const { draft_hits: draftHits, ...notesOnly } = merged;
    const budget = typeof a.max_tokens === "number" ? a.max_tokens : 0;
    const payload = fitRecallWithReflexToBudget(
      merged.hits,
      merged.reflex_hits ?? [],
      budget,
      (emitted, emittedReflex, dropped) => ({
        ...notesOnly,
        hits: emitted,
        reflex_hits: emittedReflex.length > 0 ? emittedReflex : undefined,
        ...(dropped > 0 ? { truncated_by_budget: true, dropped_by_budget: dropped } : {}),
      }),
    ).payload;
    return withDraftBudget(payload, draftHits ?? [], budget);
  }
  const body: Record<string, unknown> = {
    query: typeof a.query === "string" ? a.query : "",
    tool_name: "mcp-forwarder",
    // #263: Dieser Aufruf ist KEIN Hook — er kommt über denselben Endpunkt,
    // weil der offen und SSE-fähig ist. `hook_source: "mcp"` sagt das als
    // eigene Spalte, statt es wie bisher am `tool_name`-Marker abzulesen.
    hook_source: "mcp",
    // #74: echte CC-Session an die hook_recall-Telemetrie durchreichen.
    session_id: typeof liveStatusline.cc_session_id === "string" ? liveStatusline.cc_session_id : null,
  };
  // #421: Scope-Filter und Reflex-Hits wie auf dem Hook-Weg. Die Lanes
  // filtern ihre Antwort selbst; der Forwarder hat keine Lane dahinter, also
  // bittet er die Pipeline darum und nennt sein Projekt.
  body.apply_scope_filter = true;
  if (CLIENT_FILTER_PROJECT) body.project = CLIENT_FILTER_PROJECT;
  if (typeof a.k === "number") body.k = a.k;
  // #487: Das Kontextbudget des Modells reicht bis in die Pipeline durch — der
  // Forwarder ist der Weg, den ein MCP-Client wirklich geht.
  if (typeof a.max_tokens === "number") body.max_tokens = a.max_tokens;
  if (typeof a.scope === "string") body.scope = a.scope;
  if (typeof a.type === "string") body.type = a.type;
  // #351: batch width rides along so the hook_recall event can count it.
  if (typeof a.batch_of === "number") body.batch_of = a.batch_of;
  // MCP-Pfad: genau k Hits, keine 1-Hop-Nachbarn (#50). Der /hook/recall-
  // Default ist 1 (gut für die PreToolUse-Hook-CLI), aber für den vom Modell
  // ausgelösten recall verdoppeln die Nachbarn nur den Context. Das Modell
  // kann expand_hops:1 explizit anfordern, wenn es Related-Memories will.
  body.expand_hops = typeof a.expand_hops === "number" ? a.expand_hops : 0;
  // 20.08.: a model is waiting on this call, not a 600ms hook budget — give
  // the dense arm room. At the hook default (150ms) a 3-query batch (#351)
  // serialised on one Ollama and 15 of 19 MCP recalls came back BM25-only.
  body.vector_deadline_ms = MCP_VECTOR_DEADLINE_MS;
  // #493: Die eigene Wanduhr, statt stillschweigend die einer fremden Lane zu
  // erben. Ohne dieses Feld fiel die Route auf `BASTRA_HOOK_BUDGET_MS` zurück
  // — die 200 ms der Prompt-Lane — und die Schattenzeilen der MCP-Lane lasen
  // live `deadline_ms 1500, lane_budget_ms 200, cap_reason floor`: ein
  // gesunder 400-ms-Arm, gemessen an einer Grenze, die für ihn nie galt.
  //
  // Die Zahl selbst steht bei ihrem Ursprung (`FORWARDER_HOOK_BUDGET_MS`).
  body.hook_budget_ms = FORWARDER_HOOK_BUDGET_MS;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...ccTurnHeaders(),
  };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${DAEMON_URL}/hook/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(tid);
    throw new Error(`daemon unreachable at ${DAEMON_URL}: ${(err as Error).message}`);
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(tid);
    throw new Error(`daemon /hook/recall failed: HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let payload: HookRecallDonePayload | null = null;
  let errorMsg: string | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseSseFrame(frame);
        if (!evt) continue;
        if (evt.type === "stage") {
          const d = evt.data as { name?: string; durationMs?: number; meta?: Record<string, unknown> };
          if (!d.name || !VALID_STAGE_NAMES.has(d.name as RecallStage["name"])) continue;
          const stage: RecallStage = {
            name: d.name as RecallStage["name"],
            startedAtMs: Date.now(),
            durationMs: d.durationMs,
            meta: d.meta,
          };
          await onStage(stage);
        } else if (evt.type === "done") {
          payload = evt.data as HookRecallDonePayload;
        } else if (evt.type === "error") {
          errorMsg = (evt.data as { error?: string })?.error ?? "unknown error";
        }
      }
    }
  } finally {
    clearTimeout(tid);
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!payload) throw new Error("daemon /hook/recall ended without done event");

  // No `stages` block in the tool-result (#50): stage events already drove
  // the live progress channel via onStage; the timing map would just bloat
  // the context Claude reads. Debug timings live in /api/v1/recall + telemetry.
  // Alles Übrige — Score-Raum, Armmenge, Formelversion, weak_result/no_home —
  // reicht `projectRecallResult` durch: der Batch-Merge liest genau daraus
  // seine Vergleichbarkeitssignatur, und ohne sie war jeder Batch „gemischt".
  return projectRecallResult(body.query as string, payload);
}

function parseSseFrame(frame: string): { type: string; data: unknown } | null {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event || !data) return null;
  try {
    return { type: event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}
