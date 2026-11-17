/**
 * #642 — REPORT.md lists memories that carry almost nothing, with the reason
 * per entry and a cap; report only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectLowSignal, lowSignalReasons, LOW_SIGNAL_REPORT_LIMIT } from "../src/low-signal.js";
import { renderVaultHealthReport, type VaultHealthData } from "../src/vault-report.js";

const BODY = "The staging deploy needs the migration flag set before the first request arrives.";

const mem = (id: string, fm: Record<string, unknown> = {}, body = BODY) => ({
  fm: {
    id,
    title: "Staging deploy flag",
    type: "lesson",
    summary: "Staging deploy needs the migration flag.",
    recall_when: ["preparing the staging deploy pipeline"],
    ...fm,
  },
  body,
});

test("each reason is named; a well-formed memory has none", () => {
  assert.deepEqual(lowSignalReasons(mem("ok")), []);
  assert.deepEqual(lowSignalReasons(mem("short", {}, "Todo.")), ["body has 5 characters"]);
  assert.deepEqual(lowSignalReasons(mem("date", { title: "2026-11-17" })), ["title is only a date"]);
  assert.deepEqual(lowSignalReasons(mem("bare", { recall_when: [] })), ["no recall_when trigger"]);
  assert.deepEqual(lowSignalReasons(mem("word", { recall_when: ["deploy"] })), ["one-word trigger: 'deploy'"]);
  assert.deepEqual(
    lowSignalReasons(
      mem("copy", {
        summary: "The staging deploy needs the migration flag set first.",
        recall_when: ["staging deploy needs the migration flag set first"],
      })
    ),
    ["a trigger restates the summary"]
  );
});

test("works in any script: a Cyrillic title of digits is a date, Cyrillic text is not flagged", () => {
  assert.deepEqual(
    lowSignalReasons(
      mem("ru", {
        title: "Флаг миграции для стейджинга",
        summary: "Для стейджинга нужен флаг миграции.",
        recall_when: ["подготовка выката на стейджинг"],
      })
    ),
    []
  );
});

test("obsolete, superseded and generated-trigger memories are left out; most reasons sort first", () => {
  const rows = collectLowSignal([
    mem("b-one", {}, "x"),
    mem("a-two", { title: "17.11.2026" }, "x"),
    mem("gone", { obsolete: true }, "x"),
    mem("old", { superseded_by: "new" }, "x"),
    mem("doc", { type: "doc" }, "x"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a-two", "b-one"]
  );
});

const base: VaultHealthData = {
  generatedAt: "2026-11-17T10:00:00.000Z",
  vaultSize: 3,
  stale: [],
  floors: [],
  conflicts: [],
  dangling: [],
};

test("REPORT.md renders the section, capped, and only when collected", () => {
  assert.doesNotMatch(renderVaultHealthReport(base), /Low-signal memories/);
  assert.match(renderVaultHealthReport({ ...base, lowSignal: [] }), /## Low-signal memories\n\nNone\./);

  const many = Array.from({ length: LOW_SIGNAL_REPORT_LIMIT + 5 }, (_, i) => ({
    id: `m${String(i).padStart(2, "0")}`,
    reasons: ["body has 3 characters"],
  }));
  const report = renderVaultHealthReport({ ...base, lowSignal: many });
  assert.match(report, /- \[\[m00\]\]: body has 3 characters/);
  assert.doesNotMatch(report, new RegExp(`\\[\\[m${LOW_SIGNAL_REPORT_LIMIT}\\]\\]`));
  assert.match(report, new RegExp(`Showing ${LOW_SIGNAL_REPORT_LIMIT} of ${LOW_SIGNAL_REPORT_LIMIT + 5}`));
});
