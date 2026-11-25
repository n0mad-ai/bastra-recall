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
import { Vault, SearchIndex, type SaveMemoryInput } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { resetSaveFailures, saveMemoryHandler, type SaveMemoryResult } from "../src/save-memory-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { editMemoryHandler, type EditMemoryResult } from "../src/edit-memory-handler.js";
import type { ToolDeps } from "../src/tool-deps.js";
import { scoreSaveQuality } from "../src/save-quality.js";

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

/** A correction that changes only the value: same title, trigger and tags. */
async function valueCorrectedVault(deps: ToolDeps): Promise<void> {
  await saveMemoryHandler(deps, memo("Ingest worker batch size", OLD, "tuning the ingest worker flush"));
  await saveMemoryHandler(
    deps,
    memo("Ingest worker batch size", NEW, "tuning the ingest worker flush", {
      id: "ingest-worker-batch-size-v2",
      replaces: "ingest-worker-batch-size",
    })
  );
  assert.equal(deps.vault.get("ingest-worker-batch-size")?.fm.superseded_by, "ingest-worker-batch-size-v2");
}

test("restating the current version after a value-only correction gets no advisory", async (t) => {
  const deps = await fixture(t);
  await valueCorrectedVault(deps);
  const result = (await saveMemoryHandler(
    deps,
    memo("Ingest worker batch size", NEW, "tuning the ingest worker flush", { id: "restated", dry_run: true })
  )) as SaveMemoryResult;
  assert.equal(replacedIssue(result), undefined);
});

test("writing the old value again after a value-only correction still warns", async (t) => {
  const deps = await fixture(t);
  await valueCorrectedVault(deps);
  const result = (await saveMemoryHandler(
    deps,
    memo("Ingest worker batch size", OLD, "tuning the ingest worker flush", { id: "reasserted", dry_run: true })
  )) as SaveMemoryResult;
  assert.match(replacedIssue(result) ?? "", /was superseded by ingest-worker-batch-size-v2/);
});

test("claim text, including a stale body under the corrected summary, controls the replacement advisory", async (t) => {
  const deps = await fixture(t);
  await valueCorrectedVault(deps);
  const check = async (summary: string, body: string) =>
    replacedIssue(
      (await saveMemoryHandler(
        deps,
        memo("Ingest worker batch size", summary, "tuning the ingest worker flush", {
          body,
          id: "mixed-claim",
          dry_run: true,
        })
      )) as SaveMemoryResult
    );

  assert.ok(await check(NEW, `${OLD} Measured on the staging cluster.`));
  assert.ok(await check(`${OLD} ${NEW}`, `${OLD} Measured on the staging cluster.`));
  assert.equal(await check(NEW, " "), undefined, "a summary-only restatement still carries the current value");
});

test("on equal content words only a verbatim copy of the current text counts as restating it", () => {
  // Single-character values drop out of the content words, so both versions tie.
  const base = memo("Ingest worker batch size", "Batch size is 5 x.", "tuning the ingest worker flush");
  const stored = (id: string, summary: string, extra: Record<string, unknown> = {}) => ({
    fm: { ...base, id, summary, sensitivity: "team", ...extra },
    body: `${summary} Measured on the staging cluster.`,
  });
  const rows = new Map([
    ["old", stored("old", "Batch size is 5 x.", { superseded_by: "new" })],
    ["new", stored("new", "Batch size is 8 x.")],
  ]);
  const deps = {
    vault: { get: (id: string) => rows.get(id), list: () => [...rows.values()] },
    search: { recall: () => [{ id: "old", title: base.title, summary: "Batch size is 5 x." }] },
  } as unknown as ToolDeps;
  const issue = (summary: string) =>
    scoreSaveQuality(
      deps,
      { ...base, summary, body: `${summary} Measured on the staging cluster.` } as SaveMemoryInput,
      "probe"
    ).issues.find((i) => i.startsWith("re-asserts a replaced claim"));
  assert.equal(issue("Batch size is 8 x."), undefined, "a verbatim copy of the current version");
  assert.ok(issue("Batch size is 5 x."), "a verbatim copy of the old version still warns");
});

