/**
 * PreToolUse Write/Edit lane — the `hook_call` telemetry row (split out of
 * write-lane.ts, #680).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import type { HookAgent, HookClientEvidence } from "./hook-surface.js";
import type { PretoolHintReason } from "./pretool-shape.js";

const HOOK_VERSION = "0.4.0"; // 0.4.0 = daemon-side lane (#343)

export type HookStatus =
  | "ok"
  | "no-hits"
  | "skipped"
  | "suppressed"
  | "daemon-unreachable"
  | "timeout"
  | "error";

// ─── telemetry ──────────────────────────────────────────────────────────────

interface HookCallTelemetry {
  session_id: string | null;
  /** #507: die aufrufende Oberfläche — NUR wenn belegt (`hookClientEvidence`),
   *  nie der surface-Default. */
  client: HookClientEvidence;
  /** Hauptthread oder Subagent (`hookAgent`) — Telemetrie-Dimension `agent`;
   *  `null` ohne Beleg (Codex), dann fehlt die Spalte. */
  agent: HookAgent | null;
  tool_name: string;
  file_path: string | null;
  topics: string[];
  query_chars: number;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  required_count: number;
  top_score: number | null;
  latency_ms_total: number;
  dropped_dedup_count: number;
  dropped_scope_count: number;
  /** §20.5: "root-match" = echtes Repo-Wurzelsegment getroffen, "fallback" =
   *  letztes Pfadsegment geraten (dann filtert die Lane nicht), "none" = kein
   *  Pfad. Ohne dieses Feld ist `dropped_scope_count` nicht interpretierbar. */
  project_confidence?: "git-root" | "root-match" | "fallback" | "none";
  /** Der Name, gegen den verglichen wurde — null heißt: nicht gefiltert.
   *  `project_confidence: "root-match"` allein zeigt nicht, dass irrtümlich
   *  gegen "packages" verglichen wurde; dieses Feld zeigt es. */
  filter_project?: string | null;
  scope_filter_skipped?: "no-project" | "no-scope-evidence";
  dropped_scopes?: string[];
  /** Geschätzte Tokens des injizierten <recall-hints>-Blocks (#72). */
  hint_tokens_est: number;
  /** #579, Code-Awareness — fehlt, wenn kein Codeblock ausgegeben wurde.
   *  Getrennt von `hint_tokens_est` geführt, weil die ROI-Frage lautet, was
   *  der CODE-Kontext kostet und was er dafür an Abhängigen nennt. */
  code_block_tokens_est?: number;
  /** Anzahl der genannten abhängigen Dateien — die Nutzenseite. */
  code_dependents?: number;
  /** Der Graph lag hinter der Datei zurück, als der Block gebaut wurde. */
  code_stale?: boolean;
  /** #588: die im Block namentlich genannten Abhängigen, absolut — für
   *  `dependents_block_followed_by_edit`. */
  code_listed?: string[];
  /** #606: `basis` je ausgegebenem Block — symbols | diff | whole_file. */
  code_basis?: string[];
  /** #588: die Zieldateien dieses Aufrufs, absolut, die Gegenseite des Joins. */
  code_targets?: string[];
  /** #579: Tokens des `affects_files`-Blocks, falls einer ausging. */
  applies_to_tokens_est?: number;
  /** Anzahl der zugeordneten Memories. */
  applies_to_count?: number;
  /** IDs, die tatsächlich emittiert wurden (#72 context-tax per memory). */
  hinted_ids: string[];
  /** #354: Memory-Typ je Eintrag von `hinted_ids`, gleiche Reihenfolge und
   *  Länge. Trägt die Auswertung, die `acted_on` allein nicht leisten kann:
   *  eine Direktive („niemals X“) wirkt, indem NICHTS passiert, erzeugt also
   *  nie ein acted_on-Signal — ohne den Typ liest sich das in der Statistik
   *  wie eine ungenutzte Faktenmemory und lädt zum falschen Ausmisten ein. */
  hinted_types: string[];
  /** #161: aufgelöster Streak der Backoff-Entscheidung dieses Events. */
  backoff_streak: number;
  /** #161: true, wenn der Backoff die Injektion unterdrückt hat. */
  suppressed: boolean;
  /** #161: Tokens des NICHT injizierten Blocks — die Sparseite der ROI. */
  suppressed_tokens_est: number;
  /** #621: `compact` (first-touch, one candidate) or `legacy` (BASTRA_PRETOOL_SHAPE=legacy). */
  pretool_shape: "compact" | "legacy";
  /** #621: why the compact shape presented or withheld a hint — `first-touch`,
   *  `binding-anchored` (the named exception), `repeat-area`, `weak`. Absent
   *  when there was nothing to present or the shape is legacy. */
  hint_reason?: PretoolHintReason;
  status: HookStatus;
  error: string | null;
}

export async function writeTelemetry(payload: HookCallTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // The session_id from the Claude payload is real session state — fall
    // back to a synthetic UUID only if no payload session was given.
    const { session_id: payloadSessionId, client, agent, ...rest } = payload;
    const event = {
      kind: "hook_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
      // #507: pre-tool is this lane's own hook_source — it never varies per
      // call, unlike client, which the caller already resolved from the
      // payload (`hookClient`, same value the hint block's surface attribute
      // uses).
      dimensions: dimensionsFrom({ client, hook_source: "pre-tool", session_id: payloadSessionId, agent }),
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}
