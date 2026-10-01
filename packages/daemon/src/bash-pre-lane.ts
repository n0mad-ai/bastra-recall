/**
 * Bash tripwire lane, daemon-side (#343/#15 pattern, shared by Claude and Codex).
 *
 * The pipeline from `bash-pre-hook.ts`: pattern-match destructive/risky shell
 * commands, recall safety lessons, emit the STOP/CAUTION tripwire block.
 * Moved verbatim behind POST /hook/bash-pre; the hook file is a thin client.
 *
 * Unlike the write lane there is NO client-side content gate: the pattern
 * tables are the gate, and they are exactly the kind of logic that must stay
 * hot-swappable — a new risky command pattern should never require a stub
 * rebuild (#344's contract). A non-matching command costs the thin client one
 * loopback round trip (~5ms on the compiled stub) and returns `{}` without
 * any recall work.
 *
 * #161 CONSTRAINT carried over: this lane is fully EXEMPT from the
 * empty-streak backoff. The tripwire is a safety warning — the warning itself
 * is the point, and it must emit unconditionally.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { recordBudgetShadow } from "./session-budget.js";
import { reportHinted } from "./hook-hinted.js";
import { hookCaller, hookClient, hookAgent, hookClientEvidence, type HookAgent, type HookClientEvidence } from "./hook-surface.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import { governContext } from "./context-governor.js";
import { postLane } from "./thin-client.js";
import { isUnfused, type HookRecallHit, type HookRecallResponse } from "./hook-recall-response.js";
import { unfusedHeadline, unfusedReasonFor } from "./band-wording.js";
import { extractCommandHead, invokesOwnBinary } from "./bash-fail-lane.js";
import {
  bumpShown,
  getLoadedMarkerMtime,
  loadSessionState,
  mutateSessionState,
  shouldDropHit,
} from "./session-state.js";
import {
  DESTRUCTIVE_PATTERNS,
  RISKY_PATTERNS,
  reversibleDefault,
  type HintKind,
  type Undo,
} from "./bash-pre-patterns.js";
import { hintFor, matchPattern, shimOffLine } from "./bash-pre-analysis.js";
// #680: the command analysis lives in bash-pre-analysis.ts; shimOffLine stays
// part of this lane's public surface.
export { shimOffLine } from "./bash-pre-analysis.js";
import { archiveMaxItem, shimRewrite } from "./rm-archive.js";
import { getArchiveEnabled, getArchiveMaxItem } from "./settings.js";
import { bashVerdict, settingsFiles } from "./cc-permissions.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.2.0"; // 0.2.0 = daemon-side lane (#343)
const SCORE_FLOOR = 50;

export interface BashHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Claude Code's id of this call; PostToolUse carries the same one. */
  tool_use_id?: string;
}

// P0: EIN gemeinsamer Response-Typ für alle Lanes. Die lokale Kopie hier
// kannte `score_kind`/`unfused` nicht — das Feld fiel beim Parsen still weg,
// und diese Lane bandete danach rohe BM25-Werte mit einem Cut, den nur die
// fusionierte Skala trägt.
type RecallHit = HookRecallHit;
type RecallResponse = HookRecallResponse;

/**
 * Run the tripwire pipeline; return the exact stdout document for the thin
 * client. Never throws — every failure degrades to `{}` plus telemetry.
 */