test("#1728: a credential stored unredacted in the current version does not count as a changed claim", () => {
  const secret = "ghp_" + "a".repeat(36);
  const base = memo("Ingest worker batch size", NEW, "tuning the ingest worker flush");
  const stored = (id: string, summary: string, extra: Record<string, unknown> = {}) => ({
    fm: { ...base, id, summary, sensitivity: "team", ...extra },
    // written before redaction existed: the credential is still in the file
    body: `${summary} Measured on the staging cluster with token ${secret}.`,
  });
  const rows = new Map([
    ["old", stored("old", OLD, { superseded_by: "new" })],
    ["new", stored("new", NEW)],
  ]);
  const deps = {
    vault: { get: (id: string) => rows.get(id), list: () => [...rows.values()] },
    search: { recall: () => [{ id: "old", title: base.title, summary: OLD }] },
  } as unknown as ToolDeps;
  // what save_memory hands the check: its input with the credential already redacted
  const issue = (summary: string) =>
    scoreSaveQuality(
      deps,
      {
        ...base,
        summary,
        body: `${summary} Measured on the staging cluster with token [REDACTED].`,
      } as SaveMemoryInput,
      "probe"
    ).issues.find((i) => i.startsWith("re-asserts a replaced claim"));
  assert.equal(issue(NEW), undefined, "the current claim repeated, redaction aside");
  assert.ok(issue(OLD), "the replaced claim repeated still warns");
});

/** Two versions with the same title and text except for one value in the body;
 *  `issue` scores a save of the given body against them. */
function valueOnlyChange(oldValue: string, newValue: string) {
  const summary = "The ingest worker authenticates with a personal access token.";
  const base = memo("Ingest worker token", summary, "rotating the ingest worker token");
  const body = (value: string) => `${summary} The token is ${value}.`;
  const stored = (id: string, value: string, extra: Record<string, unknown> = {}) => ({
    fm: { ...base, id, sensitivity: "team", ...extra },
    body: body(value),
  });
  const rows = new Map([
    ["old", stored("old", oldValue, { superseded_by: "new" })],
    ["new", stored("new", newValue)],
  ]);
  const deps = {
    vault: { get: (id: string) => rows.get(id), list: () => [...rows.values()] },
    search: { recall: () => [{ id: "old", title: base.title, summary }] },
  } as unknown as ToolDeps;
  return (value: string) =>
    scoreSaveQuality(deps, { ...base, body: body(value) } as SaveMemoryInput, "probe").issues.find((i) =>
      i.startsWith("re-asserts a replaced claim")
    );
}

test("#1734: versions that differ only in a redacted credential value get no replaced-claim advisory", () => {
  // Obviously synthetic values in a pattern the redaction recognises; never a real key.
  const oldSecret = "ghp_" + "a".repeat(36);
  const issue = valueOnlyChange(oldSecret, "ghp_" + "b".repeat(36));
  // Plaintext credential values are never compared: after redaction both
  // versions read the same, so repeating the old value is not a replaced claim.
  assert.equal(issue(oldSecret), undefined, "the old credential value, unredacted input");
  assert.equal(issue("[REDACTED]"), undefined, "the old credential value, as save_memory hands it over");
});

test("#1734: the same value-only change without a credential still warns", () => {
  const issue = valueOnlyChange("alpha-readonly", "beta-readwrite");
  assert.ok(issue("alpha-readonly"), "the replaced non-secret value repeated");
  assert.equal(issue("beta-readwrite"), undefined, "the current value repeated");
});

/** Two versions with the same title, trigger and tags, so the metadata finds the
 *  old one for either claim; `issue` scores a save of the given summary (and the
 *  usual body) against them. */
function claimCorrected(oldSummary: string, newSummary: string, title = "Ingest worker batch size") {
  const base = memo(title, oldSummary, "tuning the ingest worker flush");
  const stored = (id: string, summary: string, extra: Record<string, unknown> = {}) => ({
    fm: { ...base, id, summary, sensitivity: "team", ...extra },
    body: `${summary} Measured on the staging cluster.`,
  });
  const rows = new Map([
    ["old", stored("old", oldSummary, { superseded_by: "new" })],
    ["new", stored("new", newSummary)],
  ]);
  const deps = {
    vault: { get: (id: string) => rows.get(id), list: () => [...rows.values()] },
    search: { recall: () => [{ id: "old", title, summary: oldSummary }] },
  } as unknown as ToolDeps;
  return (summary: string) =>
    scoreSaveQuality(
      deps,
      { ...base, summary, body: `${summary} Measured on the staging cluster.` } as SaveMemoryInput,
      "probe"
    ).issues.find((i) => i.startsWith("re-asserts a replaced claim"));
}

