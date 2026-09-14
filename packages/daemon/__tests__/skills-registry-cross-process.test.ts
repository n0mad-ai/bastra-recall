/**
 * #533, the cross-process half.
 *
 * The skills registry is the one state file in this pair that demonstrably has
 * a second writer: `bastra skills add|remove` (cli/skills-cmd.ts) writes
 * ~/.bastra/skills.json from the CLI process, while the daemon writes it from
 * `POST /ui/skills` — the map's "mark as skill" button. A promise chain inside
 * one process cannot see the other, so this runs REAL node child processes
 * against one registry file and checks the durable union.
 *
 * (The pending-suggestions relay of #532 needs no such test: every writer and
 * the consumer live in the daemon — stop-lane.ts, curator-run.ts and
 * session-lane.ts are reached only through the daemon's HTTP routes, and the
 * hook CLI is a thin client that POSTs and never imports a lane.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_SRC = pathToFileURL(resolve(__dirname, "..", "src", "skills-registry.ts")).href;

/** Runs a child script to completion; rejects on a non-zero exit. */
function runChild(script: string, args: string[]): Promise<void> {
  return new Promise((ok, ko) => {
    const child = spawn("npx", ["tsx", script, ...args], {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", ko);
    child.on("close", (code) => (code === 0 ? ok() : ko(new Error(`child exited ${code}: ${stderr}`))));
  });
}

test("#533 — two processes adding skills at once keep the whole durable union", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-skills-xproc-"));
  try {
    const registry = join(dir, "skills.json");
    const script = join(dir, "add-skills.mts");
    await writeFile(
      script,
      `const [registry, prefix, count] = process.argv.slice(2);\n` +
        `const { addSkill } = await import(${JSON.stringify(SKILLS_SRC)});\n` +
        `for (let i = 0; i < Number(count); i++) await addSkill({ id: \`\${prefix}-\${i}\` }, registry);\n`,
      "utf8",
    );
    const perChild = 20;
    await Promise.all([
      runChild(script, [registry, "alpha", String(perChild)]),
      runChild(script, [registry, "beta", String(perChild)]),
    ]);

    const persisted = JSON.parse(await readFile(registry, "utf8")) as { id: string }[];
    const expected = [
      ...Array.from({ length: perChild }, (_, i) => `alpha-${i}`),
      ...Array.from({ length: perChild }, (_, i) => `beta-${i}`),
    ].sort();
    assert.deepEqual(
      persisted.map((e) => e.id).sort(),
      expected,
      `two processes must not overwrite each other: got ${persisted.length} of ${expected.length} entries`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
