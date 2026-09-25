import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Env-Var-Helper mit Legacy-Fallback.
 *
 * Migration `NEXUS_*` → `BASTRA_*`: jeder Daemon-Read greift erst auf den
 * neuen Namen zu, dann auf den alten als Backwards-Compat (für Daniels
 * Shell-RC, Mac-App-Configs und gespawnte Subprocesses, die noch die alte
 * Familie schicken). Wenn der Legacy-Name greift, schreiben wir genau
 * einmal pro Prozess eine Warnung nach stderr — damit der User weiß, dass
 * er auf den neuen Namen umstellen sollte.
 */
const warned = new Set<string>();

/**
 * #673: the event log a test process writes when it did not choose one.
 *
 * scripts/test-env.mjs fills in a throwaway BASTRA_LOG_PATH, but only for a run
 * started through it. A test file run directly — `npx tsx --test file.test.ts`,
 * the command most test headers document — never loads it, and every default
 * log dir resolved to the developer's ~/.bastra/logs: 258 fixture rows
 * (save_memory / save_hold with scopes gateproj, audittest, selftest) landed in
 * production logs that way, and every readout counted them as real creates.
 *
 * `node --test` marks each test process with NODE_TEST_CONTEXT however it was
 * started, so the default is closed here instead of in each runner script.
 * Checked at call time, not import time: tests delete BASTRA_LOG_PATH again
 * after constructing their own Telemetry, and a lane resolves its dir later.
 */
let testLogDir: string | undefined;
export function testRunLogDir(): string | undefined {
  if (!process.env.NODE_TEST_CONTEXT) return undefined;
  testLogDir ??= mkdtempSync(join(tmpdir(), "bastra-test-logs-"));
  return testLogDir;
}

export function envFirst(...names: string[]): string | undefined {
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      if (i > 0 && !warned.has(name)) {
        warned.add(name);
        console.error(
          `[bastra-recall] legacy env var ${name} in use — please rename to ${names[0]}.`,
        );
      }
      return value;
    }
  }
  return undefined;
}

export function envInt(name: string, fallback: number, legacyName?: string): number {
  const raw = legacyName ? envFirst(name, legacyName) : process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envFloat(name: string, fallback: number, legacyName?: string): number {
  const raw = legacyName ? envFirst(name, legacyName) : process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name: string, fallback: boolean, legacyName?: string): boolean {
  const raw = legacyName ? envFirst(name, legacyName) : process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}
