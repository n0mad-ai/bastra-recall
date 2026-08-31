/**
 * Tests für das Produkt-Doku-Feature (docs.mode):
 *
 * - saveProductDocHandler: legt dokumentationen/<project>/doku-<project>-<area>.md
 *   an, update-in-place bei zweitem Call (stabile id, ein File pro Bereich),
 *   path-safety auf project, Auffindbarkeit über den Index (type=doc).
 * - formatDokuBlock: suggest- vs auto-Anweisung, Sprache + Projekt im Text.
 * - appendProductDocHint (stop-hook): hängt den Doku-Hinweis nur bei
 *   docs.mode != off und nur an die feature-completion-Suggestion.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/product-docs.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import type { ToolDeps } from "../src/tool-handlers.js";
import { saveProductDocHandler } from "../src/product-doc-handler.js";
import { renameArea } from "../src/webui-areas.js";
import { formatDokuBlock } from "../src/doku-block.js";
import { appendProductDocHint, type SaveSuggestion } from "../src/stop-lane.js";

async function makeDeps(): Promise<{ deps: ToolDeps; dir: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-product-docs-"));
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

test("save_product_doc: creates the doc under dokumentationen/<project>/", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    const result = await saveProductDocHandler(deps, {
      project: "bastra",
      area: "User Guide",
      title: "Bastra — User-Guide",
      summary: "How to use the Bastra window mode.",
      body: "# User-Guide\n\nSo benutzt du die App.",
    });
    assert.equal(result.id, "doku-bastra-user-guide");
    assert.equal(result.created, true);
    assert.equal(result.updated, false);
    assert.equal(result.file_path, join(dir, "dokumentationen", "bastra", "doku-bastra-user-guide.md"));
    const content = await readFile(result.file_path, "utf8");
    assert.match(content, /type: doc/);
    assert.match(content, /So benutzt du die App/);

    // Auffindbar über die doc-Lane (find_document filtert type=doc).
    const hits = deps.search.recall("Bastra User-Guide", { type: "doc" });
    assert.equal(hits[0]?.id, "doku-bastra-user-guide");
  } finally {
    await close();
  }
});

test("save_product_doc: second call replaces in place — one file per area", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    const first = await saveProductDocHandler(deps, {
      project: "bastra",
      area: "recall-tab",
      title: "Bastra — Recall-Tab",
      summary: "Search across the vault.",
      body: "v1 body",
    });
    const second = await saveProductDocHandler(deps, {
      project: "bastra",
      area: "recall-tab",
      title: "Bastra — Recall-Tab",
      summary: "Search across the vault, now with pills.",
      body: "v2 body — replaces v1",
    });
    assert.equal(second.id, first.id);
    assert.equal(second.created, false);
    assert.equal(second.updated, true);

    const files = await readdir(join(dir, "dokumentationen", "bastra"));
    assert.deepEqual(files, ["doku-bastra-recall-tab.md"]);
    const content = await readFile(second.file_path, "utf8");
    assert.match(content, /v2 body — replaces v1/);
    assert.doesNotMatch(content, /v1 body/);
  } finally {
    await close();
  }
});

test("save_product_doc: rejects a path-escaping project", async () => {
  const { deps, close } = await makeDeps();
  try {
    await assert.rejects(
      saveProductDocHandler(deps, {
        project: "../escape",
        area: "x",
        title: "t",
        summary: "s",
        body: "b",
      }),
      /project/,
    );
  } finally {
    await close();
  }
});

test("formatDokuBlock: suggest proposes first, auto writes autonomously", () => {
  const suggest = formatDokuBlock("suggest", "de", "carnexus");
  assert.match(suggest, /<bastra-product-docs mode="suggest">/);
  assert.match(suggest, /save_product_doc/);
  assert.match(suggest, /dokumentationen\/carnexus\//);
  assert.match(suggest, /language "de"/);
  assert.match(suggest, /propose the doc update to the user first/);

  const auto = formatDokuBlock("auto", "en", "carnexus");
  assert.match(auto, /mode="auto"/);
  assert.match(auto, /update the doc autonomously/);
});

test("appendProductDocHint: only fires on feature-completion and only when on", () => {
  const fresh = (): SaveSuggestion[] => [
    { heuristic: "frustration-density", title: "f", type: "lesson", body: "frust." },
    { heuristic: "feature-completion", title: "fc", type: "project-fact", body: "commit landed." },
  ];

  const off = fresh();
  appendProductDocHint(off, "off");
  assert.equal(off[1].body, "commit landed.");

  const suggest = fresh();
  appendProductDocHint(suggest, "suggest");
  assert.match(suggest[1].body, /save_product_doc/);
  assert.match(suggest[1].body, /propose to the user first/);
  assert.equal(suggest[0].body, "frust.", "non-feature suggestions stay untouched");

  const auto = fresh();
  appendProductDocHint(auto, "auto");
  assert.match(auto[1].body, /docs\.mode=auto/);
  assert.doesNotMatch(auto[1].body, /propose to the user first/);
});

/**
 * #360-Folgefund D (Codex-Gegenreview): der Handler baute id, Ordner, Scope,
 * topic_path und Tags aus dem ROHEN `project`. Zwei Schreibweisen desselben
 * Projekts ergaben zwei logische Docs auf einer Datei — und der Scope im
 * Frontmatter passte nicht zum Ordner, in dem das Doc lag.
 */
