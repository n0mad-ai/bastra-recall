/**
 * `bastra bridges contribute` is coupled to the #129 held-out check.
 *
 * Until #129 the command refused outright: a harvested bridge was scored by the
 * judge that minted it, had no way down, and perturbed every query sharing its
 * trigger terms. The gate now exists (learned-recall/verify.ts): k-fold over
 * the candidate-pool log, lift ≥ 0 in every slice, no near regression, not
 * below the foreign-expansion null, confirmed on independent occasions, not
 * demoted. This test runs the real CLI over a real vault, log and local pool:
 *
 *   - `verify` prints the verdicts and stages nothing;
 *   - `contribute` stages exactly the bridges that pass, scrubbed and signed;
 *   - a demoted bridge stays home even when its lift is positive;
 *   - without a vault the command refuses instead of guessing.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/bridges-contribute-gate.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdBridges } from "../src/cli/bridges.js";
import { foldOf } from "../src/learned-recall/verify.js";

async function run(sub: string): Promise<{ rc: number; out: string }> {
  let captured = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => ((captured += c), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => ((captured += c), true)) as typeof process.stderr.write;
  try {
    const rc = await cmdBridges({ sub, positional: [] });
    return { rc, out: captured };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function memory(id: string, title: string, summary: string): string {
  const day = "2026-09-01";
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${summary}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: gate129",
    "recall_when:",
    `  - ${title}`,
    `created: ${day}`,
    `updated: ${day}`,
    "---",
    "",
    summary,
    "",
  ].join("\n");
}

/** Two far queries in different folds that share their words. */
function twoQueries(): [string, string] {
  const qs: string[] = [];
  for (let i = 0; qs.length < 2 && i < 500; i++) {
    // letters, not digits: a digit-bearing term is scrubbed before sharing
    const q = `warum schließt sich das fenster beim dialog variante${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
    if (qs.length === 0 || foldOf(q) !== foldOf(qs[0])) qs.push(q);
  }
  return [qs[0], qs[1]];
}

function reachLines(query: string, session: string, id: string): string[] {
  const ts = "2026-09-20T10:00:00.000Z";
  return [
    { kind: "hook_recall", ts, recall_id: id, query, tool_name: "UserPromptSubmit", dimensions: { hook_source: "prompt", experiment_session: session }, candidate_pool: [{ id: "d1", score: 40 }, { id: "d2", score: 30 }] },
    { kind: "recall_episode", ts, recall_id: id, memory_id: "panel", acted_on: true },
  ].map((e) => JSON.stringify(e));
}

async function withSetup(fn: (d: { bridgesRoot: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bastra-gate129-"));
  const vault = join(root, "vault");
  const logs = join(root, "logs");
  const bridgesRoot = join(root, "bridges-root");
  await mkdir(vault, { recursive: true });
  await mkdir(logs, { recursive: true });
  await writeFile(join(vault, "panel.md"), memory("panel", "Nspanel resignkey observer", "Nspanel resignkey observer keywindow."));
  for (let i = 1; i <= 5; i++) {
    await writeFile(join(vault, `d${i}.md`), memory(`d${i}`, `Fenster Dialog Notiz ${i}`, `Warum schließt sich das Fenster beim Dialog, Fall ${i}.`));
  }
  const [qa, qb] = twoQueries();
  const lines = [...reachLines(qa, "s1", "r1"), ...reachLines(qa, "s2", "r2"), ...reachLines(qb, "s1", "r3"), ...reachLines(qb, "s2", "r4")];
  await writeFile(join(logs, "events-2026-09-20.jsonl"), lines.join("\n") + "\n");
  const saved = { v: process.env.BASTRA_VAULT_PATH, l: process.env.BASTRA_LOG_PATH, b: process.env.BASTRA_BRIDGES_PATH, c: process.env.BASTRA_COMMONS_PATH };
  process.env.BASTRA_VAULT_PATH = vault;
  process.env.BASTRA_LOG_PATH = logs;
  process.env.BASTRA_BRIDGES_PATH = bridgesRoot;
  process.env.BASTRA_COMMONS_PATH = join(root, "commons");
  try {
    const mint = await run("mint");
    assert.equal(mint.rc, 0, mint.out);
    await fn({ bridgesRoot });
  } finally {
    for (const [k, v] of [["BASTRA_VAULT_PATH", saved.v], ["BASTRA_LOG_PATH", saved.l], ["BASTRA_BRIDGES_PATH", saved.b], ["BASTRA_COMMONS_PATH", saved.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function staged(bridgesRoot: string): Promise<Array<Record<string, unknown>>> {
  const dir = join(bridgesRoot, "contribute");
  if (!existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const lang of await readdir(dir)) {
    for (const f of await readdir(join(dir, lang))) out.push(JSON.parse(await readFile(join(dir, lang, f), "utf8")));
  }
  return out;
}

test("verify reports the held-out check and stages nothing", async () => {
  await withSetup(async ({ bridgesRoot }) => {
    const { rc, out } = await run("verify");
    assert.equal(rc, 0, out);
    assert.match(out, /held-out check \(#129\)/);
    assert.match(out, /far-out-of-pool: 2 case\(s\), bridges fired on 2/);
    assert.match(out, /2 of 2 local bridge\(s\) pass the #129 gate/);
    assert.deepEqual(await staged(bridgesRoot), []);
  });
});

test("contribute stages exactly the bridges that pass, scrubbed and signed", async () => {
  await withSetup(async ({ bridgesRoot }) => {
    const { rc, out } = await run("contribute");
    assert.equal(rc, 0, out);
    const files = await staged(bridgesRoot);
    assert.equal(files.length, 2, out);
    for (const b of files) {
      assert.equal(typeof b.verifier, "string", "a staged bridge carries the pseudonymous verifier");
      assert.equal(b.first_seen, undefined, "local bookkeeping stays home");
      assert.ok((b.evidence as number) >= 2);
    }
  });
});

test("a demoted bridge stays home even with a positive held-out lift", async () => {
  await withSetup(async ({ bridgesRoot }) => {
    const dir = join(bridgesRoot, "bridges", "de");
    const [first] = await readdir(dir);
    const path = join(dir, first);
    const b = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...b, demoted_at: "2026-09-25T00:00:00.000Z" }));
    const { out } = await run("contribute");
    assert.match(out, /demoted/);
    assert.equal((await staged(bridgesRoot)).length, 1);
  });
});

test("without a vault the check refuses instead of guessing", async () => {
  const saved = process.env.BASTRA_VAULT_PATH;
  const savedNexus = process.env.NEXUS_VAULT_PATH;
  delete process.env.BASTRA_VAULT_PATH;
  delete process.env.NEXUS_VAULT_PATH;
  const savedBridges = process.env.BASTRA_BRIDGES_PATH;
  const savedCommons = process.env.BASTRA_COMMONS_PATH;
  const root = await mkdtemp(join(tmpdir(), "bastra-gate129-novault-"));
  process.env.BASTRA_BRIDGES_PATH = join(root, "b");
  process.env.BASTRA_COMMONS_PATH = join(root, "c");
  try {
    const { rc, out } = await run("contribute");
    assert.equal(rc, 1);
    assert.match(out, /BASTRA_VAULT_PATH/);
  } finally {
    if (saved !== undefined) process.env.BASTRA_VAULT_PATH = saved;
    if (savedNexus !== undefined) process.env.NEXUS_VAULT_PATH = savedNexus;
    if (savedBridges === undefined) delete process.env.BASTRA_BRIDGES_PATH;
    else process.env.BASTRA_BRIDGES_PATH = savedBridges;
    if (savedCommons === undefined) delete process.env.BASTRA_COMMONS_PATH;
    else process.env.BASTRA_COMMONS_PATH = savedCommons;
    await rm(root, { recursive: true, force: true });
  }
});
