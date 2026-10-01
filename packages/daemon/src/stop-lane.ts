/**
 * Stop lane, daemon-side (#369/#15 — the #343/#344 pattern, applied to the lane
 * that fires at the end of EVERY answer).
 *
 * The save-evaluation this file describes ran in the hook process until #369:
 * ~75ms of node interpreter start, 94-108x/day, at the one moment the user is
 * waiting for the turn to be over. The pipeline moved here verbatim behind
 * POST /hook/stop; `stop-hook.ts` is a thin client now.
 *
 * Looks at the recent transcript and surfaces save-suggestions when one of
 * three heuristics fires. Never calls save_memory itself — only suggests
 * (the agent decides in the next turn whether to act).
 *
 * Heuristics:
 *   1. Frustration-Density   — >=4 cues AND >=2 explicit frustration words
 *      (German, English and Russian cue lists, #476) in the last 10 user
 *      turns. The bare word for "again" is no cue, only its frustration
 *      constructions are (#756). CAPS words count as cues only when they are >=5 chars or
 *      repeated in a turn AND not a technical acronym (SKILL/JSON/…); CAPS
 *      alone never triggers. Case and word boundaries are Unicode-aware, so
 *      Cyrillic counts the same way Latin does. Languages without a cue list
 *      (#678): >=2 user turns restating an earlier one, one of them with
 *      emphasis (`!` or CAPS) — see stop-lane-repeat.ts.
 *   2. Feature-Completion    — a commit signal + >=5 distinct repo-relative
 *      source-file tokens, at least one of which exists under the session
 *      cwd. Three things count as the signal, whoever typed the commit:
 *      `git commit` in a USER turn, `git commit` in a shell command the
 *      agent ran (Claude tool_use / Codex function_call or custom_tool_call), or git's own
 *      "[branch sha] subject" line in a TOOL turn. Until 05.09.2026 only the
 *      first counted — for every user whose agent commits, the heuristic
 *      could structurally never fire (the #476 pattern, scope-bound instead
 *      of language-bound).
 *   3. Architecture-Decision — a decision cue from the German, English or
 *      Russian list in the last 5 user turns. Languages without a cue list
 *      (#707): the user picks one of the numbered options the agent offered
 *      with a question — see stop-lane-choice.ts. An answer given through
 *      Claude Code's AskUserQuestion tool counts the same way (#701).
 *
 * Output: `{}`, or — #662 — a `hookSpecificOutput.additionalContext` document
 * that hands a Claude Code session its save suggestions in the running turn
 * (once per heuristic per session), with a one-line `systemMessage` that
 * tells the user what it is (#757). Codex and payloads without a session id
 * keep the #48 route: suggestions go to the pending file, which the next
 * SessionStart injects silently. The client writes the daemon's answer
 * verbatim like every other lane.
 *
 * Discipline:
 *   - Budget 1000 ms. Any failure path returns `{}`.
 *   - Never blocks the workflow.
 *   - Telemetry best-effort.
 *
 * The transcript is read HERE now, from the path the payload names — same
 * untrusted-input handling as before (extension check, size cap, fstat on the
 * open handle), just in the daemon process. Nothing else about the read
 * changed: the daemon runs as the same user as the hook did.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { writePendingSuggestion } from "./pending-suggestions.js";
import { hookClientEvidence } from "./hook-surface.js";
import { getDocsMode, getPrimaryLanguage } from "./settings.js";
import { enqueueForPath } from "./code-graph/service.js";
import { boundaryNote } from "./code-graph/boundary-block.js";
import { getPromptImpactEnabled } from "./code-graph/prompt-impact-settings.js";
import { loadSessionState, mutateSessionState, parkBoundary } from "./session-state.js";
import { noteSessionForHarvest } from "./session-harvest.js";
import { emptyTranscriptReason, loadTranscript, type ClaudeStopPayload, type TranscriptTurn } from "./stop-transcript.js";
import { appendProductDocHint, evaluateHeuristics, formatSuggestion, type SaveSuggestion } from "./stop-heuristics.js";
import { formatSameTurnBlock, sameTurnNotice } from "./stop-lane-same-turn.js";

// 0.1.0 = unchanged event contract; the lane moved, the shape did not (#369).
const HOOK_VERSION = "0.1.0";

/**
 * Run the save-evaluation and return the exact JSON string the thin client
 * writes to stdout — always `{}` (#48). Never throws; every failure path
 * degrades to `{}`, matching the CLI's fail-open contract.
 */
