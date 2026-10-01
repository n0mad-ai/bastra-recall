/**
 * dimensionValue() labelled every event without `dimensions` "(pre-#263)".
 * load_memory and read_document have no dimension stamp today, while recall
 * has had one since #263. A missing hook_recall row can also be a reflex hint,
 * not only a row outside the selected time window.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stats-dimension-value.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dimensionValue } from "../scripts/stats-shared.js";

test("a current tool-payload event is not labelled as a pre-#263 legacy row", () => {
  for (const kind of ["load_memory", "read_document"]) {
    for (const field of ["client", "hook_source", "arm"] as const) {
      assert.equal(
        dimensionValue({ kind, ts: "2026-09-25T10:00:00.000Z" }, field),
        "(tool call — not stamped)",
        `${kind}/${field}`,
      );
    }
  }
});

test("a hook-lane row without dimensions is still the legacy bucket", () => {
  assert.equal(dimensionValue({ kind: "hook_call", ts: "2026-08-01T10:00:00.000Z" }, "client"), "(pre-#263)");
  assert.equal(dimensionValue({ kind: "recall", ts: "2026-08-01T10:00:00.000Z" }, "hook_source"), "(pre-#263)");
});

test("a missing event is neither legacy nor a tool call", () => {
  const label = dimensionValue(undefined, "client");
  assert.equal(label, "(unmatched — no hook_recall row)");
  assert.notEqual(label, dimensionValue({ kind: "recall", ts: "2026-09-25T10:00:00.000Z" }, "client"));
});

test("a stamped dimension and an unstamped field keep their values", () => {
  const e = { kind: "hook_recall", ts: "t", dimensions: { client: "codex" } };
  assert.equal(dimensionValue(e, "client"), "codex");
  assert.equal(dimensionValue(e, "arm"), "unknown");
});
