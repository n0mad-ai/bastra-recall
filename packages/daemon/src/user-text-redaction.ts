/**
 * The owner's switch for credential redaction in user content (owner decision
 * 25.11.2026, 1.3.0): `redaction.enabled`, on by default. Off, drafts, the
 * suggestion relay, notes, documents, tasks and task reports keep their text
 * byte for byte. The redesign (vault, password manager) is #1684 in 1.4.0.
 *
 * Not behind this switch, and redacted regardless: the audit trail's content
 * snapshots, training capture, telemetry-derived learning data and the vault
 * health report's query list. Those are logs, not the user's own content.
 *
 * Read synchronously because every redaction site is synchronous. The value
 * is cached for a second (a task store write cleans every field of every
 * task) and dropped whenever this process writes the settings, so a change
 * from the web UI applies at once and one from the CLI within a second.
 * Unreadable or malformed settings keep redaction on.
 */
import { join, resolve } from "node:path";
import { redactSecrets, type SecretRedactionResult } from "@bastra-recall/core/scrub";
import { bastraDataDir } from "@bastra-recall/core/platform-paths";
import { readLegacySettings, readRuntimeSettingsRecord } from "./runtime-feature-settings.js";

const CACHE_MS = 1_000;
let cached: { key: string; at: number; on: boolean } | undefined;

function storedSwitch(text: string | null | undefined): boolean {
  if (typeof text !== "string") return true;
  try {
    return (JSON.parse(text) as { redaction?: { enabled?: unknown } } | null)?.redaction?.enabled !== false;
  } catch {
    return true;
  }
}

/** Whether credential values in user content are replaced by `[REDACTED]`. */
export function redactionEnabled(): boolean {
  const legacy = resolve(join(bastraDataDir(), "cli-settings.json"));
  const key = `${process.env.BASTRA_DB_PATH ?? ""}\0${legacy}`;
  const now = Date.now();
  if (cached?.key === key && now - cached.at < CACHE_MS) return cached.on;
  const record = readRuntimeSettingsRecord(legacy);
  const on = storedSwitch(record === undefined ? readLegacySettings(legacy) : record);
  cached = { key, at: now, on };
  return on;
}

/** Called by the settings writer: the next read sees the new value. */
export function forgetRedactionSetting(): void {
  cached = undefined;
}

/** `redactSecrets` for user content; with the switch off the text comes back unchanged. */
export function redactUserText(text: string, home?: string): SecretRedactionResult {
  return redactionEnabled() ? redactSecrets(text, home) : { text, redactedChars: 0 };
}
