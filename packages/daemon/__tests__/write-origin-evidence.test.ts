/**
 * #1496 — a `write_origin: user-directed` save records where the instruction
 * arrived: transport, client, session and time, taken from the tool call's
 * transport. Shown in the receipt, stored in the frontmatter (and with it in
 * the audit entry's after-image). No approval step; nothing is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { resetSaveFailures, saveMemoryHandler, type SaveMemoryResult } from "../src/save-memory-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { writeCallerStore, type WriteCaller } from "../src/caller-session.js";
import { listRulesHandler } from "../src/rulebook-catalog.js";
import type { ToolDeps } from "../src/tool-deps.js";

async function fixture(t: { after: (fn: () => unknown) => void }) {
  resetAuditLogCache();
  resetSaveFailures();
  const dir = await mkdtemp(join(tmpdir(), "bastra-1496-"));
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
  return { deps, dir };
}

const CALLER: WriteCaller = { transport: "forwarder", client: "claude-code/2.1.0", session: "sess-1496" };
const inCall = <T>(fn: () => Promise<T>, caller: WriteCaller = CALLER): Promise<T> => writeCallerStore.run(caller, fn);

const memo = (extra: Record<string, unknown> = {}) => ({
  title: "Tag releases only from main",
  type: "workflow",
  summary: "Release tags are cut from main only.",
  body: "The user said: tag releases only from main.",
  topic_path: ["release"],
  tags: ["release-tags"],
  scope: "ops",
  recall_when: ["cutting a release tag"],
  ...extra,
});

const storedEvidence = async (file: string) => matter(await readFile(file, "utf8")).data.write_origin_evidence;

test("a user-directed save stores and shows the transport evidence of its call", async (t) => {
  const { deps, dir } = await fixture(t);
  const result = (await inCall(() =>
    saveMemoryHandler(deps, memo({ write_origin: "user-directed" }))
  )) as SaveMemoryResult;

  assert.equal(result.write_origin_evidence?.transport, "forwarder");
  assert.equal(result.write_origin_evidence?.client, "claude-code/2.1.0");
  assert.equal(result.write_origin_evidence?.session, "sess-1496");
  assert.ok(!Number.isNaN(Date.parse(result.write_origin_evidence?.at ?? "")));
  assert.deepEqual(await storedEvidence(result.file_path), result.write_origin_evidence);

  const audit = (await readFile(join(dir, ".bastra", "audit-log.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const entry = audit.find((e) => e.memory_id === result.id);
  assert.equal(entry?.caller_session, "sess-1496");
  assert.deepEqual((entry?.diff_after as Record<string, unknown>).write_origin_evidence, result.write_origin_evidence);
});

test("the caller cannot write its own evidence; an agent-session save carries none", async (t) => {
  const { deps } = await fixture(t);
  const forged = { transport: "stdio", client: "me", session: "fake", at: "2020-01-01T00:00:00.000Z" };
  const outside = (await saveMemoryHandler(
    deps,
    memo({ write_origin: "user-directed", write_origin_evidence: forged })
  )) as SaveMemoryResult;
  assert.equal(outside.write_origin_evidence, undefined, "no tool call, no transport, no evidence");
  assert.equal(await storedEvidence(outside.file_path), undefined);

  const agent = (await inCall(() =>
    saveMemoryHandler(deps, memo({ title: "Agent note", recall_when: ["noting an agent observation"] }))
  )) as SaveMemoryResult;
  assert.equal(agent.write_origin_evidence, undefined);
});

test("an overwrite keeps the evidence while the origin is inherited and drops it when the origin changes", async (t) => {
  const { deps } = await fixture(t);
  const first = (await inCall(() =>
    saveMemoryHandler(deps, memo({ write_origin: "user-directed" }))
  )) as SaveMemoryResult;

  const refreshed = (await inCall(
    () =>
      saveMemoryHandler(
        deps,
        memo({ summary: "Release tags are cut from main, never from a branch.", overwrite: true })
      ),
    { transport: "stdio", client: "other/1.0", session: null }
  )) as SaveMemoryResult;
  assert.deepEqual(
    refreshed.write_origin_evidence,
    first.write_origin_evidence,
    "inherited origin, inherited evidence"
  );

  const demoted = (await inCall(() =>
    saveMemoryHandler(deps, memo({ write_origin: "agent-session", overwrite: true }))
  )) as SaveMemoryResult;
  assert.equal(demoted.write_origin_evidence, undefined);
  assert.equal(await storedEvidence(demoted.file_path), undefined);
});

test("list_rules shows the evidence of a user-directed rule", async (t) => {
  const { deps } = await fixture(t);
  const saved = (await inCall(() =>
    saveMemoryHandler(
      deps,
      memo({ write_origin: "user-directed", rulebook: "on-demand", applies_when: "Before cutting a release tag." })
    )
  )) as SaveMemoryResult;
  const page = await listRulesHandler(deps, {}, { project: "ops" });
  const row = page.rules.find((rule) => rule.id === saved.id) as { write_origin_evidence?: unknown } | undefined;
  assert.ok(row, "the rule is listed");
  assert.deepEqual(row.write_origin_evidence, saved.write_origin_evidence);
});
