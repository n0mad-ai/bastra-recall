/**
 * #1484 — `save_memory` with `dry_run: true` is a preview. It applies the same
 * redaction and checks as the real save and writes nothing: no memory file, no
 * index entry, no audit entry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type SaveMemoryResult } from "../src/save-memory-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import type { ToolDeps } from "../src/tool-deps.js";

const GITHUB_TOKEN = ["gh", "p_", "a1B2c3D4e5F6", "g7H8i9J0k1L2", "m3N4o5P6q7R8"].join("");

async function fixture(t: { after: (fn: () => unknown) => void }) {
  resetAuditLogCache();
  const vaultRoot = await mkdtemp(join(tmpdir(), "bastra-1484-inv-"));
  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: vaultRoot };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    resetAuditLogCache();
    await rm(vaultRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { deps, vault, vaultRoot };
}

/** Every file under the vault root with its bytes — locks and audit log included. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    out.set(relative(root, file), await readFile(file, "utf8"));
  }
  return out;
}

const memory = (over: Record<string, unknown> = {}) => ({
  title: "Release checklist",
  type: "lesson",
  summary: "The release runs the smoke test first.",
  body: "Run the smoke test before tagging.\n",
  topic_path: ["ops", "release"],
  tags: ["release"],
  scope: "ops",
  recall_when: ["preparing a release tag"],
  ...over,
});

test("INV-VAULT-10: a dry_run create writes no file, no index entry and no audit entry", async (t) => {
  const { deps, vault, vaultRoot } = await fixture(t);
  const before = await snapshot(vaultRoot);

  const preview = (await saveMemoryHandler(
    deps,
    memory({ body: `Export GITHUB_TOKEN=${GITHUB_TOKEN} first.\n`, dry_run: true })
  )) as SaveMemoryResult;

  assert.equal(preview.dry_run, true);
  assert.equal(preview.created, true);
  assert.deepEqual(await snapshot(vaultRoot), before, "the vault directory must be byte-identical");
  assert.equal(vault.get(preview.id), undefined, "nothing may reach the index");
  // Same redaction as the real save: the preview shows what would be stored.
  assert.ok(preview.content?.includes("[REDACTED]"), preview.content);
  assert.ok(!preview.content?.includes(GITHUB_TOKEN));
  assert.deepEqual(preview.secrets_redacted, { body: 1 });
  assert.doesNotMatch(preview.note ?? "", /Save complete/);
});

test("INV-VAULT-10: a dry_run overwrite leaves the stored memory byte for byte unchanged", async (t) => {
  const { deps, vault, vaultRoot } = await fixture(t);
  const saved = (await saveMemoryHandler(deps, memory())) as SaveMemoryResult;
  const before = await snapshot(vaultRoot);

  const preview = (await saveMemoryHandler(
    deps,
    memory({ summary: "The release runs the smoke test and the changelog check.", overwrite: true, dry_run: true })
  )) as SaveMemoryResult;

  assert.equal(preview.created, false);
  assert.equal(preview.file_path, saved.file_path);
  assert.match(preview.content ?? "", /changelog check/);
  assert.deepEqual(await snapshot(vaultRoot), before);
  assert.equal(vault.get(saved.id)?.fm.summary, "The release runs the smoke test first.");
});

test("INV-VAULT-10: a dry_run is refused exactly where the real save is refused", async (t) => {
  const { deps } = await fixture(t);
  await saveMemoryHandler(deps, memory());
  // Same id, a trigger of its own (an identical one would be held at the claim gate first).
  const again = memory({ recall_when: ["auditing the changelog wording"], dry_run: true });
  await assert.rejects(saveMemoryHandler(deps, again), /memory already exists/);
  await assert.rejects(saveMemoryHandler(deps, { ...again, dry_run: false }), /memory already exists/);
  await assert.rejects(
    saveMemoryHandler(
      deps,
      memory({ title: "Other", recall_when: ["rotating the signing key"], replaces: "no-such-memory", dry_run: true })
    ),
    /replaces: unknown memory/
  );
});

test("INV-VAULT-10: a dry_run refuses a vault root that disappeared", async (t) => {
  const { deps, vaultRoot } = await fixture(t);
  const moved = `${vaultRoot}-offline`;
  await rename(vaultRoot, moved);
  try {
    const before = await snapshot(moved);
    const errors = await Promise.allSettled([
      saveMemoryHandler(deps, memory({ dry_run: true })),
      saveMemoryHandler(deps, memory()),
    ]);
    assert.deepEqual(
      errors.map((result) => (result.status === "rejected" ? result.reason.code : "fulfilled")),
      ["VAULT_MISSING", "VAULT_MISSING"]
    );
    await assert.rejects(readdir(vaultRoot), { code: "ENOENT" });
    assert.deepEqual(await snapshot(moved), before);
  } finally {
    await rename(moved, vaultRoot);
  }
});
