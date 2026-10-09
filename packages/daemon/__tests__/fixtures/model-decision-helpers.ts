/**
 * Shared by the tests of the second counter-review of the model-recommendation
 * notice (PR #1118): one invented settings file per test, the fixture
 * recommendation, and a way to keep what a command prints.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRecommendation } from "../../src/cli/hardware.js";
import type { ModelsDeps } from "../../src/cli/models-cmd.js";

const entry = { model: "new:4b", sizeGB: 1, improves: "Invented fixture." };
export const REC: ModelRecommendation = { id: "fixture-rec", models: { baseline: entry, enhanced: entry, high: entry } };
export const ORIGINAL = JSON.stringify({ update: { mode: "notify" }, embedding: { provider: "ollama" }, generation: { model: "old:4b" }, api: { token: "invented-token" } });
export const ARGS = { command: "status", json: false, showHelp: false, showVersion: false };

/** A temp dir holding `settings.json` with ORIGINAL in it; removed afterwards. */
export async function withDir(fn: (dir: string, path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-model-delta-"));
  const path = join(dir, "settings.json");
  await writeFile(path, ORIGINAL);
  try {
    await fn(dir, path);
  } finally {
    await chmod(path, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Runs `fn` with stdout and stderr captured (the test-env preload drops stdout strings). */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const real = { out: process.stdout.write, err: process.stderr.write };
  let out = "";
  const grab = ((c: unknown) => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stdout.write = grab;
  process.stderr.write = grab;
  try {
    return { result: await fn(), out };
  } finally {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
  }
}

export const deps = (path: string, extra: Partial<ModelsDeps> = {}): ModelsDeps => ({ recommendation: REC, ramGB: 16, settingsPath: path, ...extra });
/** chmod does not take reading away from root, and not on Windows. */
export const cannotRevokeRead = process.platform === "win32" || process.getuid?.() === 0;