test("save_product_doc: project casing is canonical in id, folder and scope", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    const first = await saveProductDocHandler(deps, {
      project: "CarNexus",
      area: "Recall-Ansicht",
      title: "Recall-Ansicht",
      summary: "s",
      body: "# Erste Fassung\n",
    });
    assert.equal(first.id, "doku-carnexus-recall-ansicht");
    assert.equal(first.created, true);
    const shelves = await readdir(join(dir, "dokumentationen"));
    assert.deepEqual(shelves, ["carnexus"]); // genau EIN Regal, klein
    const raw = await readFile(
      join(dir, "dokumentationen", "carnexus", "doku-carnexus-recall-ansicht.md"),
      "utf8",
    );
    assert.match(raw, /^scope: carnexus$/m);

    // Zweiter Call mit anderer Schreibweise: dasselbe Dokument, kein zweites.
    const second = await saveProductDocHandler(deps, {
      project: "carnexus",
      area: "Recall-Ansicht",
      title: "Recall-Ansicht",
      summary: "s",
      body: "# Zweite Fassung\n",
    });
    assert.equal(second.id, first.id);
    assert.equal(second.created, false);
    assert.equal(second.updated, true);
    const after = await readFile(second.file_path, "utf8");
    assert.match(after, /Zweite Fassung/);
    assert.deepEqual(await readdir(join(dir, "dokumentationen")), ["carnexus"]);
  } finally {
    await close();
  }
});

/**
 * Codex-Gegenreview: Der Rename schrieb den Scope um, aber nicht die
 * IDENTITÄT. Die id blieb `doku-carnexus-…`, während der nächste Save für
 * `new-project` nach `doku-new-project-…` sucht — und ein zweites Dokument
 * anlegte, statt das vorhandene zu aktualisieren.
 *
 * Der ganze Weg in einem Test: Doc anlegen → Projekt umbenennen → dieselbe
 * Area erneut speichern → weiterhin genau EIN Dokument.
 */
