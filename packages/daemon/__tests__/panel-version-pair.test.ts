/**
 * The panel's two conditional blocks, as pure functions (#225, #224).
 *
 * #225 — CLI and daemon carry separate version constants. The panel used to
 * print `health?.version ?? VERSION` under one bare "version" label, which can
 * never be right for a drifted pair: it showed the daemon's build and let an
 * outdated CLI look current.
 * #224 — provider=none plus a reachable local Ollama is the one case where
 * semantic recall is a single command away and nothing said so.
 *
 * Asserts the LOGIC, not the layout: which builds are named, whether a drift
 * marker is present, whether the row exists at all. Wording is free to change.
 *
 * Run: npx tsx --test packages/daemon/__tests__/panel-version-pair.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { formatVersionRows, semanticRecallRow } from "../src/cli/panel.js";

/** Everything a row shows, label and value joined — layout-agnostic. */
function text(rows: Array<[string, string]>): string {
  return rows.map(([l, v]) => `${l} ${v}`).join("\n");
}

const DRIFT_MARKER = /drift/i;

test("matching pair collapses to one row with no drift marker", () => {
  const rows = formatVersionRows({
    cliVersion: "0.8.7",
    daemonVersion: "0.8.7",
    updateLatest: null,
  });
  assert.equal(rows.length, 1);
  const out = text(rows);
  assert.match(out, /0\.8\.7/);
  assert.ok(!DRIFT_MARKER.test(out), `no drift hint for an identical pair, got: ${out}`);
  // The version must not be attributed to one half when both agree.
  assert.ok(!/cli 0\.8\.7/.test(out) || !/daemon 0\.8\.7/.test(out));
});

test("a matching pair still carries the update status", () => {
  const upToDate = text(formatVersionRows({ cliVersion: "0.8.7", daemonVersion: "0.8.7", updateLatest: null }));
  const outdated = text(formatVersionRows({ cliVersion: "0.8.7", daemonVersion: "0.8.7", updateLatest: "0.9.0" }));
  assert.notEqual(upToDate, outdated);
  assert.match(outdated, /0\.9\.0/);
});

test("drifted pair names both builds and marks the drift", () => {
  const rows = formatVersionRows({
    cliVersion: "0.8.6",
    daemonVersion: "0.8.7",
    updateLatest: null,
  });
  assert.ok(rows.length >= 2, "a drifted pair needs more than the single compact row");
  const out = text(rows);
  assert.match(out, /cli[^\n]*0\.8\.6/, "the CLI build must be visible and named");
  assert.match(out, /daemon[^\n]*0\.8\.7/, "the daemon build must be visible and named");
  assert.match(out, DRIFT_MARKER, "a drifted pair must be marked as such");
});

test("drift is symmetric — a newer CLI against an older daemon reads the same way", () => {
  const out = text(formatVersionRows({ cliVersion: "0.9.0", daemonVersion: "0.8.7", updateLatest: null }));
  assert.match(out, /cli[^\n]*0\.9\.0/);
  assert.match(out, /daemon[^\n]*0\.8\.7/);
  assert.match(out, DRIFT_MARKER);
});

test("no daemon to compare against shows the CLI build, named as the CLI's", () => {
  const rows = formatVersionRows({
    cliVersion: "0.8.6",
    daemonVersion: null,
    updateLatest: null,
  });
  assert.equal(rows.length, 1);
  const out = text(rows);
  assert.match(out, /cli[^\n]*0\.8\.6/, "the number shown is the CLI's and must say so");
  assert.ok(!/daemon[^\n]*0\.8\.6/.test(out), `the CLI version must never be presented as the daemon's, got: ${out}`);
  assert.ok(!DRIFT_MARKER.test(out), "nothing to compare is not a drift");
});

// ─── #224: the semantic-recall discovery row ─────────────────────────────────

test("provider none plus a reachable Ollama offers the enable hint", () => {
  const row = semanticRecallRow({
    effectiveProvider: "none",
    daemonSemanticRecall: "off",
    ollamaReachable: true,
  });
  assert.ok(row, "the one actionable case must produce a row");
  assert.match(row[1], /ollama/i);
  assert.match(row[1], /bastra embeddings on/);
});

test("an unreachable Ollama produces no row at all", () => {
  assert.equal(
    semanticRecallRow({ effectiveProvider: "none", daemonSemanticRecall: "off", ollamaReachable: false }),
    null
  );
});

test("a configured provider produces no row", () => {
  assert.equal(
    semanticRecallRow({ effectiveProvider: "ollama", daemonSemanticRecall: "on", ollamaReachable: true }),
    null
  );
  assert.equal(
    semanticRecallRow({ effectiveProvider: "openai", daemonSemanticRecall: undefined, ollamaReachable: true }),
    null
  );
});

test("a daemon already running semantic recall suppresses the row", () => {
  // The daemon's own environment (LaunchAgent plist) can set a provider this
  // shell never sees — "off" next to a semantic daemon would contradict itself.
  for (const live of ["on", "degraded"] as const) {
    assert.equal(
      semanticRecallRow({ effectiveProvider: "none", daemonSemanticRecall: live, ollamaReachable: true }),
      null,
      `daemon reporting ${live} must suppress the OFF hint`
    );
  }
});

test("an offline daemon does not suppress the hint", () => {
  assert.ok(semanticRecallRow({ effectiveProvider: "none", daemonSemanticRecall: undefined, ollamaReachable: true }));
});
