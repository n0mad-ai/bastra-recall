/**
 * archive_memory (#217 Intake-Adoption) — the closing primitive of an
 * adoption: move the intake original into the vault trash (recoverable),
 * drop it from the index, stamp the superseded_by pointer for audit.
 *
 * Runner: tsx --test __tests__/archive-memory.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { archiveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";

function intakeMemory(id: string, sensitivity?: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: Imported note ${id}`,
    "type: reference",
    "summary: An imported intake memory.",
    ...(sensitivity ? [`sensitivity: ${sensitivity}`] : []),
    "topic_path:",
    "  - imported",
    "  - testlabel",
    "tags:",
    "  - imported",
    "scope: testlabel",
    "recall_when:",
    "  - imported note",
    "created: 2026-07-01",
    "updated: 2026-07-01",
    "---",
    "",
    `Body of ${id}.`,
    "",
  ].join("\n");
}

async function makeDeps(): Promise<{ deps: ToolDeps; dir: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-archive-test-"));
  await writeFile(join(dir, "int-1.md"), intakeMemory("int-1"), "utf8");
  await writeFile(join(dir, "priv-1.md"), intakeMemory("priv-1", "private"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    dir,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("archive_memory moves the file to the vault trash and drops it from the index", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    assert.ok(deps.vault.get("int-1"), "precondition: memory indexed");
    const result = await archiveMemoryHandler(deps, { id: "int-1", superseded_by: "real-1" });

    assert.equal(result.id, "int-1");
    assert.equal(result.superseded_by, "real-1");
    assert.ok(result.archived_to.includes(join(".bastra", "trash")), "lands in the vault trash");
    await assert.rejects(stat(join(dir, "int-1.md")), "original file is gone");
    assert.equal(deps.vault.get("int-1"), undefined, "dropped from the index without waiting for a watcher");

    // Audit-Stempel: die archivierte Kopie zeigt auf ihren Nachfolger. Das
    // Lesen beweist die Existenz gleich mit — ein vorheriges stat() wäre nur
    // ein zweiter Blick auf dieselbe Datei (stat-dann-open, TOCTOU).
    const raw = await readFile(result.archived_to, "utf8");
    assert.match(raw, /superseded_by: real-1/);
    assert.match(raw, /obsolete: true/);
    assert.match(raw, /Body of int-1\./, "body survives untouched");
  } finally {
    await close();
  }
});

test("archive_memory without superseded_by keeps the file byte-comparable and errors on unknown ids", async () => {
  const { deps, close } = await makeDeps();
  try {
    const result = await archiveMemoryHandler(deps, { id: "int-1" });
    assert.equal(result.superseded_by, null);
    const raw = await readFile(result.archived_to, "utf8");
    assert.ok(!raw.includes("superseded_by"), "no stamp requested → file unmodified");

    await assert.rejects(
      archiveMemoryHandler(deps, { id: "does-not-exist" }),
      /unknown memory/,
      "unknown id is a hard error, not a silent no-op",
    );
    await assert.rejects(archiveMemoryHandler(deps, {}), /invalid archive_memory args/);
  } finally {
    await close();
  }
});

test("#464: archive_memory hides a private memory from an external caller exactly as load_memory does", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    // Ohne allow_private: dieselbe Antwort wie für eine Id, die es nicht gibt —
    // ein Caller, der nicht lesen darf, erfährt auch nicht, dass sie existiert.
    await assert.rejects(archiveMemoryHandler(deps, { id: "priv-1" }), /unknown memory: priv-1/);
    await stat(join(dir, "priv-1.md"));
    assert.ok(deps.vault.get("priv-1"), "the private memory is still in the vault");

    // Die Mac-App (allow_private: true) darf weiterhin archivieren.
    const result = await archiveMemoryHandler(deps, { id: "priv-1", allow_private: true });
    assert.equal(result.id, "priv-1");
    await assert.rejects(stat(join(dir, "priv-1.md")));
  } finally {
    await close();
  }
});
