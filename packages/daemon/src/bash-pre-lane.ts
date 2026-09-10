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
import { hookClient } from "./hook-surface.js";
import { governContext } from "./context-governor.js";
import { postLane } from "./thin-client.js";
import { isUnfused, type HookRecallHit, type HookRecallResponse } from "./hook-recall-response.js";
import { unfusedHeadline } from "./band-wording.js";
import { extractCommandHead, invokesOwnBinary } from "./bash-fail-lane.js";
import {
  bumpShown,
  getLoadedMarkerMtime,
  loadSessionState,
  saveSessionState,
  shouldDropHit,
} from "./session-state.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.2.0"; // 0.2.0 = daemon-side lane (#343)
const SCORE_FLOOR = 50;

export interface BashHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// P0: EIN gemeinsamer Response-Typ für alle Lanes. Die lokale Kopie hier
// kannte `score_kind`/`unfused` nicht — das Feld fiel beim Parsen still weg,
// und diese Lane bandete danach rohe BM25-Werte mit einem Cut, den nur die
// fusionierte Skala trägt.
type RecallHit = HookRecallHit;
type RecallResponse = HookRecallResponse;

/**
 * Destructive patterns — always need a recall.
 * Order matters: longer / more specific phrases first so the *match string*
 * we surface to the user is the meaningful one.
 */
const DESTRUCTIVE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "rm -rf", re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/ },
  { label: "rm -r", re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b/ },
  { label: "rmdir", re: /\brmdir\b/ },
  { label: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/ },
  { label: "git checkout --", re: /\bgit\s+checkout\s+--\s/ },
  { label: "git clean -f", re: /\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*\b/ },
  { label: "git branch -D", re: /\bgit\s+branch\s+-D\b/ },
  { label: "git push --force-with-lease", re: /\bgit\s+push\b[^\n]*--force-with-lease/ },
  { label: "git push --force", re: /\bgit\s+push\b[^\n]*--force\b/ },
  { label: "git push -f", re: /\bgit\s+push\b[^\n]*\s-f\b/ },
  { label: "git commit --amend", re: /\bgit\s+commit\b[^\n]*--amend\b/ },
  { label: "gh repo delete", re: /\bgh\s+repo\s+delete\b/ },
  { label: "gh release delete", re: /\bgh\s+release\s+delete\b/ },
  { label: "npm uninstall", re: /\bnpm\s+uninstall\b/ },
  { label: "npm rm", re: /\bnpm\s+rm\b/ },
  { label: "yarn remove", re: /\byarn\s+remove\b/ },
  { label: "pnpm rm", re: /\bpnpm\s+(?:rm|remove)\b/ },
  { label: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { label: "DROP DATABASE", re: /\bDROP\s+DATABASE\b/i },
  // #415: `TRUNCATE` alone is an English word. Requiring the object — the same
  // shape the two DROP patterns above already have — is what separates the
  // statement from a sentence that mentions truncating.
  { label: "TRUNCATE TABLE", re: /\bTRUNCATE\s+TABLE\b/i },
  { label: "docker rm", re: /\bdocker\s+rm\b/ },
  { label: "docker volume rm", re: /\bdocker\s+volume\s+rm\b/ },
  { label: "kubectl delete", re: /\bkubectl\s+delete\b/ },
];

/**
 * Risky patterns — surface a softer hint. Same code path, only the label
 * differs so the recall query can pick up the right lessons.
 */
const RISKY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "chmod -R", re: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\b/ },
  { label: "chown -R", re: /\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\b/ },
  { label: "find ... -exec rm", re: /\bfind\b[^\n]*-exec\s+rm\b/ },
  // Overwrite redirect: `> file` (not `>>` append, not `2>` stderr, not `>&`).
  // Require a non-`>` char before `>` and at least one whitespace+filename after.
  // `> overwrite redirect` was a pattern here until 22.08.2026. Measured over
  // Jul–Aug: 90% of all tripwire calls, 1.1M injected tokens, the same three
  // unrelated memories in 99% of the hints, 12 loads in two months (0.4%).
  // A shell idiom, not a destructive act — it carried the noise, not the
  // value. Destructive patterns above keep the STOP warning.
];

/**
 * Command heads that only READ (#415).
 *
 * `grep -rn "DROP TABLE" .` and `rg "git reset --hard" docs/` carry a
 * destructive pattern as their SEARCH TERM. Matching them fired a STOP warning
 * at somebody looking something up — observed on legitimate work, and the same
 * shape of noise that got the `>` redirect pattern removed in August: a
 * tripwire that cries on reading gets ignored when it warns on writing.
 */
