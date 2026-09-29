/**
 * SessionStart lane — the `session_hook_call` telemetry row and the
 * per-part token split of the session context (split out of
 * session-lane.ts, #680).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import type { HookAgent, HookClientEvidence } from "./hook-surface.js";
import type { Residency, ResidencySource } from "./embedding-warmup.js";

const HOOK_VERSION = "0.3.0";

export interface SessionHookTelemetry {
  /** #356: the Claude Code session this call belongs to — the payload's
   *  session_id, so per-session aggregation is possible. A synthetic UUID is
   *  the fallback only when the payload carried none. */
  session_id?: string | null;
  /** #507: die aufrufende Oberfläche — NUR wenn belegt (`hookClientEvidence`),
   *  nie der surface-Default. */
  client: HookClientEvidence;
  /** Hauptthread oder Subagent (`hookAgent`) — Telemetrie-Dimension `agent`;
   *  `null` ohne Beleg (Codex), dann fehlt die Spalte. */
  agent: HookAgent | null;
  source: string | null;
  project: string | null;
  queries: number;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  convention_count: number;
  /** Gepinnte Floor-Einträge im <pinned-memories>-Block (#141/#142). */
  pinned_count: number;
  top_score: number | null;
  latency_ms_total: number;
  /** Geschätzte Tokens des injizierten Session-Kontexts (#72). */
  hint_tokens_est: number;
  /** #462: dieselbe Schätzung je Teil des Blocks (pinned, recalls, taxonomy,
   *  language, care, import, onboarding, update, patch, pending, doku). Die
   *  Teile runden einzeln, ihre Summe kann `hint_tokens_est` um wenige Tokens
   *  übersteigen. Fehlt auf Zeilen vor #462. */
  hint_tokens_by_part: Record<SessionContextPart, number>;
  hinted_ids: string[];
  /** #354: Memory-Typ je `hinted_ids`-Eintrag, gleiche Reihenfolge. */
  hinted_types: string[];
  /** #513: Einträge je Relay-Spur und die Größe ihres gerenderten Blocks in
   *  Zeichen. Fehlt auf Zeilen vor #513. */
  pending_lanes: { recency: number; trends: number; recency_chars: number; trends_chars: number };
  /** #675: after-session harvest blocks this start delivered — the join key
   *  for the harvest save rate (`bastra logs --stats`). Absent before #675. */
  pending_harvest?: number;
  /** #509: which session-start constants (taxonomy, doku, language) were left
   *  out because this session's context already carries the identical text.
   *  Fehlt auf Zeilen vor #509. */
  constants_skipped: string[];
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
  /** #342/Deep-Dive 07.09.2026: welcher Arm ausgefallen ist — `vector-arm-timeout`
   *  oder `vector-arm-empty`. `null` heißt „keiner ist ausgefallen", NICHT
   *  „fusioniert": dafür ist `score_unfused` da. Fehlt auf Zeilen davor. */
  degraded_reason: string | null;
  /** Lagen die servierten Scores auf der rohen BM25-Skala statt auf der
   *  fusionierten? Derselbe fail-closed berechnete Wert, mit dem die Lane den
   *  Block bandet — die Telemetrie soll denselben Satz erzählen wie der Text,
   *  den der Nutzer sieht. */
  score_unfused: boolean;
  /** #490: Lag das Embedding-Modell beim Sitzungsstart im Speicher? `cold`
   *  und `unknown` heißen: Der dichte Arm bekam nur COLD_VECTOR_DEADLINE_MS
   *  und der Warmup lief daneben an. `null` = kein Koordinator (keine
   *  Embeddings). Fehlt auf Zeilen vor #490. */
  embedding_residency: Residency | null;
  /** #493: Woher die Residenz stammt und ob sie geschätzt ist — siehe
   *  `ResidencyReading`. `null` = kein Koordinator. Fehlt auf Zeilen davor. */
  embedding_residency_source: ResidencySource | null;
  embedding_residency_estimated: boolean | null;
  /** #493: Die Klammer, unter der die `hook_recall`-Events DIESES Starts
   *  stehen. Verbindet dieses Ereignis mit seinen Teil-Recalls. */
  session_start_call_id: string;
  /** #493: die datensparsame Kennung dieses Hosts — Tor 5 aus #492. */
  host_profile_id: string;
}

export const SESSION_CONTEXT_PARTS = [
  "pinned",
  "recalls",
  "taxonomy",
  "language",
  "care",
  "import",
  "onboarding",
  "update",
  "patch",
  "pending",
  "doku",
] as const;
export type SessionContextPart = (typeof SESSION_CONTEXT_PARTS)[number];

/**
 * #462: Token-Schätzung je Teil des Session-Start-Blocks — derselbe chars/4-
 * Schätzer wie `hint_tokens_est`, auf jeden Teil einzeln. 152 Starts trugen
 * 14,5 % der gesamten Kontextsteuer, und niemand konnte sagen, welcher der
 * zehn Teile die 2.344 Tokens pro Start ausgibt. Erst messen, dann über die
 * Kadenz entscheiden — die Entscheidung bleibt beim Nutzer, nicht hier.
 * Fehlende Teile zählen 0; ein leerer Eingabe-Record heißt „nichts injiziert".
 */
export function tokensByPart(parts: Partial<Record<SessionContextPart, string>>): Record<SessionContextPart, number> {
  const out = {} as Record<SessionContextPart, number>;
  for (const name of SESSION_CONTEXT_PARTS) {
    const text = parts[name] ?? "";
    out[name] = text.length === 0 ? 0 : Math.ceil(text.trim().length / 4);
  }
  return out;
}

export async function writeTelemetry(payload: SessionHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // The session_id from the Claude payload is real session state — fall
    // back to a synthetic UUID only if no payload session was given (#356).
    const { session_id: payloadSessionId, client, agent, ...rest } = payload;
    const event = {
      kind: "session_hook_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
      // #507: session is this lane's own hook_source — it never varies per
      // call. Distinct from "session-context", the shared assembler's own
      // marker for its sub-calls (session-assembler.ts).
      dimensions: dimensionsFrom({ client, hook_source: "session", session_id: payloadSessionId, agent }),
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}