export async function runStopLane(
  payload: ClaudeStopPayload,
  selfBaseUrl: string,
): Promise<string> {
  const startedAt = Date.now();

  // #675: SessionEnd rides the Stop client (same binary, same route). It only
  // books the session as finished for the after-session harvest — no
  // transcript work here: Claude Code gives all SessionEnd hooks 1.5 s
  // together, and the harvest job reads the transcript on its own schedule.
  if (payload.hook_event_name === "SessionEnd") {
    await noteSessionForHarvest({
      session_id: payload.session_id,
      transcript_path: payload.transcript_path,
      cwd: payload.cwd,
      client: hookClientEvidence(payload),
      ended: true,
    });
    return "{}";
  }
  if (payload.hook_event_name !== "Stop") return "{}";
  if (payload.stop_hook_active === true) return "{}";

  // Code awareness (#581): the end of a turn is a good moment to refresh the
  // graph, so the next turn starts from a current one.
  //
  // ENQUEUE ONLY. The build takes seconds; this hook fires at the moment the
  // user is waiting for the turn to be over, and #369 moved work OUT of this
  // path for exactly that reason. `enqueueForPath` returns immediately and the
  // refresher runs the build on its own, so there is no way for a build to end
  // up awaited here even by accident. A repository that is not enabled is a
  // silent no-op.
  //
  // #572: the task-boundary block is parked first. It is a sum of what the
  // Write/Edit lane booked at edit time; the graph is only consulted for edits
  // that lane could not look at, and those are better asked before the refresh
  // this Stop is about to enqueue than after it.
  //
  // The transcript is read once for both consumers — but a read that THROWS
  // (a poisoned inline entry, #48) must still reach `evaluateStop`'s own catch
  // and its telemetry row, exactly as before. So a throw here is swallowed,
  // the boundary goes without reads (wider, never narrower), and
  // `evaluateStop` repeats the read inside its try.
  let turns: TranscriptTurn[] | null = null;
  try {
    turns = await loadTranscript(payload);
  } catch {
    turns = null;
  }
  await parkBoundaryNote(payload, turns ?? []).catch(() => {});
  // #675: book the session for the after-session harvest (a daemon job reads
  // the transcript once the session has gone quiet — nothing of it runs here).
  await noteSessionForHarvest({
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    client: hookClientEvidence(payload),
  });
  if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
    void enqueueForPath(payload.cwd).catch(() => {});
  }

  // Fail-open backstop for the "Never throws" contract. No known input reaches
  // this catch today — loadTranscript swallows its own IO errors and cues are
  // validated in lexicon.ts — but per-cue validation cannot see a join-time
  // RegExp compile error, and a future detector may throw. A broken Stop
  // evaluation must degrade to `{}`, never take the hook down.
  try {
    return await evaluateStop(payload, selfBaseUrl, startedAt, turns);
  } catch (err) {
    try {
      await writeTelemetry({
        session_id: payload.session_id ?? null,
        heuristic: null,
        suggested_count: 0,
        drift_clusters: 0,
        drift_keys: [],
        turn_count: 0,
        latency_ms_total: Date.now() - startedAt,
        // A RegExp compile error quotes the whole joined pattern (up to the
        // 64 KiB cue file) — keep the telemetry line bounded.
        error: String((err as { message?: unknown })?.message ?? err).slice(0, 200),
      });
    } catch {
      /* telemetry must never break the hook */
    }
    return "{}";
  }
}

