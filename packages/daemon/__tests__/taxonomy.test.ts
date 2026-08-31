/**
 * Tests für die selbstlernende Taxonomie (#64):
 * - listConventions (#65/#66): reservierter Scope "taxonomy", obsolete raus,
 *   neueste zuerst.
 * - detectTaxonomyDrift (#67): wiederkehrendes Cluster ohne Konvention feuert,
 *   gedeckte Cluster und alte Memories bleiben still.
 * - folder-Routing + Re-Filing (#64-Enabler): save_memory mit `folder` legt
 *   die Datei dort ab; overwrite mit geändertem folder VERSCHIEBT (alte Datei
 *   in den Trash); ohne overwrite wird abgelehnt.
 *
 * Runner: `tsx --test __tests__/taxonomy.test.ts`
 * Echtes File-Vault, kein Mocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { listConventions, detectTaxonomyDrift } from "../src/taxonomy.js";

function memoryFile(opts: {
  id: string;
  title: string;
  scope: string;
  tags: string[];
  topicPath?: string[];
  updated?: string;
  obsolete?: boolean;
}): string {
  const day = opts.updated ?? new Date().toISOString().slice(0, 10);
  return [
    "---",
    `id: ${opts.id}`,
    `title: ${opts.title}`,
    "type: lesson",
    `summary: ${opts.title} summary`,
    "topic_path:",
    ...(opts.topicPath ?? ["test"]).map((s) => `  - ${s}`),
    "tags:",
    ...opts.tags.map((t) => `  - ${t}`),
    `scope: ${opts.scope}`,
    ...(opts.obsolete ? ["obsolete: true"] : []),
    "recall_when:",
    `  - ${opts.title}`,
    `created: ${day}`,
    `updated: ${day}`,
    "---",
    "",
    `Body for ${opts.title}.`,
    "",
  ].join("\n");
}

async function makeVault(files: Array<{ rel: string; content: string }>): Promise<{
  vault: Vault;
  dir: string;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-taxonomy-test-"));
  for (const f of files) {
    const p = join(dir, f.rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, f.content, "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  return {
    vault,
    dir,
    close: async () => {
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

const OLD_DAY = "2020-01-01";

// ── listConventions ──────────────────────────────────────────────────

test("listConventions: only scope taxonomy, obsolete excluded, newest first", async () => {
  const { vault, close } = await makeVault([
    { rel: "a.md", content: memoryFile({ id: "not-a-convention", title: "regular", scope: "proj", tags: ["x"] }) },
    {
      rel: "memories/taxonomy/conv-person.md",
      content: memoryFile({ id: "conv-person", title: "person convention", scope: "taxonomy", tags: ["convention", "person"] }),
    },
    {
      rel: "memories/taxonomy/conv-old.md",
      content: memoryFile({ id: "conv-old", title: "older convention", scope: "taxonomy", tags: ["convention"], updated: OLD_DAY }),
    },
    {
      rel: "memories/taxonomy/conv-dead.md",
      content: memoryFile({ id: "conv-dead", title: "retired convention", scope: "taxonomy", tags: ["convention"], obsolete: true }),
    },
  ]);
  try {
    const conventions = listConventions(vault);
    assert.deepEqual(
      conventions.map((c) => c.id),
      ["conv-person", "conv-old"],
      "taxonomy scope only, obsolete excluded, newest first",
    );
    assert.equal(typeof conventions[0].summary, "string");
  } finally {
    await close();
  }
});

// ── detectTaxonomyDrift ──────────────────────────────────────────────

test("drift: recurring tag cluster without convention fires, capped examples", async () => {
  const { vault, close } = await makeVault([
    { rel: "p1.md", content: memoryFile({ id: "p1", title: "caio", scope: "proj", tags: ["person"] }) },
    { rel: "p2.md", content: memoryFile({ id: "p2", title: "donghun", scope: "proj", tags: ["person"] }) },
    { rel: "p3.md", content: memoryFile({ id: "p3", title: "zzallirog", scope: "proj", tags: ["person"] }) },
    { rel: "x.md", content: memoryFile({ id: "x1", title: "single", scope: "proj", tags: ["solo-tag"] }) },
  ]);
  try {
    const clusters = detectTaxonomyDrift(vault);
    assert.equal(clusters.length, 1, "only the person cluster reaches the threshold");
    assert.equal(clusters[0].key, "person");
    assert.equal(clusters[0].count, 3);
    assert.ok(clusters[0].examples.length <= 3);
  } finally {
    await close();
  }
});

test("drift: a covering convention silences the cluster", async () => {
  const { vault, close } = await makeVault([
    { rel: "p1.md", content: memoryFile({ id: "p1", title: "caio", scope: "proj", tags: ["person"] }) },
    { rel: "p2.md", content: memoryFile({ id: "p2", title: "donghun", scope: "proj", tags: ["person"] }) },
    { rel: "p3.md", content: memoryFile({ id: "p3", title: "zzallirog", scope: "proj", tags: ["person"] }) },
    {
      rel: "memories/taxonomy/conv-person.md",
      content: memoryFile({ id: "conv-person", title: "person convention", scope: "taxonomy", tags: ["convention", "person"] }),
    },
  ]);
  try {
    assert.deepEqual(detectTaxonomyDrift(vault), [], "covered cluster must stay silent");
  } finally {
    await close();
  }
});

test("drift: stale memories and structural keys never cluster", async () => {
  const { vault, close } = await makeVault([
    // Alt: außerhalb des Fensters — zählt nicht.
    { rel: "o1.md", content: memoryFile({ id: "o1", title: "old1", scope: "proj", tags: ["person"], updated: OLD_DAY }) },
    { rel: "o2.md", content: memoryFile({ id: "o2", title: "old2", scope: "proj", tags: ["person"], updated: OLD_DAY }) },
    { rel: "o3.md", content: memoryFile({ id: "o3", title: "old3", scope: "proj", tags: ["person"], updated: OLD_DAY }) },
    // Frisch, aber nur strukturelle Schlüssel (scope-Name als Tag, Memory-Typ).
    { rel: "s1.md", content: memoryFile({ id: "s1", title: "s1", scope: "proj", tags: ["proj", "lesson"], topicPath: ["proj"] }) },
    { rel: "s2.md", content: memoryFile({ id: "s2", title: "s2", scope: "proj", tags: ["proj", "lesson"], topicPath: ["proj"] }) },
    { rel: "s3.md", content: memoryFile({ id: "s3", title: "s3", scope: "proj", tags: ["proj", "lesson"], topicPath: ["proj"] }) },
  ]);
  try {
    assert.deepEqual(detectTaxonomyDrift(vault), [], "stale + structural keys must not fire");
  } finally {
    await close();
  }
});

// ── folder-Routing + Re-Filing ───────────────────────────────────────

async function makeDeps(): Promise<{ deps: ToolDeps; dir: string; close: () => Promise<void> }> {
  const { vault, dir, close } = await makeVault([]);
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const deps: ToolDeps = { vault, search, telemetry, vaultPath: dir };
  return {
    deps,
    dir,
    close: async () => {
      search.stop();
      await close();
    },
  };
}

const PERSON_INPUT = {
  title: "caio ribeiro",
  type: "project-fact",
  summary: "person memo",
  body: "Handle, role, interaction log.",
  topic_path: ["people", "caio"],
  tags: ["person"],
  scope: "bastra-recall",
  recall_when: ["caio shows up"],
};

test("save_memory: folder routes the file, taxonomy scope has a reserved home", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    const a = await saveMemoryHandler(deps, { ...PERSON_INPUT, folder: "memories/people" });
    assert.equal(a.file_path, join(dir, "memories/people/caio-ribeiro.md"));

    const b = await saveMemoryHandler(deps, {
      ...PERSON_INPUT,
      title: "person convention",
      type: "workflow",
      scope: "taxonomy",
      tags: ["convention", "person"],
    });
    assert.equal(b.file_path, join(dir, "memories/taxonomy/person-convention.md"));
  } finally {
    await close();
  }
});

test("save_memory: overwrite with a changed folder MOVES (old file trashed)", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    const first = await saveMemoryHandler(deps, PERSON_INPUT);
    assert.ok(first.file_path.includes("memories/projects/bastra-recall"));

    // Ohne overwrite: Umzug wird abgelehnt.
    await assert.rejects(
      saveMemoryHandler(deps, { ...PERSON_INPUT, folder: "memories/people" }),
      /already exists/,
    );

    const moved = await saveMemoryHandler(deps, {
      ...PERSON_INPUT,
      folder: "memories/people",
      overwrite: true,
    });
    assert.equal(moved.file_path, join(dir, "memories/people/caio-ribeiro.md"));
    // Alte Datei ist weg (im Trash), neue existiert, Index zeigt auf neu.
    await assert.rejects(access(first.file_path), "old file must be gone");
    await access(join(dir, ".bastra/trash/caio-ribeiro.md"));
    assert.equal(deps.vault.get("caio-ribeiro")?.filePath, moved.file_path);
  } finally {
    await close();
  }
});

test("save_memory: overwrite WITHOUT folder keeps the file in place (no silent relocate)", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    // Memo lives deliberately in memories/people/ (set via explicit folder).
    const created = await saveMemoryHandler(deps, { ...PERSON_INPUT, folder: "memories/people" });
    assert.equal(created.file_path, join(dir, "memories/people/caio-ribeiro.md"));

    // Update WITHOUT folder (only the content changed) must NOT re-route to the
    // scope/type default (memories/projects/bastra-recall) — otherwise the memo
    // vanishes from the people/ vault and the original gets trashed.
    const updated = await saveMemoryHandler(deps, {
      ...PERSON_INPUT,
      summary: "person memo, updated",
      overwrite: true,
    });
    assert.equal(updated.file_path, created.file_path, "update stays in place");
    await access(created.file_path); // same file, still present
    await assert.rejects(
      access(join(dir, ".bastra/trash/caio-ribeiro.md")),
      "nothing should have been trashed on an in-place update",
    );
    assert.equal(deps.vault.get("caio-ribeiro")?.filePath, created.file_path);
  } finally {
    await close();
  }
});

test("save_memory: traversal folder is rejected", async () => {
  const { deps, close } = await makeDeps();
  try {
    await assert.rejects(
      saveMemoryHandler(deps, { ...PERSON_INPUT, folder: "../outside" }),
      /folder/,
    );
    await assert.rejects(
      saveMemoryHandler(deps, { ...PERSON_INPUT, folder: "/absolute" }),
      /folder/,
    );
  } finally {
    await close();
  }
});

/**
 * #360-D (Codex-Gegenreview): der Reserved-Scope-Vergleich lief exakt. Ein von
 * Hand geschriebenes `scope: Taxonomy` fiel damit still aus der
 * Session-Injektion — und wurde von der Drift-Erkennung, die dieselbe Prüfung
 * negiert, zugleich als gewöhnliches Memory behandelt.
 */
test("listConventions: reserved scope compare is case-folded", async () => {
  const { vault, close } = await makeVault([
    {
      rel: "memories/taxonomy/conv-upper.md",
      content: memoryFile({
        id: "conv-upper",
        title: "convention written by hand",
        scope: "Taxonomy",
        tags: ["convention"],
      }),
    },
  ]);
  try {
    const ids = listConventions(vault).map((c) => c.id);
    assert.deepEqual(ids, ["conv-upper"]);
  } finally {
    await close();
  }
});
