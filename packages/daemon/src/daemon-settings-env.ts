/** Synchronous first dependency of index: apply pins before import-time reads. */
import { join } from "node:path";
import { readLegacySettings, readRuntimeSettingsRecord } from "./runtime-feature-settings.js";
import { bastraDataDir } from "./platform-paths.js";
import { applyDaemonSettingsEnv } from "./daemon-spawn-env.js";

// Do not import settings/registry here: their runtime dependencies themselves
// contain import-time env reads. The passive runtime reader never creates or
// migrates app state, including when index delegates a CLI invocation.
try {
  const path=join(bastraDataDir(), "cli-settings.json");
  const record=readRuntimeSettingsRecord(path);
  const text=record===undefined?readLegacySettings(path):record;
  const raw = JSON.parse(text ?? "{}") as { daemon?: { env?: Record<string, unknown> } };
  applyDaemonSettingsEnv(raw?.daemon?.env ?? {});
} catch {
  // The normal settings reader reports corrupt/unavailable state. Startup keeps
  // its existing defaults and writers continue to refuse corrupt settings.
  applyDaemonSettingsEnv({});
}