/**
 * #572: compute the task-boundary block and park it in the session's own
 * state; the prompt lane delivers it on this session's next turn
 * (`boundary-block.ts` says why not the pending file). A Stop that finds
 * nothing CLEARS the slot — the agent may have opened the missed files since
 * the last Stop, and a parked block must not outlive the fact it states.
 *
 * #607: gated behind the same `promptImpact.enabled` opt-in the delivery side
 * already needs, default OFF. Computing the block means a `stat` per booked
 * file (up to `MAX_TOUCHED_FILES`) and a session-state write on EVERY Stop —
 * work with no reader while the prompt lane never takes it off the parking
 * spot. The booking itself (`write-lane.ts`'s `recordTouched`) stays
 * ungated on purpose: it is what lets a switch flipped ON mid-session still
 * find something to park at the next Stop.
 */
async function parkBoundaryNote(payload: ClaudeStopPayload, turns: TranscriptTurn[]): Promise<void> {
  if (!(await getPromptImpactEnabled())) return;
  const sessionId = payload.session_id ?? "";
  if (!sessionId) return;
  const builtFrom = Date.now();
  const session = await loadSessionState(sessionId);
  if (session.touched === undefined) return;

  // Only a read the transcript PROVES counts. Claude's Read tool
  // names its file; a Codex `sed -n` inside a shell string does not, and
  // guessing paths out of shell text would mark files opened that never were —
  // the narrow direction. Without proof the answer simply stays wider.
  const reads = turns.flatMap((t) => t.reads ?? []);
  const built = await boundaryNote({ session, reads });
  if (built === null && session.boundary === undefined) return;
  await mutateSessionState(sessionId, (s) =>
    parkBoundary(
      s,
      built === null ? null : { note: built.note, dedupeKey: built.dedupeKey, files: built.files },
      builtFrom,
    ),
  );
}