export async function runBashPreLane(payload: BashHookPayload, selfBaseUrl: string): Promise<string> {
  const startedAt = Date.now();
  const client = hookClient(payload);
  // #507 Nachbesserung: nur für die Telemetrie-Dimension — `client` oben bleibt
  // der surface-Default fürs Hint-Block-Attribut und den Recall-Loopback.
  const clientEvidence = hookClientEvidence(payload);
  const agent = hookAgent(payload);

  if (payload.hook_event_name !== "PreToolUse") return "{}";
  if (payload.tool_name !== "Bash") return "{}";

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command.trim()) return "{}";

  // Defensive: never recurse on our own hook binaries — checked on the
  // basename of the invoked program (bash-fail-lane's guard), NOT as a
  // substring. The substring form skipped every command that merely carried
  // the repo name in a path (/Users/…/bastra-recall/…, the session
  // scratchpad): 30 of 35 tripwire matches in one dogfood session went
  // silently unhinted and unlogged.
  if (invokesOwnBinary(command)) return "{}";

  // #650/#657: the archiving rm and the git snapshots are an opt-in, and
  // they rewrite and allow only a call that proves it is Claude Code — an
  // unmarked payload is weighed as "unknown", never as claude-code.
  const match = hintFor(command, clientEvidence, await getArchiveEnabled().catch(() => false));
  if (!match) return "{}";

  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  // The query is the command itself, not a label padded with filler words.
  // `${label} safety workflow user-preference` matched generic meta-working
  // memos via "workflow"/"user-preference" in every call (22.08.2026
  // measurement) — the command head is what a stored rule would name.
  const head = extractCommandHead(command);
  const query = head.startsWith(match.label) ? head : `${match.label} ${head}`.trim();

  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  try {
    resp = JSON.parse(
      await postLane(
        selfBaseUrl,
        "/hook/recall",
        {
          query,
          topics: ["bash", match.severity, "safety"],
          project: null,
          tool_name: "Bash",
          tool_input_excerpt: command.slice(0, 4096),
          scope: "all-projects",
          k: 3,
          // #263: siehe bash-fail-lane — die Lane weist sich aus.
          ...hookCaller(payload),
          hook_source: "bash-pre",
        },
        remainingMs,
      ),
    ) as RecallResponse;
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

  // P0: siehe bash-fail-lane.ts — auf der unfused Skala markiert der Floor
  // keinen Punkt. Die Warnung selbst hängt ohnehin nicht an einem Score.
  const unfused = isUnfused(resp);
  const hits: RecallHit[] = [];
  // #614: only a memory whose own hand-written `recall_when` matched this
  // command with a strong anchor is listed under the warning. After the #358
  // cut, 0 of 118 hinting calls had a hinted id loaded, and the offline check
  // the issue asked for first showed why: the top hinted memories (Discord
  // bot token, avatar corners, UI layout, Hetzner access — 157 hinting calls,
  // 2026-08-22..09-28) are about nothing a destructive shell command does; the
  // command's path tokens matched their titles. A rule someone wired to fire
  // on this kind of command is the one thing worth the tokens here; the
  // static warning above still goes out unconditionally.
  let droppedUnanchoredCount = 0;
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (!unfused && h.score < SCORE_FLOOR) continue;
      if (h.matched_recall_when !== true || h.anchor_strength !== "strong") {
        droppedUnanchoredCount++;
        continue;
      }
      hits.push(h);
    }
  }
  if (resp && hits.length === 0) status = "no-hits";

  // Session dedup, same clock as the write lane (#106 MAX_SHOW inside the
  // 4h window, a load_memory marker resets it): the same memory was hinted
  // 2–9× per session before (22.08.2026 measurement). The backoff exemption
  // (#161) stays — dedup drops repeated memory LINES, never the warning.
  const sessionId = payload.session_id ?? "";
  let droppedDedupCount = 0;
  let emitted: RecallHit[] = hits;
  if (sessionId && hits.length > 0) {
    const state = await loadSessionState(sessionId);
    // #266: Die Entscheidung fällt der Context Governor — die Frage „darf ein
    // bereits gezeigtes Memory erneut erwähnt werden?" ist seine (§16.3). Was
    // „bereits gezeigt" HEISST, bleibt hier: `shouldDropHit` kennt das
    // 4h-Fenster, MAX_SHOW und den Load-Marker, der den Zähler zurücksetzt.
    // Der Governor bekommt das Ergebnis, nicht die Regel.
    //
    // Ohne Budget aufgerufen — das ist der heutige effektive Wert dieser Lane:
    // Es gibt keine Token- und keine Stückgrenze, nur `k` auf der Recall-Seite.
    // Ein Budget hier zu setzen wäre eine Verschärfung und keine
    // Vereinheitlichung; sie gehört in eine Konfigurationsentscheidung mit
    // gemessenen Zahlen (#354), nicht in diesen Umbau.
    const governed = governContext(
      await Promise.all(
        hits.map(async (h, i) => ({
          id: h.id,
          // Die Recall-Liste ist bereits gerankt: Position = Priorität.
          priority: i,
          // Was der Hint kosten würde. Bei fehlendem Budget folgenlos, aber
          // nicht erfunden — die Summary ist der Löwenanteil der Zeile.
          text: h.summary ?? "",
          alreadyShown: shouldDropHit(state.shown[h.id], await getLoadedMarkerMtime(h.id)),
        })),
      ),
      {},
    );
    droppedDedupCount = governed.dropped.filter((d) => d.reason === "already_shown").length;
    const keptIds = new Set(governed.kept.map((g) => g.id));
    const kept = hits.filter((h) => keptIds.has(h.id));
    emitted = kept;
    if (kept.length > 0) {
      const now = Date.now();
      // #539: bump against the state on disk, not against this snapshot —
      // four other lanes write the same file while the recall above runs.
      await mutateSessionState(sessionId, (s) => {
        for (const h of kept) bumpShown(s, h.id, now);
      });
    }
  }

  // Emit hint even if no memories match — the warning itself is the point.
  // #161 CONSTRAINT (see top of file): the tripwire is exempt from backoff.
  const block = formatHintBlock(match.label, match.severity, emitted, unfused, client, match.undo, resp?.degraded);
  // bastra's archiving rm carries the receipt: run the command through it and
  // let it run — a move with an address needs no confirmation. The call id
  // ties the manifest lines to this call for the PostToolUse receipt.
  const viaShim = match.viaShim
    ? {
        permissionDecision: "allow",
        permissionDecisionReason: "bastra: rm archives here (bastra archive restore <path>)",
        updatedInput: {
          ...toolInput,
          command: shimRewrite(
            command,
            payload.tool_use_id || `${payload.session_id ?? "s"}-${startedAt}`,
            match.viaGit,
            // #934: the per-target limit rides along; the shim reads no settings.
            archiveMaxItem(process.env, await getArchiveMaxItem().catch(() => undefined)),
          ),
        },
      }
    : {};
  // The shim is off: count every rm it could have seen (shadow), and on a
  // command it would have taken, say so in one line — never on a mixed one.
  let offLine = "";
  if (match.wouldShim !== undefined) {
    const settings = bashVerdict(command, settingsFiles(payload.cwd));
    if (match.wouldShim) offLine = shimOffLine(command, settings, match.offFamily);
    const family = match.offFamily ?? "rm";
    await writeShadow(`${family}_shim_shadow`, {
      session_id: payload.session_id ?? null,
      matched_pattern: match.label,
      // Whether the shim would have taken the command: made of its acts only.
      [`${family}_only`]: match.wouldShim,
      settings_verdict: settings.verdict,
      settings_rule: settings.rule ?? null,
      hinted: offLine !== "",
      // The same call's dimensions as its bash_hook_call row (#507/#652).
      dimensions: dimensionsFrom({ client: clientEvidence, hook_source: "bash-pre", session_id: payload.session_id, agent }),
    });
  }
  const text = offLine ? block.replace(/<\/recall-hints>$/, `${offLine}\n</recall-hints>`) : block;
  const stdout = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...viaShim,
      additionalContext: text,
    },
  });

  // #458 (shadow): den fertigen Block ans Sitzungsbudget anrechnen und den
  // Governor-Entscheid loggen — nichts wird gekürzt.
  recordBudgetShadow(payload.session_id ?? null, "bash_hook_call", Math.ceil(block.length / 4));
  await writeTelemetry({
    session_id: payload.session_id ?? null,
    client: clientEvidence,
    agent,
    matched_pattern: match.label,
    severity: match.severity,
    hint_kind: match.severity === "destructive" ? (match.undo?.kind ?? "stop") : null,
    daemon_url: selfBaseUrl,
    daemon_reachable: resp !== null,
    hint_count: emitted.length,
    dropped_dedup_count: droppedDedupCount,
    dropped_unanchored_count: droppedUnanchoredCount,
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: Date.now() - startedAt,
    hint_tokens_est: Math.ceil(block.length / 4),
    hinted_ids: emitted.map((h) => h.id),
    hinted_types: emitted.map((h) => h.type),
    backoff_streak: 0,
    suppressed: false,
    suppressed_tokens_est: 0,
    status,
    error: errMsg,
  });
  // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
  await reportHinted(selfBaseUrl, emitted.map((h) => h.id), payload.session_id ?? null);

  return stdout;
}

