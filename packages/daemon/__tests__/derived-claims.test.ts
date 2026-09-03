/** #467: claim values are derived at load time and stay out of the memory file. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchIndex, Vault } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { loadMemoryHandler, saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";

async function makeDeps(): Promise<{ deps: ToolDeps; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-derived-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    cleanup: async () => {
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

const claim = {
  id: "failure-modes.total",
  resolver: "count.markdown-numbered-list.v1" as const,
  source: "sources/failure-modes.md",
  case_ref: "harness://case/derived-count-stays-a-formula",
};

const fact = (extra: Record<string, unknown> = {}) => ({
  title: "Failure modes are counted when read",
  type: "project-fact",
  summary: "The number of failure modes is derived from its source list.",
  body: "The count is not stored in this memory.",
  topic_path: ["bastra"],
  tags: ["claims"],
  scope: "derivedtest",
  recall_when: ["when the failure mode count is needed"],
  ...extra,
});

test("#467: load derives a numbered-list count and leaves the memory file as it is", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await mkdir(join(deps.vaultPath, "sources"));
    await writeFile(join(deps.vaultPath, claim.source), "# modes\n\n1. first\n2) second\n3. third\n", "utf8");
    const saved = await saveMemoryHandler(deps, fact({ derived_claims: [claim] }));
    const before = await readFile(deps.vault.get(saved.id)!.filePath, "utf8");

    const loaded = await loadMemoryHandler(deps, { id: saved.id });

    assert.deepEqual(loaded.derived?.claims, [{ ...claim, status: "observed", value: 3 }]);
    assert.deepEqual(loaded.frontmatter.derived_claims, [claim], "lean callers receive the formula");
    assert.equal(await readFile(deps.vault.get(saved.id)!.filePath, "utf8"), before, "the note keeps its own bytes");
  } finally {
    await cleanup();
  }
});

test("#467: a vault-relative symlink that leads outside the vault is reported unverifiable", async () => {
  const { deps, cleanup } = await makeDeps();
  const outside = join(tmpdir(), `bastra-derived-outside-${process.pid}.md`);
  try {
    await mkdir(join(deps.vaultPath, "sources"));
    await writeFile(outside, "1. secret-shaped line\n", "utf8");
    await symlink(outside, join(deps.vaultPath, claim.source));
    const saved = await saveMemoryHandler(deps, fact({ derived_claims: [claim] }));

    const loaded = await loadMemoryHandler(deps, { id: saved.id });

    assert.deepEqual(loaded.derived?.claims, [{ ...claim, status: "unverifiable", reason: "outside_vault" }]);
  } finally {
    await rm(outside, { force: true });
    await cleanup();
  }
});

test("#467: a traversal source is refused at save, before any resolver runs", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await assert.rejects(
      () => saveMemoryHandler(deps, fact({ derived_claims: [{ ...claim, source: "../outside.md" }] })),
      /source must be a vault-relative path/,
    );
  } finally {
    await cleanup();
  }
});