async function evaluateStop(
  payload: ClaudeStopPayload,
  selfBaseUrl: string,
  startedAt: number,
  loaded: TranscriptTurn[] | null,
): Promise<string> {
  const turns = loaded ?? (await loadTranscript(payload));
  if (turns.length === 0) {
    // loadTranscript's catch collapses "nothing to read" and "could not
    // read the transcript on THIS host" into the same []. Silently returning
    // here (the old behaviour) left no telemetry row at all, so the gate
    // could not tell "genuinely nothing to suggest" from "never really ran" —
    // exactly the shape a remote-daemon topology hits on every session whose
    // transcript path is local to the CLIENT host. A row is written either
    // way now, with `error` naming the reason when a transcript existed but
    // could not be read.
    const reason = await emptyTranscriptReason(payload);
    await writeTelemetry({
      session_id: payload.session_id ?? null,
      heuristic: null,
      suggested_count: 0,
      drift_clusters: 0,
      drift_keys: [],
      turn_count: 0,
      latency_ms_total: Date.now() - startedAt,
      ...(reason ? { error: reason } : {}),
    });
    return "{}";
  }

  const last30 = turns.slice(-30);
  const suggestions = evaluateHeuristics(last30, { cwd: payload.cwd });

  // Produkt-Doku (docs.mode): feature-completion ist auch der Trigger für
  // die Doku-Pflege — Hinweis an die Suggestion hängen, wenn eingeschaltet.
  // Settings-Read ist lokal; Fehler → kein Hint, Hook läuft weiter.
  try {
    appendProductDocHint(suggestions, await getDocsMode());
  } catch {
    /* best-effort */
  }

  // Drift-Detektor (#67): unabhängig vom Transcript — der Daemon prüft, ob
  // jüngste Memories ein wiederkehrendes Cluster ohne Taxonomie-Konvention
  // bilden. Best-effort mit hartem Budget; Daemon weg → still.
  const drift = await fetchDrift(selfBaseUrl, 250);

  let stdout = "{}";
  let delivery: SaveEvalDelivery | null = null;
  if (suggestions.length > 0 || drift.length > 0) {
    // #48 Redesign: Stop-Hooks haben keinen stillen Output-Kanal — das
    // einzige sichtbare Feld (systemMessage) rendert Claude Code 1:1 in den
    // Chat (die „Zeichenflut", die den Hook deaktiviert hat). Stattdessen:
    // Vorschläge in die Pending-Datei schreiben; der SessionStart-Hook der
    // nächsten Session injiziert sie still als additionalContext. stdout
    // bleibt IMMER leer.
    // #513: was diese Session ausgelöst hat, ist heiß (recency, einmal
    // zeigen). Der Taxonomie-Drift beschreibt dagegen, was im Vault immer
    // wieder auftaucht — er gehört in die Trends-Spur, unter einem festen
    // Schlüssel, damit neue Zählungen die Zeile ersetzen statt sie zu stapeln.
    //
    // #662: Claude Code's Stop takes `hookSpecificOutput.additionalContext` —
    // non-error feedback Claude reads IN THIS TURN. Claude Code prints it to
    // the user in full as "Stop hook feedback" (#757, measured on 2.1.286;
    // `suppressOutput` changes nothing), so the block is kept minimal and a
    // one-line `systemMessage` in the user's language says what it is.
    // The next session has neither the conversation nor the body, so a
    // suggestion relayed there cannot be acted on. A Claude Code session with
    // an id therefore gets its suggestions here, once per heuristic per
    // session (the windows re-fire on every Stop, and each delivery extends
    // the turn). Codex, a payload without a session id, or the off switch keep
    // the pending relay.
    if (suggestions.length > 0) {
      const sameTurn = await takeSameTurnSuggestions(payload, suggestions);
      if (sameTurn === null) {
        await writePendingSuggestion(suggestions.map(formatSuggestion).join("\n"));
        delivery = "pending";
      } else if (sameTurn.length > 0) {
        stdout = JSON.stringify({
          systemMessage: sameTurnNotice(await getPrimaryLanguage().catch(() => undefined)),
          hookSpecificOutput: { hookEventName: "Stop", additionalContext: formatSameTurnBlock(sameTurn) },
        });
        delivery = "same-turn";
      } else {
        delivery = "already-delivered";
      }
    }
    if (drift.length > 0) {
      await writePendingSuggestion(formatDriftBlock(drift), { lane: "trends", key: "taxonomy-drift" });
    }
  }

  const totalMs = Date.now() - startedAt;
  await writeTelemetry({
    session_id: payload.session_id ?? null,
    heuristic: suggestions.map((s) => s.heuristic).join(",") || null,
    suggested_count: suggestions.length,
    drift_clusters: drift.length,
    drift_keys: drift.map((c) => `${c.key}:${c.count}`),
    turn_count: turns.length,
    latency_ms_total: totalMs,
    ...(delivery ? { delivery } : {}),
  });
  return stdout;
}

/** #662: where this Stop's save suggestions went. */
type SaveEvalDelivery = "same-turn" | "pending" | "already-delivered";

/**
 * #662: the suggestions this Stop may hand to the running Claude Code turn, or
 * `null` when the same-turn path does not apply (Codex, no session id,
 * `BASTRA_STOP_SAME_TURN=0`) and the pending relay takes them. Heuristics
 * already delivered to this session are filtered out and the rest are booked
 * as delivered in the session state before they are returned.
 */
async function takeSameTurnSuggestions(
  payload: ClaudeStopPayload,
  suggestions: SaveSuggestion[],
): Promise<SaveSuggestion[] | null> {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return null;
  if (hookClientEvidence(payload) === "codex") return null;
  if ((process.env.BASTRA_STOP_SAME_TURN ?? "").trim() === "0") return null;
  let fresh: SaveSuggestion[] = [];
  await mutateSessionState(sessionId, (s) => {
    const done = new Set(s.saveEvalDelivered ?? []);
    fresh = suggestions.filter((x) => !done.has(x.heuristic));
    for (const x of fresh) done.add(x.heuristic);
    s.saveEvalDelivered = [...done];
  });
  return fresh;
}

