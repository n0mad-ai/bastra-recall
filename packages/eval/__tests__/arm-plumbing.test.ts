import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Vault } from "@bastra-recall/core";
import {
  buildIndex,
  rankOf,
  TREATMENT_RECALL_WHEN_BOOST,
  EXPANDED_RECALL_WHEN_BOOST,
} from "../src/index-config.js";

/**
 * Arm-plumbing guard for the three-arm survival harness (#103).
 *
 * The lexical and expanded arms are pure BM25 and must be exercisable WITHOUT
 * Ollama (CI has none): the expanded treatment indexes recall_when_expanded at
 * the production ×2 boost, every control strips BOTH trigger fields, and the
 * multi-arm CLI reports the far in-pool/not-retrieved split per arm. The
 * hybrid arm runs production recallHybrid and is skipped when no Ollama (with
 * the embedding model) is reachable.
 */

const EVAL_DIR = resolve(import.meta.dirname, "..");
const SCRIPT = join(EVAL_DIR, "src", "persona-lift.ts");
const FIXTURE_VAULT = join(EVAL_DIR, "fixtures", "eval-vault");

/** Run the persona-lift CLI against the synthetic fixture vault.
 *  #542: `typeof spawnSync<string>` isn't valid — spawnSync is overloaded,
 *  not generic, so its type can't take a type argument this way. */
function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: EVAL_DIR,
    encoding: "utf8",
    timeout: 240_000,
  });
}

test("expanded arm: recall_when_expanded is indexed by the treatment only", async () => {
  const vault = new Vault(FIXTURE_VAULT);
  await vault.init();
  const memories = vault.list().filter((m) => !m.fm.obsolete);
  const control = buildIndex(memories, { kind: "control" });
  const lexical = buildIndex(memories, { kind: "treatment", boost: TREATMENT_RECALL_WHEN_BOOST });
  const expanded = buildIndex(memories, {
    kind: "treatment",
    boost: TREATMENT_RECALL_WHEN_BOOST,
    expandedBoost: EXPANDED_RECALL_WHEN_BOOST,
  });
  // "stampede" lives ONLY in backoff-jitter's recall_when_expanded — no other
  // field of any fixture memory contains it. Control strips both trigger
  // fields and the lexical treatment only adds recall_when, so only the
  // expanded treatment can retrieve the gold for it.
  assert.equal(rankOf(control.search("stampede"), "backoff-jitter"), 0, "control must not see expansions");
  assert.equal(rankOf(lexical.search("stampede"), "backoff-jitter"), 0, "lexical treatment must not see expansions");
  assert.equal(rankOf(expanded.search("stampede"), "backoff-jitter"), 1, "expanded treatment must index expansions");
  await vault.stop();
});

test("CLI --arms lexical,expanded: multi-arm report with a consistent far-split", () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-arm-plumbing-"));
  try {
    const out = join(dir, "report.json");
    const r = runCli(["--arms", "lexical,expanded", "--out", out]);
    assert.equal(r.status, 0, `CLI failed:\n${r.stderr}`);
    assert.match(r.stdout, /multi-arm, #103/);
    assert.match(r.stdout, /in-pool vs not-retrieved/);

    const json = JSON.parse(readFileSync(out, "utf8")) as {
      queries: number;
      arms: Record<
        string,
        {
          slices: Record<string, { n: number; control: number; treatment: number; lift: number }>;
          survival: number | null;
          farSplit: Record<string, { inPool: number; notRetrieved: number; meanGoldRank: number | null }>;
          personaRecall: Record<string, number>;
        }
      >;
    };
    assert.equal(json.queries, 100);
    for (const arm of ["lexical", "expanded"]) {
      const a = json.arms[arm];
      assert.ok(a, `arm "${arm}" missing from report`);
      for (const slice of ["all", "near", "far"]) {
        assert.equal(typeof a.slices[slice].treatment, "number", `${arm}/${slice} R@k missing`);
      }
      assert.equal(a.slices.all.n, 100);
      assert.equal(a.slices.near.n + a.slices.far.n, a.slices.all.n);
      // far-split must PARTITION the far slice, on both sides of the pair.
      for (const side of ["control", "treatment"]) {
        const s = a.farSplit[side];
        assert.equal(
          s.inPool + s.notRetrieved,
          a.slices.far.n,
          `${arm}/${side}: in-pool + not-retrieved must equal far n`,
        );
      }
      assert.equal(Object.keys(a.personaRecall).length, 10);
    }
    // Both BM25 controls strip both trigger fields → identical numbers.
    assert.equal(json.arms.lexical.slices.all.control, json.arms.expanded.slices.all.control);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI default (lexical only) keeps the legacy single-arm JSON shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-arm-legacy-"));
  try {
    const out = join(dir, "report.json");
    const r = runCli(["--out", out]);
    assert.equal(r.status, 0, `CLI failed:\n${r.stderr}`);
    const json = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    // Legacy top-level keys, and NO multi-arm nesting.
    for (const key of ["liftAll", "liftNear", "liftFar", "survival", "personaRecall"]) {
      assert.ok(key in json, `legacy key "${key}" missing`);
    }
    assert.ok(!("arms" in json), "lexical-only run must keep the legacy shape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── hybrid arm (production recallHybrid) — needs a reachable Ollama ─────────

const OLLAMA_URL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";

/** Ollama up AND the embedding model pulled — otherwise the hybrid arm can't run. */
async function ollamaUsable(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_URL.replace(/\/+$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return false;
    const json = (await resp.json()) as { models?: { name?: string }[] };
    return (json.models ?? []).some((m) => (m.name ?? "").startsWith(EMBED_MODEL));
  } catch {
    return false;
  }
}

test("CLI --arms lexical,hybrid: hybrid arm runs production recallHybrid", { timeout: 300_000 }, async (t) => {
  if (!(await ollamaUsable())) {
    t.skip(`Ollama with model "${EMBED_MODEL}" not reachable at ${OLLAMA_URL} — hybrid arm untested`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "bastra-arm-hybrid-"));
  try {
    const out = join(dir, "report.json");
    const r = runCli(["--arms", "lexical,hybrid", "--out", out]);
    assert.equal(r.status, 0, `CLI failed:\n${r.stderr}`);
    const json = JSON.parse(readFileSync(out, "utf8")) as {
      arms: Record<
        string,
        {
          slices: Record<string, { n: number }>;
          farSplit: Record<string, { inPool: number; notRetrieved: number }>;
        }
      >;
    };
    const h = json.arms.hybrid;
    assert.ok(h, "hybrid arm missing from report");
    assert.equal(h.slices.all.n, 100);
    for (const side of ["control", "treatment"]) {
      const s = h.farSplit[side];
      assert.equal(s.inPool + s.notRetrieved, h.slices.far.n, `hybrid/${side}: far-split must partition`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
