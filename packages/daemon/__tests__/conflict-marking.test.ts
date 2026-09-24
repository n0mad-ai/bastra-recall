/**
 * #205 — conflict marking on the save path.
 *
 * A save carrying `conflict_with` is a contradiction report: nothing new is
 * created, nothing is overwritten — the existing memory gets a visible
 * plain-markdown conflict block with BOTH claims, recall flags it, and an
 * explicit overwrite resolves it. These tests pin all four acceptance
 * criteria of the issue plus the two rejection paths.
 *
 * Runner: `tsx --test __tests__/conflict-marking.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, AuditLog, CONFLICT_START } from "@bastra-recall/core";
import { saveMemoryHandler, recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";

async function makeDeps(): Promise<{ deps: ToolDeps; vaultPath: string; cleanup: () => Promise<void> }> {
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-conflict-"));
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath };
  return {
    deps,
    vaultPath,
    cleanup: async () => {
      search.stop();
      await vault.stop?.();
      await rm(vaultPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

const memo = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "project-fact",
  summary: `Zusammenfassung für ${title}`,
  body: `Inhalt von ${title}.`,
  topic_path: ["test"],
  tags: ["test"],
  scope: "testproj",
  recall_when: [`wenn ${title} gebraucht wird`],
  ...extra,
});

test("#205: the contradicting save is diverted — no sibling, no overwrite, both claims in the block", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const existing = await saveMemoryHandler(deps, memo("Server läuft auf Port 80"));
    const result = await saveMemoryHandler(
      deps,
      memo("Server läuft auf Port 443", {
        conflict_with: existing.id,
        source: "Deploy-Log 19.08.",
      }),
    );
    // #542: saveMemoryHandler returns SaveMemoryResult | ClaimGateResult; a
    // diversion into a conflict mark is never held at the claim gate, so
    // narrow away that branch before reading conflict_marked.
    assert.ok(!("claim_gate" in result), "a conflict-mark diversion is not a claim-gate hold");

    assert.equal(result.conflict_marked, true);
    assert.equal(result.created, false);
    assert.equal(result.id, existing.id, "the result names the EXISTING memory");
    assert.equal(deps.vault.get("server-lauft-auf-port-443"), undefined, "no silent sibling was created");

    const target = deps.vault.get(existing.id);
    assert.ok(target);
    const raw = await readFile(target!.filePath, "utf8");
    assert.ok(raw.includes(CONFLICT_START), "the block is in the file");
    assert.match(raw, /Inhalt von Server läuft auf Port 80/, "the original claim was not discarded");
    assert.match(raw, /Zusammenfassung für Server läuft auf Port 80/, "existing claim quoted in the block");
    assert.match(raw, /Zusammenfassung für Server läuft auf Port 443/, "incoming claim quoted in the block");
    assert.match(raw, /Inhalt von Server läuft auf Port 443/, "incoming body preserved — the diverted save is not lost");
    assert.match(raw, /Deploy-Log 19\.08\./, "incoming provenance carried");
    assert.ok(!raw.includes("<details>"), "plain markdown only — no viewer-specific syntax");
  } finally {
    await cleanup();
  }
});

test("#205: recall lean hits expose the unresolved-conflict flag — and drop it after resolution", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const existing = await saveMemoryHandler(deps, memo("Streitfall Datenbank"));
    await saveMemoryHandler(deps, memo("Streitfall Datenbank neu", { conflict_with: existing.id }));

    const res = await recallHandler(deps, { query: "Streitfall Datenbank", k: 5, min_score: 0 });
    const hit = (res.hits as Array<{ id: string; conflict?: boolean }>).find((h) => h.id === existing.id);
    assert.ok(hit, "the conflicted memory still surfaces");
    assert.equal(hit!.conflict, true, "lean hit carries conflict: true");

    // Resolution: an explicit overwrite with the winning claim removes the block.
    await saveMemoryHandler(
      deps,
      memo("Streitfall Datenbank", { overwrite: true, body: "Geklärter Stand." }),
    );
    const after = await recallHandler(deps, { query: "Streitfall Datenbank", k: 5, min_score: 0 });
    const resolved = (after.hits as Array<{ id: string; conflict?: boolean }>).find((h) => h.id === existing.id);
    assert.ok(resolved);
    assert.equal(resolved!.conflict, undefined, "the flag is gone after the deliberate overwrite");
    const raw = await readFile(deps.vault.get(existing.id)!.filePath, "utf8");
    assert.ok(!raw.includes(CONFLICT_START), "the block is gone from the file");
  } finally {
    await cleanup();
  }
});

test("#205: the diversion is recorded in the audit log — the journal sees it", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const existing = await saveMemoryHandler(deps, memo("Auditierter Konflikt"));
    await saveMemoryHandler(deps, memo("Auditierter Konflikt anders", { conflict_with: existing.id }));

    const entries = await new AuditLog(vaultPath).forMemory(existing.id);
    const marked = entries.find((e) => e.reason?.includes("conflict marked"));
    assert.ok(marked, "an update entry with the conflict reason exists");
    assert.equal(marked!.operation, "update");
  } finally {
    await cleanup();
  }
});

test("#205: conflict_with must point at something that exists — nothing written otherwise", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await assert.rejects(
      () => saveMemoryHandler(deps, memo("Zeigt ins Leere", { conflict_with: "gibt-es-nicht" })),
      /unknown memory 'gibt-es-nicht'/,
    );
    assert.equal(deps.vault.get("zeigt-ins-leere"), undefined, "the rejected save left nothing behind");
  } finally {
    await cleanup();
  }
});

test("#205: a memory cannot conflict with itself", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const first = await saveMemoryHandler(deps, memo("Selbstwiderspruch"));
    await assert.rejects(
      () => saveMemoryHandler(deps, memo("Selbstwiderspruch", { conflict_with: first.id })),
      /cannot conflict with itself/,
    );
  } finally {
    await cleanup();
  }
});