// ─── Taxonomie-Drift (#67) ───────────────────────────────────────

interface DriftCluster {
  key: string;
  kind: "tag" | "topic";
  count: number;
  examples: string[];
}

/**
 * Drift-Hinweis für den Agent. Suggestion-only — der Agent entscheidet im
 * nächsten Turn, ob er eine Konvention etabliert; geschrieben wird hier nie.
 */
function formatDriftBlock(clusters: DriftCluster[]): string {
  const lines = clusters.map(
    (c) =>
      `- ${c.count} recent memories share the ${c.kind} '${c.key}' with no ` +
      `taxonomy convention covering it (e.g. ${c.examples.join(", ")}).`,
  );
  return (
    `<taxonomy-drift>\n` +
    `The vault is forming ad-hoc clusters without a home:\n` +
    lines.join("\n") +
    `\nIf a cluster is here to stay, establish a convention next turn: ` +
    `save_memory with scope='taxonomy', tag 'convention', body = the rule ` +
    `(folder, topic_path shape, tags, body shape, one example) — then re-file ` +
    `the members (overwrite=true + the convention's folder). ` +
    `Put every key the convention covers into its tags — the detector reads ` +
    `tags, topic_path and title, never the body. ` +
    `Suggestion only: weigh it, ask the user if unsure, never bulk-move silently.\n` +
    `</taxonomy-drift>`
  );
}

/** Loopback self-call to this same server (~1-3ms), like every other lane's
 *  daemon call — the base URL is passed in by the route, not read from the
 *  environment. */
function fetchDrift(baseUrl: string, timeoutMs: number): Promise<DriftCluster[]> {
  return new Promise((resolve_) => {
    let url: URL;
    try {
      url = new URL("/hook/drift", baseUrl);
    } catch {
      resolve_([]);
      return;
    }
    const req = request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              clusters?: DriftCluster[];
            };
            if ((res.statusCode ?? 500) === 200 && Array.isArray(data.clusters)) {
              resolve_(data.clusters);
              return;
            }
          } catch { /* fallthrough */ }
          resolve_([]);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve_([]);
    });
    req.on("error", () => resolve_([]));
    req.end();
  });
}

interface StopHookTelemetry {
  /** #356: the Claude Code session this Stop belongs to — the payload's
   *  session_id, so per-session aggregation is possible. A synthetic UUID
   *  is the fallback only when the payload carried none. */
  session_id?: string | null;
  heuristic: string | null;
  suggested_count: number;
  drift_clusters: number;
  /** "<key>:<count>" per flagged cluster — lets the threshold be judged from the log. */
  drift_keys: string[];
  turn_count: number;
  latency_ms_total: number;
  /** #662: where the suggestions went — absent when there were none. */
  delivery?: SaveEvalDelivery;
  /** Set only on the fail-open backstop path: the error that made the Stop
   *  evaluation degrade to `{}`. Absent on every normal event. */
  error?: string;
}

async function writeTelemetry(payload: StopHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // #356: the payload's session_id is real session state — synthetic UUID
    // only when the payload carried none.
    const { session_id: payloadSessionId, ...rest } = payload;
    const event = {
      kind: "save_eval_call",
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

// #680: transcript reading and the save heuristics live in their own modules;
// the lane's public surface is re-exported unchanged.
export {
  evaluateHeuristics,
  detectFrustration,
  detectFeatureCompletion,
  detectArchitectureDecision,
  appendProductDocHint,
  formatSuggestion,
} from "./stop-heuristics.js";
export { parseTranscriptFile, normalizeTurns, loadTranscript } from "./stop-transcript.js";
export type { ClaudeStopPayload, TranscriptTurn } from "./stop-transcript.js";
export type { SaveSuggestion } from "./stop-heuristics.js";