const SEARCH_ONLY_HEAD = /^(?:sudo\s+)?(?:grep|egrep|fgrep|rg|ag|ack|git\s+grep)\b/;

/**
 * The parts of a command line that actually run something (#415).
 *
 * Split on pipeline and sequence separators, then drop the segments that only
 * search. Per SEGMENT and not per command on purpose: `grep -rn "x" . | xargs
 * rm -rf` must still trip on its second half, and it does — only the `grep`
 * segment is dropped. A command with no separators is one segment, so the
 * common case costs a split of a short string.
 */
function executableSegments(cmd: string): string[] {
  return cmd
    .split(/\|\||&&|[|;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !SEARCH_ONLY_HEAD.test(s));
}

function matchPattern(cmd: string): { label: string; severity: "destructive" | "risky" } | null {
  const segments = executableSegments(cmd);
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (segments.some((s) => p.re.test(s))) return { label: p.label, severity: "destructive" };
  }
  for (const p of RISKY_PATTERNS) {
    if (segments.some((s) => p.re.test(s))) return { label: p.label, severity: "risky" };
  }
  return null;
}

/**
 * Run the tripwire pipeline; return the exact stdout document for the thin
 * client. Never throws — every failure degrades to `{}` plus telemetry.
 */
export async function runBashPreLane(payload: BashHookPayload, selfBaseUrl: string): Promise<string> {
  const startedAt = Date.now();
  const client = hookClient(payload);

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

  const match = matchPattern(command);
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
          session_id: payload.session_id ?? null,
          tool_input_excerpt: command.slice(0, 4096),
          scope: "all-projects",
          k: 3,
          // #263: siehe bash-fail-lane — die Lane weist sich aus.
          client,
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
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (unfused || h.score >= SCORE_FLOOR) hits.push(h);
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
      for (const h of kept) bumpShown(state, h.id, now);
      await saveSessionState(sessionId, state);
    }
  }

  // Emit hint even if no memories match — the warning itself is the point.
  // #161 CONSTRAINT (see top of file): the tripwire is exempt from backoff.
  const block = formatHintBlock(match.label, match.severity, emitted, unfused, client);
  const stdout = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: block,
    },
  });

  // #458 (shadow): den fertigen Block ans Sitzungsbudget anrechnen und den
  // Governor-Entscheid loggen — nichts wird gekürzt.
  recordBudgetShadow(payload.session_id ?? null, "bash_hook_call", Math.ceil(block.length / 4));
  await writeTelemetry({
    session_id: payload.session_id ?? null,
    matched_pattern: match.label,
    severity: match.severity,
    daemon_url: selfBaseUrl,
    daemon_reachable: resp !== null,
    hint_count: emitted.length,
    dropped_dedup_count: droppedDedupCount,
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
): string {
  const head = `<recall-hints surface="${surface}" trigger="bash-${severity}">`;
  const tail = `</recall-hints>`;
  const lines: string[] = [];

  if (severity === "destructive") {
    lines.push(
      `STOP — destructive Bash command detected (pattern: \`${pattern}\`). ` +
        `Per user-preference this needs explicit user confirmation unless authorized in advance. ` +
        `Do not run blindly: confirm the target paths, the scope of effect, and that Daniel has asked for this exact action.`,
    );
  } else {
    lines.push(
      `CAUTION — risky Bash command detected (pattern: \`${pattern}\`). ` +
        `Check the target/scope before running — recursive/destructive side effects are easy to miss.`,
    );
  }

  if (hits.length > 0) {
    lines.push("");
    lines.push(
      unfused
        ? `Relevant lessons / preferences from the vault — load_memory(id) before deciding to run. ` +
          unfusedHeadline("this command")
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
  matched_pattern: string;
  severity: "destructive" | "risky";
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  /** Memory lines dropped by the session dedup (same clock as the write lane). */
  dropped_dedup_count: number;
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

async function writeTelemetry(payload: BashHookCallTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // #356: the payload's session_id is real session state — synthetic UUID
    // only when the payload carried none.
    const { session_id: payloadSessionId, ...rest } = payload;
    const event = {
      kind: "bash_hook_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}

// Export for testing.
export { matchPattern, DESTRUCTIVE_PATTERNS, RISKY_PATTERNS };
