import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { buildHealthPayload } from "../src/http-health.js";
import { recallHandler, saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { vaultLocator } from "../src/vault-locator.js";
import { Telemetry } from "../src/telemetry.js";
import { assembleHookRecallPayload } from "../src/hook-recall-payload.js";
import { projectRecallResult, mergeBatchResults } from "../src/recall-batch.js";

test("cloud-only synthetic fixture remains visible through cached save, health and MCP recall (#1242)", async t => {
  const root = await mkdtemp(join(tmpdir(), "bastra-invented-cloud-visible-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "invented.md");
  await writeFile(file, "invented fixture only");
  const original = fs.readFile;
  t.mock.method(fs, "readFile", async (...args: any[]) => {
    if (String(args[0]) === file) throw Object.assign(new Error("Unknown system error -11"), { code: "EDEADLK", errno: -11 });
    return (original as any)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const vault = new Vault(root);
  await vault.init();
  const search = new SearchIndex(vault); search.start();
  t.after(async () => { search.stop(); await vault.stop(); });
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: root };
  assert.deepEqual(vaultLocator(vault).locate("invented"), { kind: "incomplete", unreadable: [file], cloudOnly: [file] });
  await assert.rejects(saveMemoryHandler(deps, {
    id: "invented", title: "Invented fixture", type: "lesson", summary: "Invented cloud test", body: "Invented test body only.",
    topic_path: ["test"], tags: ["test"], scope: "test", recall_when: ["invented fixture"],
  }), /1 files are only in the cloud.*available offline/);
  const expected = vault.availability();
  const health = buildHealthPayload({ vaultSize: () => 0, vaultAvailability: () => expected,
    version: "test", embedding: { on: false, source: "test" } as never, updateState: () => null });
  assert.deepEqual(health.vault_availability, expected);
  assert.deepEqual((await recallHandler(deps, { query: "invented fixture" })).vault_availability, expected);
  assert.deepEqual((await recallHandler(deps, { queries: ["invented fixture", "another subject"] })).vault_availability, expected);
  const hook = assembleHookRecallPayload({ hits: [], candidatePool: [], vault, maxTokens: 0,
    totalLatencyMs: 0, recallId: "fixture", weakResult: false, noHome: false,
    hookProject: null, hybridActiveAtRecall: false, degradedReason: undefined }).payload;
  assert.deepEqual(hook.vault_availability, expected);
  // The forwarder consumes JSON over HTTP, not the richer internal hit types.
  const wire = JSON.parse(JSON.stringify(hook));
  assert.deepEqual(projectRecallResult("fixture", wire).vault_availability, expected);
  assert.deepEqual(mergeBatchResults(["a", "b"], [wire, wire], 5).vault_availability, expected);
});
