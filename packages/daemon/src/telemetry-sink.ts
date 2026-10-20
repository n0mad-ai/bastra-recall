import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TelemetryEvent } from "./telemetry-events.js";
import { evalRunMark } from "./training-signal.js"; // #1128-capture

/**
 * The event log sink of `Telemetry`: one `events-YYYY-MM-DD.jsonl` per UTC day
 * under the log dir, one JSON object per line. Split out of telemetry.ts
 * (#1039) unchanged — the row bytes are pinned by telemetry-log-format.test.ts,
 * because `bastra logs --stats` and `bastra bridges mint` read this file.
 */
/**
 * #702: where a row goes. Live rows fill `events-YYYY-MM-DD.jsonl`; a row a
 * replay wrote (`bastra doctor --replay`: `dimensions.client === "replay"`,
 * or a `replay-` session id for a writer that carries no dimensions) goes to
 * `replay-YYYY-MM-DD.jsonl` instead. Every reader of the event log selects
 * `events-*.jsonl`, so a replay can never move a live number — not through
 * `bastra logs --stats`, not through the UI report, not through `bridges mint`.
 */
export function eventLogFile(
  logDir: string,
  ts: string,
  row: { session_id?: unknown; dimensions?: { client?: unknown } | null },
): string {
  const replay =
    row.dimensions?.client === "replay" ||
    (typeof row.session_id === "string" && row.session_id.startsWith("replay-"));
  return join(logDir, `${replay ? "replay" : "events"}-${ts.slice(0, 10)}.jsonl`);
}

export class EventSink {
  private readonly logDir: string;
  private initPromise: Promise<void> | null = null;

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  private async ensureDir(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(this.logDir, { recursive: true }).then(() => undefined);
    }
    await this.initPromise;
  }

  async write(event: TelemetryEvent): Promise<void> {
    try {
      await this.ensureDir();
      const file = eventLogFile(this.logDir, event.ts, event);
      // #1128-capture: a row a measurement run wrote says so.
      await appendFile(file, JSON.stringify({ ...event, ...evalRunMark(event) }) + "\n", "utf8");
    } catch (err) {
      // Telemetry must never break a tool call.
      console.error(`[bastra-recall] telemetry write failed: ${(err as Error).message}`);
    }
  }
}

export function fireAndForget(p: Promise<unknown>): void {
  p.catch((err) => {
    console.error(`[bastra-recall] telemetry: ${(err as Error).message}`);
  });
}
