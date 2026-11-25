/**
 * #1725: `AuditLog.record` is the one pass that redacts snapshots, so it also
 * reports what it replaced. Callers building a receipt read those counts
 * instead of redacting the same snapshots a second time. The audit line and
 * its format stay exactly as before.
 *
 * Runner: node --import tsx --test packages/core/__tests__/audit-redaction-counts.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, type AuditRedactionCounts } from "../src/audit-log.js";
import { redactSecrets } from "../src/scrub.js";

// Fictitious credentials.
const token = "sk-ant-api03-" + "A7b9C2d4E6f8G0h1".repeat(4);

test("#1725: record reports the snapshot redactions per top-level field and writes the same line", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-audit-counts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = {
    title: `Connection ${token}`,
    summary: "password=fictional-summary-42 and token=fictional-token-43",
    recall_when: [`with ${token}`, "plain", "password=fictional-trigger-44"],
    nested: { deep: `key ${token}` },
    tags: ["clean"],
    constructor: `credential ${token}`,
    ["__proto__"]: `credential ${token}`,
  };
  const after = { title: "Connection [REDACTED]", summary: "clean" };
  const counts: AuditRedactionCounts = { diff_before: {}, diff_after: {} };
  const log = new AuditLog(dir);
  const entry = await log.record(
    { memory_id: "m", actor: "import", operation: "update", diff_before: before, diff_after: after },
    counts
  );
  assert.deepEqual(counts, {
    diff_before: { title: 1, summary: 2, recall_when: 2, nested: 1, constructor: 1, ["__proto__"]: 1 },
    diff_after: {},
  });
  // The redaction itself is unchanged: every string through `redactSecrets`, nothing else touched.
  assert.deepEqual(entry.diff_before, {
    title: redactSecrets(before.title).text,
    summary: redactSecrets(before.summary).text,
    recall_when: before.recall_when.map((item) => redactSecrets(item).text),
    nested: { deep: redactSecrets(before.nested.deep).text },
    tags: ["clean"],
    constructor: redactSecrets(before.constructor).text,
    ["__proto__"]: redactSecrets(before.__proto__).text,
  });
  assert.deepEqual(entry.diff_after, after);
  const line = (await readFile(join(dir, ".bastra/audit-log.ndjson"), "utf8")).trim();
  assert.equal(line, JSON.stringify(entry), "the stored line holds no counts");

  // Without a counts object `record` behaves as before.
  const plain = await log.record({
    memory_id: "m",
    actor: "import",
    operation: "create",
    diff_before: null,
    diff_after: before,
  });
  assert.deepEqual(plain.diff_after, entry.diff_before);
});
