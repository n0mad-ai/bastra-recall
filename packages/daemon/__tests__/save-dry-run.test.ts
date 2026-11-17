/**
 * #1484 — what a `dry_run` save reports: the rule state, the claim gate and
 * the conflict diversion as the real save would produce them, without the
 * success marker and without feeding the failed-save streak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import {
  resetSaveFailures,
  saveMemoryHandler,
  SAVE_FAILURE_CAP,
  type SaveMemoryResult,
} from "../src/save-memory-handler.js";
import { dispatchApi } from "../src/http-api-routes.js";
import { TRUSTED_LOCAL_APP } from "../src/private-access.js";
import type { ClaimGateResult } from "../src/claim-gate.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import type { ToolDeps } from "../src/tool-deps.js";

async function fixture(t: { after: (fn: () => unknown) => void }) {
  resetAuditLogCache();
  resetSaveFailures();
  const vaultRoot = await mkdtemp(join(tmpdir(), "bastra-1484-"));
  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: vaultRoot };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    resetAuditLogCache();
    resetSaveFailures();
    await rm(vaultRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { deps, vault };
}

const memo = (title: string, over: Record<string, unknown> = {}) => ({
  title,
  type: "project-fact",
  summary: `Zusammenfassung für ${title}`,
  body: `Inhalt von ${title}.`,
  topic_path: ["deploy"],
  tags: ["deploy"],
  scope: "gateproj",
  recall_when: [`Situation für ${title}`],
  ...over,
});

test("a dry_run of a rule declaration names the rule state it would get", async (t) => {
  const { deps } = await fixture(t);
  const preview = (await saveMemoryHandler(
    deps,
    memo("Smoke test before tagging", {
      type: "lesson",
      rulebook: "on-demand",
      applies_when: "Before tagging a release.",
      write_origin: "user-directed",
      dry_run: true,
    })
  )) as SaveMemoryResult;
  assert.equal(preview.dry_run, true);
  assert.match(preview.delivery ?? "", /^rule \(on-demand\): active now/);
  assert.match(preview.content ?? "", /rulebook: on-demand/);
  assert.ok(preview.save_quality, "the advisory is part of the preview");
  assert.match(preview.note ?? "", /^Preview only/);
});

test("a dry_run held at the claim gate says so and stays a preview", async (t) => {
  const { deps } = await fixture(t);
  await saveMemoryHandler(
    deps,
    memo("Staging-Deploy Ablauf", { recall_when: ["das Deployment der Staging-Umgebung vorbereiten"] })
  );
  const held = (await saveMemoryHandler(
    deps,
    memo("Staging-Deploy Zweitnotiz", { recall_when: ["Deployment der Staging-Umgebung"], dry_run: true })
  )) as ClaimGateResult & { dry_run?: true };
  assert.equal(held.dry_run, true);
  assert.equal(held.claim_gate.claimed[0]?.id, "staging-deploy-ablauf");
  assert.match(held.note, /^Preview only .*NOTHING WAS SAVED/s);
});

test("a dry_run with conflict_with shows the block and leaves the existing memory alone", async (t) => {
  const { deps, vault } = await fixture(t);
  const target = (await saveMemoryHandler(deps, memo("Port of the API"))) as SaveMemoryResult;
  const before = await readFile(target.file_path, "utf8");
  const preview = (await saveMemoryHandler(
    deps,
    memo("Port of the API, new", { summary: "The API listens on 8081.", conflict_with: target.id, dry_run: true })
  )) as SaveMemoryResult;
  assert.equal(preview.id, target.id);
  assert.equal(preview.dry_run, true);
  assert.match(preview.conflict_block ?? "", /The API listens on 8081/);
  assert.equal(await readFile(target.file_path, "utf8"), before);
  assert.equal(vault.get("port-of-the-api-new"), undefined);
});

test("refused dry runs do not count towards the failed-save streak", async (t) => {
  const { deps } = await fixture(t);
  await saveMemoryHandler(deps, memo("Existing"));
  for (let i = 0; i < SAVE_FAILURE_CAP + 1; i++) {
    await assert.rejects(
      saveMemoryHandler(deps, memo("Existing", { recall_when: ["a trigger of its own"], dry_run: true })),
      /memory already exists/
    );
  }
  // A real attempt still gets the ordinary error, not the terminal STOP.
  await assert.rejects(
    saveMemoryHandler(deps, memo("Existing", { recall_when: ["a trigger of its own"] })),
    (err: Error) => !/STOP retrying/.test(err.message)
  );
});

test("a non-boolean dry_run is refused instead of being read as a real save", async (t) => {
  const { deps, vault } = await fixture(t);
  await assert.rejects(
    saveMemoryHandler(deps, memo("Typed wrong", { dry_run: "true" })),
    /dry_run must be true or false/
  );
  assert.equal(vault.get("typed-wrong"), undefined);
});

test("public conflict previews and writes treat private targets as missing", async (t) => {
  const { deps, vault } = await fixture(t);
  const target = (await saveMemoryHandler(
    deps,
    memo("Private conflict target", {
      sensitivity: "private",
      summary: "The private fixture claim",
      source: "Private fixture source",
    })
  )) as SaveMemoryResult;
  const before = await readFile(target.file_path, "utf8");
  const input = memo("Public proposed contradiction", { conflict_with: target.id });
  const ctx = { toolDeps: deps, documentWriteEnabled: false };
  const missing = new RegExp(`conflict_with: unknown memory '${target.id}'`);

  await t.test("preview", async () => {
    const result = await dispatchApi("save_memory", { ...input, dry_run: true }, ctx).catch(
      (error: Error) => error.message
    );
    assert.equal(typeof result, "string", JSON.stringify(result));
    assert.match(result as string, missing);
  });
  await t.test("real save", async () => {
    await assert.rejects(dispatchApi("save_memory", input, ctx), missing);
  });
  const owner = (await saveMemoryHandler(deps, { ...input, dry_run: true }, TRUSTED_LOCAL_APP)) as SaveMemoryResult;
  assert.match(owner.conflict_block ?? "", /The private fixture claim/);
  assert.equal(await readFile(target.file_path, "utf8"), before);
  assert.equal(vault.get(target.id)?.fm.sensitivity, "private");
});

test("public conflict previews and writes check privacy on disk when the index is stale", async (t) => {
  const { deps } = await fixture(t);
  const target = (await saveMemoryHandler(
    deps,
    memo("Newly private conflict target", { sensitivity: "team" })
  )) as SaveMemoryResult;
  const original = await readFile(target.file_path, "utf8");
  const privateBytes = original.replace("sensitivity: team", "sensitivity: private");
  assert.notEqual(original, privateBytes);
  await writeFile(target.file_path, privateBytes);
  assert.equal(deps.vault.get(target.id)?.fm.sensitivity, "team");
  const input = memo("Public proposed contradiction", { conflict_with: target.id });
  const ctx = { toolDeps: deps, documentWriteEnabled: false };
  const missing = new RegExp(`conflict_with: unknown memory '${target.id}'`);

  await t.test("preview", async () => {
    const result = await dispatchApi("save_memory", { ...input, dry_run: true }, ctx).catch(
      (error: Error) => error.message
    );
    assert.equal(typeof result, "string", JSON.stringify(result));
    assert.match(result as string, missing);
  });
  await t.test("real save", async () => {
    await assert.rejects(dispatchApi("save_memory", input, ctx), missing);
  });
  assert.equal(await readFile(target.file_path, "utf8"), privateBytes);
});
