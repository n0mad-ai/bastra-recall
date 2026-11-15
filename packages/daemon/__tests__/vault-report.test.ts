/**
 * Tests for the vault-health report renderer (#156): section structure with
 * stable anchors, wikilinks, empty states, and the atomic writer.
 *
 * Run: npx tsx --test packages/daemon/__tests__/vault-report.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderVaultHealthReport,
  writeVaultHealthReport,
  REPORT_FILENAME,
  type VaultHealthData,
} from "../src/vault-report.js";

const EMPTY: VaultHealthData = {
  generatedAt: "2026-07-03T12:00:00Z",
  vaultSize: 42,
  stale: [],
  floors: [],
  conflicts: [],
  dangling: [],
};

const FULL: VaultHealthData = {
  generatedAt: "2026-07-03T12:00:00Z",
  vaultSize: 42,
  stale: [
    {
      id: "old-css-lesson",
      title: "Old CSS lesson",
      usage: { surfaced: 9, loaded: 0, acted_on: 0, last_surfaced_at: "2026-07-01T00:00:00Z" },
      entry: {
        stale_since: "2026-06-01T00:00:00Z",
        reason: "surfaced 9× without recent engagement (last: never) — context tax",
      },
    },
  ],
  floors: [
    {
      memory_id: "migration-x-issue",
      title: "Known issue until migration X",
      reason: "active incident",
      floored_at: "2026-05-01T00:00:00Z",
      last_affirmed: "2026-05-01T00:00:00Z",
      weeksSinceAffirm: 9,
      neverReaffirmed: true,
    },
    {
      memory_id: "affirmed-floor",
      reason: "release gate",
      floored_at: "2026-05-01T00:00:00Z",
      last_affirmed: "2026-06-25T00:00:00Z",
      affirmed_by: "cowork-os",
      why: "still gating the v3 rollout",
      weeksSinceAffirm: 1,
      neverReaffirmed: false,
    },
  ],
  conflicts: [{ topicPath: ["css", "input", "focus"], memberIds: ["mem-a", "mem-b"] }],
  dangling: [{ fromId: "mem-a", target: "gone-memory" }],
};

test("all four sections render with stable anchors, in both empty and full states", () => {
  for (const data of [EMPTY, FULL]) {
    const md = renderVaultHealthReport(data);
    for (const anchor of [
      "bastra-report:start",
      "bastra-report:stale",
      "bastra-report:floors",
      "bastra-report:conflicts",
      "bastra-report:dangling",
      "bastra-report:end",
    ]) {
      assert.ok(md.includes(`<!-- ${anchor}`), `missing anchor ${anchor}`);
    }
    assert.ok(md.startsWith("<!-- bastra-report:start"));
  }
});

test("stale section: wikilink, usage numbers, stale_since and reason all visible", () => {
  const md = renderVaultHealthReport(FULL);
  assert.ok(md.includes("[[old-css-lesson]] — Old CSS lesson"));
  assert.ok(md.includes("surfaced 9× · loaded 0× · acted_on 0×"));
  assert.ok(md.includes("stale since 2026-06-01"));
  assert.ok(md.includes("score-only"), "must explain the demotion semantics");
});

test("floor section: never-re-affirmed is called out; an affirmed floor shows by/why (the #142 gardener read)", () => {
  const md = renderVaultHealthReport(FULL);
  assert.ok(md.includes("**never re-affirmed** (9 weeks)"));
  assert.ok(md.includes("last affirmed 2026-06-25 (1 weeks ago) by cowork-os"));
  assert.ok(md.includes("why: still gating the v3 rollout"));
  assert.ok(md.includes("never deleted"), "must state drop-to-ranked, never delete");
});

test("conflicts + dangling render as review items with wikilinks", () => {
  const md = renderVaultHealthReport(FULL);
  assert.ok(md.includes("`css / input / focus`: [[mem-a]] · [[mem-b]]"));
  assert.ok(md.includes("[[mem-a]] → `[[gone-memory]]` (missing)"));
});

test("deterministic: identical data renders byte-identical output (stable re-runs)", () => {
  assert.equal(renderVaultHealthReport(FULL), renderVaultHealthReport(FULL));
});

test("empty-files section: lists paths with delete guidance; empty state is quiet", () => {
  const withEmpty = renderVaultHealthReport({ ...FULL, emptyFiles: ["doc-inbox-photo-x-jpg.md"] });
  assert.ok(withEmpty.includes("<!-- bastra-report:empty-files -->"));
  assert.ok(withEmpty.includes("`doc-inbox-photo-x-jpg.md`"));
  assert.ok(withEmpty.includes("safe to delete"));
  assert.ok(renderVaultHealthReport(EMPTY).includes("No 0-byte `.md` files"));
});

test("writer: REPORT.md lands atomically in the vault root and is overwritten in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-report-"));
  try {
    assert.equal(await writeVaultHealthReport(root, EMPTY), true);
    const first = await readFile(join(root, REPORT_FILENAME), "utf8");
    assert.ok(first.includes("42 active memories"));
    assert.equal(await writeVaultHealthReport(root, { ...FULL, vaultSize: 43 }), true);
    const second = await readFile(join(root, REPORT_FILENAME), "utf8");
    assert.ok(second.includes("43 active memories"));
    assert.ok(second.includes("[[old-css-lesson]]"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writer never throws on an unwritable target", async () => {
  assert.equal(await writeVaultHealthReport("/nonexistent/nope", EMPTY), false);
});