test("save_product_doc: rename then update keeps exactly one doc", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    const first = await saveProductDocHandler(deps, {
      project: "carnexus",
      area: "Recall-Ansicht",
      title: "Recall-Ansicht",
      summary: "s",
      body: "# Vor dem Rename\n",
    });
    assert.equal(first.id, "doku-carnexus-recall-ansicht");
    // Das Memory-Regal muss existieren, sonst hat die Area nichts zum Umbenennen.
    await mkdir(join(dir, "memories", "projects", "carnexus"), { recursive: true });

    const r = await renameArea(dir, "project", "carnexus", "new-project");
    assert.equal(r.docsFolderMoved, true);
    assert.equal(r.docsRetagged, 1);
    await deps.vault.reconcile?.();

    const second = await saveProductDocHandler(deps, {
      project: "new-project",
      area: "Recall-Ansicht",
      title: "Recall-Ansicht",
      summary: "s",
      body: "# Nach dem Rename\n",
    });
    // Die id bleibt der historische Name — ein Umbenennen würde jedes
    // `related:` und jeden `[[wikilink]]` darauf brechen. Gefunden wird das
    // Dokument über Scope + Area.
    assert.equal(second.id, "doku-carnexus-recall-ansicht");
    assert.equal(second.created, false, "kein zweites Dokument");

    const docs = await readdir(join(dir, "dokumentationen", "new-project"));
    assert.deepEqual(docs, ["doku-carnexus-recall-ansicht.md"]);
    const raw = await readFile(join(dir, "dokumentationen", "new-project", docs[0]), "utf8");
    assert.match(raw, /Nach dem Rename/);
    assert.match(raw, /^scope: new-project$/m);
    // topic_path und Tag tragen den neuen Projektnamen.
    assert.match(raw, /- new-project/);
  } finally {
    await close();
  }
});

test("save_product_doc: findet ein Bestandsdokument mit roher Scope-Schreibweise", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    // Wie es vor der Kanonisierung im Vault lag: Regal und Scope groß.
    await mkdir(join(dir, "dokumentationen", "CarNexus"), { recursive: true });
    await writeFile(
      join(dir, "dokumentationen", "CarNexus", "doku-CarNexus-area.md"),
      "---\nid: doku-CarNexus-area\ntitle: D\ntype: doc\nsummary: s\ntopic_path:\n  - doku\n  - CarNexus\n  - area\ntags:\n  - product-doc\nscope: CarNexus\nrecall_when:\n  - d\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nAlt.\n",
    );
    await deps.vault.reconcile?.();

    const r = await saveProductDocHandler(deps, {
      project: "carnexus",
      area: "area",
      title: "D",
      summary: "s",
      body: "# Neu\n",
    });
    assert.equal(r.id, "doku-CarNexus-area", "das Bestandsdokument, nicht ein neues");
    assert.equal(r.created, false);
    assert.match(await readFile(r.file_path, "utf8"), /Neu/);
  } finally {
    await close();
  }
});

/**
 * Codex-Gegenreview: Der Lookup prüfte nur type, Scope und topic_path[2] und
 * überschrieb damit jedes beliebige Dokument im selben Scope, dessen drittes
 * topic_path-Segment zufällig gleich hieß.
 */
test("save_product_doc: ein fremdes Dokument im selben Scope wird NICHT überschrieben", async () => {
  const { deps, dir, close } = await makeDeps();
  try {
    await mkdir(join(dir, "dokumentationen", "carnexus"), { recursive: true });
    const foreign = join(dir, "dokumentationen", "carnexus", "manual-doc.md");
    const original =
      "---\nid: manual-doc\ntitle: Handbuch\ntype: doc\nsummary: s\ntopic_path:\n  - manual\n  - unrelated\n  - area\ntags:\n  - manual\nscope: carnexus\nrecall_when:\n  - d\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nHandgeschriebenes Dokument.\n";
    await writeFile(foreign, original);
    await deps.vault.reconcile?.();

    const r = await saveProductDocHandler(deps, {
      project: "carnexus",
      area: "area",
      title: "Produktdoku",
      summary: "s",
      body: "# Produktdoku\n",
    });

    assert.equal(r.id, "doku-carnexus-area", "eine neue, eigene id");
    assert.equal(r.created, true);
    assert.equal(
      await readFile(foreign, "utf8"),
      original,
      "das fremde Dokument bleibt unangetastet",
    );
  } finally {
    await close();
  }
});
