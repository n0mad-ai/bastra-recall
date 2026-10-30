/** Advisory audit rows carry IDs/counters, never prompt or artifact text. */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { envFirst, envOff } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
export async function recordRulebookEvent(sessionId: string | null, fields: Record<string, unknown>): Promise<void> {
  if (envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  try {
    const dir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(dir, { recursive: true }); const ts = new Date().toISOString();
    await appendFile(join(dir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ kind: "rulebook_check", ts,
      session_id: sessionId, session_known: !!sessionId, ...fields }) + "\n", "utf8");
  } catch { /* never change the decision */ }
}
