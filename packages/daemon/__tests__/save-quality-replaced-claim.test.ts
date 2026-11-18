/**
 * #643 — a save that re-asserts a claim that was already replaced gets an
 * advisory naming the successor. Advisory only: the save still lands. Passing
 * `replaces: <successor>` is the explicit answer and silences it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { resetSaveFailures, saveMemoryHandler, type SaveMemoryResult } from "../src/save-memory-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { editMemoryHandler, type EditMemoryResult } from "../src/edit-memory-handler.js";
import type { ToolDeps } from "../src/tool-deps.js";

async function fixture(t: { after: (fn: () => unknown) => void }) {
  resetAuditLogCache();
  resetSaveFailures();
  const dir = await mkdtemp(join(tmpdir(), "bastra-643-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    resetAuditLogCache();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return deps;
}

const memo = (title: string, summary: string, trigger: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "project-fact",
  summary,
  body: `${summary} Measured on the staging cluster.`,
  topic_path: ["ingest", "worker"],
  tags: ["ingest-worker", "batch-size"],
  scope: "ingest",
  recall_when: [trigger],
  ...extra,
});

const OLD = "The ingest worker batch size is 500 records per flush.";
const NEW = "The ingest worker batch size is 800 records per flush.";

async function correctedVault(deps: ToolDeps): Promise<void> {
  await saveMemoryHandler(deps, memo("Ingest worker batch size", OLD, "tuning the ingest worker flush"));
  await saveMemoryHandler(
    deps,
    memo("Ingest worker batch size 2", NEW, "changing the ingest worker batch size", {
      replaces: "ingest-worker-batch-size",
    })
  );
  assert.equal(deps.vault.get("ingest-worker-batch-size")?.fm.superseded_by, "ingest-worker-batch-size-2");
}

const replacedIssue = (r: SaveMemoryResult) =>
  (r.save_quality?.issues ?? []).find((issue) => issue.startsWith("re-asserts a replaced claim"));

test("re-saving the replaced claim names the successor and still saves", async (t) => {
  const deps = await fixture(t);
  await correctedVault(deps);
  const result = (await saveMemoryHandler(
    deps,
    memo("Ingest worker batch size again", OLD, "sizing a flush of the ingest worker")
  )) as SaveMemoryResult;
  assert.equal(result.created, true, "advisory only — the save lands");
  assert.match(
    replacedIssue(result) ?? "",
    /ingest-worker-batch-size \(similarity [\d.]+\) was superseded by ingest-worker-batch-size-2/
  );
  assert.ok(result.save_quality?.suggestions.some((s) => s.includes("replaces: 'ingest-worker-batch-size-2'")));
});

test("replaces: <successor> is the explicit answer and silences the advisory", async (t) => {
  const deps = await fixture(t);
  await correctedVault(deps);
  const result = (await saveMemoryHandler(
    deps,
    memo("Ingest worker batch size again", OLD, "sizing a flush of the ingest worker", {
      replaces: "ingest-worker-batch-size-2",
      dry_run: true,
    })
  )) as SaveMemoryResult;
  assert.equal(replacedIssue(result), undefined);
});

test("editing the successor itself gets no replaced-claim advisory", async (t) => {
  const deps = await fixture(t);
  await correctedVault(deps);
  const result = await editMemoryHandler(deps, { id: "ingest-worker-batch-size-2", append: "Checked again." });
  assert.equal(
    (result as EditMemoryResult).save_quality.issues.find((i) => i.startsWith("re-asserts a replaced claim")),
    undefined,
    "the successor is the correction, not a re-assertion of what it replaced"
  );
});

test("in a chain of three the advice names the current version, not the direct successor", async (t) => {
  const deps = await fixture(t);
  await correctedVault(deps);
  await saveMemoryHandler(
    deps,
    memo(
      "Ingest worker batch size 3",
      "The ingest worker batch size is 1000 records per flush.",
      "raising the ingest worker batch",
      {
        replaces: "ingest-worker-batch-size-2",
      }
    )
  );
  const result = (await saveMemoryHandler(
    deps,
    memo("Ingest worker batch size again", OLD, "sizing a flush of the ingest worker", { dry_run: true })
  )) as SaveMemoryResult;
  assert.match(replacedIssue(result) ?? "", /\(current version: ingest-worker-batch-size-3\)$/);
  // `replaces: <direct successor>` would fork the chain beside version 3.
  assert.ok(result.save_quality?.suggestions.some((s) => s.includes("replaces: 'ingest-worker-batch-size-3'")));
});

test("an unrelated save gets no replaced-claim advisory", async (t) => {
  const deps = await fixture(t);
  await correctedVault(deps);
  const result = (await saveMemoryHandler(
    deps,
    memo("Export job schedule", "The nightly export job starts at 02:00.", "scheduling the nightly export", {
      tags: ["export-job"],
      topic_path: ["export"],
      dry_run: true,
    })
  )) as SaveMemoryResult;
  assert.equal(replacedIssue(result), undefined);
});
