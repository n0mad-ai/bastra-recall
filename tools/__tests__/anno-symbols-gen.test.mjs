/**
 * Conformance test for the TypeScript producer of the anno-check symbol table.
 *
 * The fixture is zzallirog's example repo from the anno bundle, reproduced here
 * so the test does not depend on having the bundle around. Its expected map is
 * what HIS engine (codebase-memory-mcp) emitted for those four files — so this
 * asserts that a second producer agrees with the reference implementation, not
 * merely that our code is self-consistent.
 *
 * What the fixture pins down, and why each line matters:
 *   - POLL_MS is NOT exported and still appears → all top-level declarations
 *     count, not just the exported ones.
 *   - consumer.ts imports CARD_LIFE_MS and is NOT listed as a location for it →
 *     use sites never become definitions (his ruling 3, re-exports def-only).
 *   - the parameter `id` of makeCard is absent → parameters are not symbols.
 *
 * Runner: node --test tools/__tests__/anno-symbols-gen.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GEN = fileURLToPath(new URL("../anno-symbols-gen-ts.mjs", import.meta.url));

const FIXTURE = {
  "src/target.ts":
    "// supernova card: how long a fresh-memory card stays lit in the live map\n" +
    "export const CARD_LIFE_MS = 90000;\n" +
    "export function makeCard(id: string) {\n  return { id, ttl: CARD_LIFE_MS };\n}\n",
  "src/consumer.ts":
    'import { CARD_LIFE_MS } from "./target";\n' +
    "const POLL_MS = CARD_LIFE_MS / 2;\n" +
    "export function poll(): number {\n  return POLL_MS;\n}\n",
  "src/broken.ts": "export const unused = 1;\n",
  "src/rulings.ts": "export const rulings = true;\n",
};

/** Exactly what his engine produced for the fixture above. */
const EXPECTED = {
  CARD_LIFE_MS: ["src/target.ts"],
  makeCard: ["src/target.ts"],
  POLL_MS: ["src/consumer.ts"],
  poll: ["src/consumer.ts"],
  unused: ["src/broken.ts"],
  rulings: ["src/rulings.ts"],
};

const normalize = (map) =>
  Object.fromEntries(
    Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, [...v].sort()])
  );

async function fixtureRepo(t) {
  const dir = await mkdtemp(join(tmpdir(), "anno-symbols-"));
  await mkdir(join(dir, "src"), { recursive: true });
  for (const [rel, body] of Object.entries(FIXTURE)) await writeFile(join(dir, rel), body, "utf8");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  return dir;
}

const tableOf = (dir) =>
  JSON.parse(gunzipSync(readFileSync(join(dir, ".codebase-memory", "anno-symbols.json.gz"))).toString());

test("reproduces the reference engine's symbol map for the fixture repo", async (t) => {
  const dir = await fixtureRepo(t);
  execFileSync("node", [GEN, dir], { stdio: "pipe" });

  const table = tableOf(dir);
  assert.deepEqual(
    normalize(table.symbols),
    normalize(EXPECTED),
    "a second producer must agree with the reference implementation, symbol for symbol"
  );
});

test("_head is the real HEAD — the checker exits 2 when it drifts", async (t) => {
  const dir = await fixtureRepo(t);
  execFileSync("node", [GEN, dir], { stdio: "pipe" });

  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(tableOf(dir)._head, head);
});

test("a name declared in several files keeps every location, sorted", async (t) => {
  const dir = await fixtureRepo(t);
  await writeFile(join(dir, "src", "second.ts"), "export const CARD_LIFE_MS = 1;\n", "utf8");
  await writeFile(join(dir, "src", "another.ts"), "const CARD_LIFE_MS = 2;\n", "utf8");
  execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "collision"], { stdio: "pipe" });
  execFileSync("node", [GEN, dir], { stdio: "pipe" });

  // never first-wins: the value is a list so a path hint can be checked
  assert.deepEqual(tableOf(dir).symbols.CARD_LIFE_MS, ["src/another.ts", "src/second.ts", "src/target.ts"]);
});

test("generics key on the bare identifier, overloads collapse to one name", async (t) => {
  const dir = await fixtureRepo(t);
  await writeFile(
    join(dir, "src", "generic.ts"),
    "export interface Box<T> { value: T }\n" +
      "export function pick<T>(x: T): T { return x; }\n" +
      "export function twice(x: string): string;\n" +
      "export function twice(x: number): number;\n" +
      "export function twice(x: any): any { return x; }\n",
    "utf8"
  );
  execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "generics"], { stdio: "pipe" });
  execFileSync("node", [GEN, dir], { stdio: "pipe" });

  const s = tableOf(dir).symbols;
  assert.deepEqual(s.Box, ["src/generic.ts"], "Box, never Box<T>");
  assert.equal(
    Object.keys(s).some((k) => k.includes("<")),
    false,
    "no type parameters in any key"
  );
  assert.deepEqual(s.twice, ["src/generic.ts"], "three overload signatures, one entry");
});

test("a re-export does not become a location for the symbol", async (t) => {
  const dir = await fixtureRepo(t);
  await writeFile(join(dir, "src", "index.ts"), 'export { makeCard } from "./target";\n', "utf8");
  execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "re-export"], { stdio: "pipe" });
  execFileSync("node", [GEN, dir], { stdio: "pipe" });

  // a re-export is an edge in the graph, not a node
  assert.deepEqual(tableOf(dir).symbols.makeCard, ["src/target.ts"]);
});
