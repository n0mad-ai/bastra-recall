/**
 * packages/skill/install-hook.sh must register exactly what `bastra install
 * claude-code` registers — the reflex layer has one definition
 * (hookDefinitions) and the script used to carry a hand-copied second one:
 * six hooks, no PostToolUseFailure:Bash (doctor: "6/7 lanes"), Stop off by
 * default, and `--no-stop-hook` — the flag docs/USAGE.md tells you to use —
 * an "unknown flag".
 *
 * Revert-check: on the pre-fix script the default-set test sees 6 of 8
 * registrations and the `--no-stop-hook` test exits 2.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/install-hook-sh-parity.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hookDefinitions } from "../src/cli/adapters/claude-code.js";

const SCRIPT = resolve(import.meta.dirname, "../../skill/install-hook.sh");

function run(...args: string[]): { status: number | null; stderr: string; registered: string[] } {
  const home = mkdtempSync(join(tmpdir(), "bastra-install-hook-"));
  try {
    const r = spawnSync("bash", [SCRIPT, "--print", ...args], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    const registered: string[] = [];
    if (r.status === 0) {
      const hooks = JSON.parse(r.stdout).hooks as Record<string, Array<{ matcher?: string }>>;
      for (const [event, entries] of Object.entries(hooks)) {
        for (const e of entries) registered.push(`${event}:${e.matcher ?? ""}`);
      }
    }
    return { status: r.status, stderr: r.stderr, registered: registered.sort() };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const keys = (includeStop: boolean) =>
  hookDefinitions({ includeStop }).map((d) => `${d.event}:${d.matcher ?? ""}`).sort();

test("install-hook.sh: default registers the same set as the CLI, Stop included", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.registered, keys(true));
});

test("install-hook.sh: --no-stop-hook opts out of Stop and nothing else", () => {
  const r = run("--no-stop-hook");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.registered, keys(false));
});

test("install-hook.sh: --with-stop-hook stays valid (compat — now the default)", () => {
  const r = run("--with-stop-hook");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.registered, keys(true));
});
