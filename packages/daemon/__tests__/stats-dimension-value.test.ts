/**
 * dimensionValue() labelled every event without `dimensions` "(pre-#263)".
 * recall / load_memory / read_document events never carry `dimensions` (they
 * are direct tool payloads, not a hook lane's own event), so every current
 * instance of them read as legacy data; a recall_id with no hook_recall in the
 * window (no event at all) fell into the same label. Three causes, three labels.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stats-dimension-value.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dimensionValue } from "../scripts/stats-shared.js";

test("a current tool-payload event is not labelled as a pre-#263 legacy row", () => {
  for (const kind of ["recall", "load_memory", "read_document"]) {
    const label = dimensionValue({ kind, ts: "2026-09-25T10:00:00.000Z" }, "hook_source");
    assert.notEqual(label, "(pre-#263)", kind);
  }
});

test("a hook-lane row without dimensions is still the legacy bucket", () => {
  assert.equal(dimensionValue({ kind: "hook_call", ts: "2026-08-01T10:00:00.000Z" }, "client"), "(pre-#263)");
});

test("a missing event is neither legacy nor a tool call", () => {
  const label = dimensionValue(undefined, "client");
  assert.notEqual(label, "(pre-#263)");
  assert.notEqual(label, dimensionValue({ kind: "recall", ts: "2026-09-25T10:00:00.000Z" }, "client"));
});

test("a stamped dimension and an unstamped field keep their values", () => {
  const e = { kind: "hook_recall", ts: "t", dimensions: { client: "codex" } };
  assert.equal(dimensionValue(e, "client"), "codex");
  assert.equal(dimensionValue(e, "arm"), "unknown");
});
