/**
 * #194 — the survival suite guards its own coverage.
 *
 * The four survival arms (demote, soft-delete, unpin/floor-release,
 * curator-demote) are point-coverage: they prove those four transitions
 * cannot evaporate a cell, but nothing proved the set STAYS four. A fifth
 * mutation path (a merge arm, a dedup arm) would ship unpinned by default,
 * because nothing forced the person adding it to buy the invariant.
 *
 * This file is the mechanical close, both halves enumerated FROM CODE:
 *
 *  - Cell mutations all pass through the exported `audited*` surface of
 *    audit-save.ts. Runtime reflection diffs that surface against the pinned
 *    arms — a new audited export without a pin goes red here.
 *  - Score mutations all pass through ONE gateway: `applyStaleness` in
 *    search-staleness.ts (staleness, curator-demote, doc-damping, salience-live in a
 *    single multiplier). A static source scan counts every `.score`
 *    assignment in core and daemon src — a new assignment anywhere goes red
 *    here until it is routed through the gateway or pinned with its own arm.
 *    (#142 floors stay invisible to this scan by construction: the floor is
 *    injection-layer-only and never touches an engine score.)
 *
 * Runner: `tsx --test __tests__/survival-coverage.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as auditSave from "../src/audit-save.js";

// ─── half 1: cell-mutation surface ──────────────────────────────────────────

/** Every audited cell-mutation export and the survival arm that pins it.
 *  Adding an `audited*` export to audit-save.ts? Write its survival arm
 *  (the test proving the cell survives the transition by id), then pin the
 *  export here. */
const PINNED_CELL_ARMS: Record<string, string> = {
  auditedSave:
    "create/update — the write path replaces content, never resolution (survival-by-id.test.ts)",
  auditedSoftDelete:
    "soft-delete arm — trash + append-only audit record, recoverable (survival-by-id.test.ts)",
  auditedRestore:
    "restore arm — the trash file returns, the delete record persists (survival-by-id.test.ts)",
};

test("#194: every audited cell-mutation export carries a pinned survival arm", () => {
  const exported = Object.keys(auditSave)
    .filter((k) => k.startsWith("audited") && typeof (auditSave as Record<string, unknown>)[k] === "function")
    .sort();
  assert.deepEqual(
    exported,
    Object.keys(PINNED_CELL_ARMS).sort(),
    "the audited* surface of audit-save.ts drifted from the pinned survival arms. " +
      "A NEW export means a new cell-mutation path: write its survival arm (by-id " +
      "resolution survives the transition), then pin it in PINNED_CELL_ARMS. A " +
      "REMOVED export means an arm pins a path that no longer exists — retire the pin.",
  );
});

// ─── half 2: score-mutation gateway ─────────────────────────────────────────

/** Files allowed to write a score, with the exact count of assignment
 *  sites and the CLASS of each:
 *  - search-staleness.ts (split out of search.ts, #1039): the mutation
 *    gateway (`applyStaleness` — all multiplier
 *    sources in one place) plus the freestanding `applyStalenessMultiplier`
 *    kept as the bench baseline (scripts/bench-cache compares against it;
 *    nothing in src imports it — pinned below).
 *  - embeddings.ts: RRF fusion — score CONSTRUCTION while the rank list is
 *    built (an accumulator on a fresh FusedEntry), not a mutation of an
 *    existing hit. Listed so the scan stays exhaustive instead of quietly
 *    pattern-excluding it. */
const PINNED_SCORE_SITES: Record<string, number> = {
  "core/src/search-staleness.ts": 2,
  "core/src/embeddings.ts": 2,
};

const SCORE_ASSIGNMENT = /\.score\s*(?:[*+/-]|\?\?)?=(?!=)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      walk(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("#194: every score assignment lives in the pinned gateway files", () => {
  const packagesRoot = join(import.meta.dirname, "..", "..");
  const found: Record<string, number> = {};
  for (const pkg of ["core", "daemon"]) {
    for (const file of walk(join(packagesRoot, pkg, "src"))) {
      const matches = readFileSync(file, "utf8").match(SCORE_ASSIGNMENT);
      if (matches) {
        const key = relative(packagesRoot, file).split("\\").join("/");
        found[key] = matches.length;
      }
    }
  }
  assert.deepEqual(
    found,
    PINNED_SCORE_SITES,
    "a score assignment exists outside the pinned gateway sites. Route the new " +
      "multiplier through applyStaleness (search-staleness.ts) so every ranking effect stays " +
      "score-only and survival-guarded — or, if it genuinely needs its own path, " +
      "write its survival arm and pin the site here.",
  );
});

test("#194: the legacy freestanding multiplier is bench-only — no src module imports it", () => {
  const packagesRoot = join(import.meta.dirname, "..", "..");
  const offenders: string[] = [];
  for (const pkg of ["core", "daemon"]) {
    for (const file of walk(join(packagesRoot, pkg, "src"))) {
      const src = readFileSync(file, "utf8");
      if (file.endsWith(join("core", "src", "search-staleness.ts"))) continue; // its own definition
      if (file.endsWith(join("core", "src", "search.ts"))) continue; // its public re-export (#1039)
      if (src.includes("applyStalenessMultiplier")) offenders.push(relative(packagesRoot, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "applyStalenessMultiplier is the pre-gateway path kept only as the bench " +
      "baseline (scripts/bench-cache.ts). Serving code must use the SearchIndex " +
      "gateway — two live multiplier implementations is exactly the drift #194 closes.",
  );
});