// #643 Run-4 measurement: a save that rewords the CURRENT claim was warned as if it
// repeated the old one (word order 1/8 de, 2/8 en; free rewording 3/8 de, 4/8 en).
const REWORDED: Array<{
  language: string;
  old: string;
  current: string;
  currentReworded: string[];
  oldReworded: string[];
}> = [
  {
    language: "en",
    old: OLD,
    current: NEW,
    currentReworded: [
      "Records per flush: 800 records is the ingest worker batch size.",
      "Each flush of the ingest worker carries a batch of 800 records.",
    ],
    oldReworded: [
      "Records per flush: 500 records is the ingest worker batch size.",
      "Each flush of the ingest worker carries a batch of 500 records.",
    ],
  },
  {
    language: "de",
    old: "Der monatliche Abschlag für Strom beträgt 85 Euro.",
    current: "Der monatliche Abschlag für Strom beträgt 112 Euro.",
    currentReworded: [
      "Für Strom beträgt 112 Euro der monatliche Abschlag.",
      "Jeden Monat werden für den Strom 112 Euro abgebucht.",
    ],
    oldReworded: [
      "Für Strom beträgt 85 Euro der monatliche Abschlag.",
      "Jeden Monat werden für den Strom 85 Euro abgebucht.",
    ],
  },
  {
    // written without spaces: nothing may depend on word boundaries
    language: "zh",
    old: "摄取工作进程每次刷新处理五百条记录。",
    current: "摄取工作进程每次刷新处理八百条记录。",
    currentReworded: ["每次刷新时摄取工作进程处理八百条记录。", "八百条记录是摄取工作进程每次刷新的批量。"],
    oldReworded: ["每次刷新时摄取工作进程处理五百条记录。", "五百条记录是摄取工作进程每次刷新的批量。"],
  },
];

for (const c of REWORDED) {
  test(`#643 (${c.language}): rewording the current claim gets no replaced-claim advisory`, () => {
    const issue = claimCorrected(c.old, c.current);
    for (const summary of c.currentReworded) assert.equal(issue(summary), undefined, summary);
  });

  test(`#643 (${c.language}): repeating or rewording the old claim still warns`, () => {
    const issue = claimCorrected(c.old, c.current);
    assert.ok(issue(c.old), "the old claim verbatim");
    for (const summary of c.oldReworded) assert.ok(issue(summary), summary);
  });
}

test("#643: a save that holds as much of the old claim as of the current one still warns", () => {
  const issue = claimCorrected(OLD, NEW);
  assert.ok(issue(`${OLD} ${NEW}`), "both values: a tie keeps the advisory");
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

for (const privateId of ["private-middle", "private-current"]) {
  test(`a public replacement advisory does not traverse the private node ${privateId}`, () => {
    const input = memo("Ingest worker batch size", OLD, "tuning the ingest worker flush") as SaveMemoryInput;
    const memory = (id: string, extra: Record<string, unknown> = {}) => ({
      fm: { ...input, id, sensitivity: id === privateId ? "private" : "team", ...extra },
      body: input.body,
    });
    const rows = new Map([
      ["public-old", memory("public-old", { superseded_by: "private-middle" })],
      ["private-middle", memory("private-middle", { superseded_by: "private-current" })],
      ["private-current", memory("private-current")],
    ]);
    const deps = {
      vault: { get: (id: string) => rows.get(id), list: () => [...rows.values()] },
      search: {
        recall: (_query: string, options: { allow_private?: boolean }) => {
          assert.equal(options.allow_private, false);
          return [{ id: "public-old", title: input.title, summary: input.summary }];
        },
      },
    } as unknown as ToolDeps;
    const result = scoreSaveQuality(deps, input, "new-save");
    assert.equal(
      result.issues.find((issue) => issue.startsWith("re-asserts a replaced claim")),
      undefined
    );
    assert.ok(
      !JSON.stringify(result).includes(privateId),
      "private successor IDs stay out of every public result field"
    );
  });
}