function formatHintLine(h: RecallHit, hideScore = false): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  // P0: gleiche Wahl wie in prompt-lane.ts — ohne Fusion keine Zahl.
  return hideScore
    ? `- ${h.id} (${h.type}): ${summary}`
    : `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}`;
}

export function formatHintBlock(
  pattern: string,
  severity: "destructive" | "risky",
  hits: RecallHit[],
  unfused = false,
  surface = "claude-code",
  /** What the whole command allows (see hintFor); defaults to the label's own row. */
  undo: Undo | null = reversibleDefault(pattern, surface),
  // #565: der `degraded`-Grund der Antwort — ohne ihn behauptete der Block
  // „semantic search is off", wo der Arm lief und nur diesen Aufruf nicht
  // bediente.
  degraded?: string,
): string {
  const head = `<recall-hints surface="${surface}" trigger="bash-${severity}">`;
  const tail = `</recall-hints>`;
  const lines: string[] = [];

  if (severity === "risky") {
    lines.push(
      `CAUTION — risky Bash command detected (pattern: \`${pattern}\`). ` +
        `Check the target/scope before running — recursive/destructive side effects are easy to miss.`,
    );
  } else if (!undo) {
    lines.push(
      `STOP — destructive Bash command detected (pattern: \`${pattern}\`). ` +
        `Per user-preference this needs explicit user confirmation unless authorized in advance. ` +
        `Do not run blindly: confirm the target paths, the scope of effect, and that the user has asked for this exact action.`,
    );
  } else if (undo.kind === "receipt") {
    lines.push(`NOTE — reversible (pattern: \`${pattern}\`): ${undo.text} No confirmation needed.`);
  } else {
    lines.push(
      `REVERSIBLE FORM — destructive Bash command detected (pattern: \`${pattern}\`), but it has an undo: ` +
        `${undo.text} Run that form — it needs no confirmation. ` +
        `The bare command keeps the rule: explicit user confirmation unless authorized in advance.`,
    );
  }

  if (hits.length > 0) {
    lines.push("");
    lines.push(
      unfused
        ? `Relevant lessons / preferences from the vault — load_memory(id) before deciding to run. ` +
          unfusedHeadline("this command", unfusedReasonFor(degraded))
        : `Relevant lessons / preferences from the vault — load_memory(id) before deciding to run:`,
    );
    for (const h of hits) lines.push(formatHintLine(h, unfused));
  }

  return [head, HINT_FRAME_NOTE, stripFenceMarkers(lines.join("\n")), tail].join("\n");
}

interface BashHookCallTelemetry {
  /** #356: the Claude Code session this call belongs to — the payload's
   *  session_id, so per-session aggregation (context tax, #354) is possible.
   *  A synthetic UUID is the fallback only when the payload carried none. */
  session_id?: string | null;
  /** #507: die aufrufende Oberfläche — NUR wenn belegt (`hookClientEvidence`),
   *  nie der surface-Default. */
  client: HookClientEvidence;
  /** Hauptthread oder Subagent (`hookAgent`) — Telemetrie-Dimension `agent`;
   *  `null` ohne Beleg (Codex), dann fehlt die Spalte. */
  agent: HookAgent | null;
  matched_pattern: string;
  severity: "destructive" | "risky";
  /** #650/#614: what the block told the agent — STOP, a receipt, or the
   *  reversible form. Follow-through is only a question for `stop`. Null for
   *  risky (CAUTION). */
  hint_kind: HintKind | null;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  /** Memory lines dropped by the session dedup (same clock as the write lane). */
  dropped_dedup_count: number;
  /** #614: recalled hits left out because no strong `recall_when` anchor tied
   *  them to this command. */
  dropped_unanchored_count: number;
  top_score: number | null;
  latency_ms_total: number;
  /** Geschätzte Tokens des injizierten Tripwire-Blocks (#72). */
  hint_tokens_est: number;
  hinted_ids: string[];
  /** #354: Memory-Typ je `hinted_ids`-Eintrag, gleiche Reihenfolge. */
  hinted_types: string[];
  /** #161: Tripwire ist backoff-EXEMPT — Felder bleiben fürs Stats-Schema,
   *  sind aber konstant „nie unterdrückt“ (streak 0, suppressed false, 0). */
  backoff_streak: 0;
  suppressed: false;
  suppressed_tokens_est: 0;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

/** A shadow event: telemetry only, nothing in the vault (#650). */
async function writeShadow(kind: string, fields: Record<string, unknown>): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ kind, ts, hook_version: HOOK_VERSION, ...fields }) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}

async function writeTelemetry(payload: BashHookCallTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // #356: the payload's session_id is real session state — synthetic UUID
    // only when the payload carried none.
    const { session_id: payloadSessionId, client, agent, ...rest } = payload;
    const event = {
      kind: "bash_hook_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
      // #507: bash-pre is this lane's own hook_source — it never varies per call.
      dimensions: dimensionsFrom({ client, hook_source: "bash-pre", session_id: payloadSessionId, agent }),
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}

// Export for testing.
export { matchPattern, DESTRUCTIVE_PATTERNS, RISKY_PATTERNS, reversibleDefault, type HintKind, type Undo };
