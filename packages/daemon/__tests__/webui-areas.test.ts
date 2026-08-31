/**
 * Tests für die Area-Verwaltung (#216): listAreas / createArea / renameArea
 * (inkl. scope-Rewrite + dokumentationen-Mitzug) / deleteArea (→ Vault-Trash,
 * nie destruktiv) + Reserved-Guards.
 *
 * Runner: `tsx --test __tests__/webui-areas.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { listAreas, createArea, renameArea, deleteArea } from "../src/webui-areas.js";

async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "areas-"));
  await mkdir(join(root, "memories", "projects", "carnexus"), { recursive: true });
  await mkdir(join(root, "memories", "people"), { recursive: true });
  await mkdir(join(root, "memories", "user"), { recursive: true });
  await writeFile(
    join(root, "memories", "projects", "carnexus", "fact-one.md"),
    "---\nid: fact-one\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: carnexus\nrecall_when:\n  - t\ncreated: 2026-07-17\nupdated: 2026-07-17\n---\n\nBody.\n",
  );
  await writeFile(join(root, "memories", "people", "someone.md"), "---\nid: someone\ntitle: P\ntype: project-fact\nsummary: s\ntopic_path:\n  - people\ntags:\n  - person\nscope: bastra-recall\nrecall_when:\n  - p\ncreated: 2026-07-17\nupdated: 2026-07-17\n---\n\nP.\n");
  return root;
}

test("listAreas: tops (minus projects) + project areas, counts, reserved flags", async () => {
  const v = await makeVault();
  try {
    const areas = await listAreas(v);
    const names = areas.map((a) => `${a.kind}:${a.name}`);
    assert.ok(names.includes("top:people"));
    assert.ok(names.includes("top:user"));
    assert.ok(names.includes("project:carnexus"));
    assert.ok(!names.includes("top:projects"));
    assert.equal(areas.find((a) => a.name === "carnexus")?.count, 1);
    assert.equal(areas.find((a) => a.name === "user")?.reserved, true);
    assert.equal(areas.find((a) => a.name === "people")?.reserved, false);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("createArea: slugified project folder; duplicate rejected", async () => {
  const v = await makeVault();
  try {
    const a = await createArea(v, "Mein Neues Projekt");
    assert.equal(a.name, "mein-neues-projekt");
    const dirs = await readdir(join(v, "memories", "projects"));
    assert.ok(dirs.includes("mein-neues-projekt"));
    await assert.rejects(createArea(v, "mein-neues-projekt"), /already exists/);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("renameArea project: folder moves, scope rewritten, ids stable, docs folder follows", async () => {
  const v = await makeVault();
  try {
    await mkdir(join(v, "dokumentationen", "carnexus"), { recursive: true });
    await writeFile(join(v, "dokumentationen", "carnexus", "doc.md"), "# doc\n");
    const r = await renameArea(v, "project", "carnexus", "car-nexus-2");
    assert.equal(r.name, "car-nexus-2");
    assert.equal(r.scopesRewritten, 1);
    assert.equal(r.docsFolderMoved, true);
    const raw = await readFile(join(v, "memories", "projects", "car-nexus-2", "fact-one.md"), "utf8");
    const { data } = matter(raw);
    assert.equal(data.scope, "car-nexus-2");
    assert.equal(data.id, "fact-one"); // id untouched — related[] links survive
    const docs = await readdir(join(v, "dokumentationen", "car-nexus-2"));
    assert.ok(docs.includes("doc.md"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("renameArea top: folder moves, foreign scopes untouched", async () => {
  const v = await makeVault();
  try {
    const r = await renameArea(v, "top", "people", "personen");
    assert.equal(r.name, "personen");
    assert.equal(r.scopesRewritten, 0); // top areas never rewrite scope
    const raw = await readFile(join(v, "memories", "personen", "someone.md"), "utf8");
    assert.equal(matter(raw).data.scope, "bastra-recall");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("deleteArea: whole folder lands in .bastra/trash/areas, nothing destroyed", async () => {
  const v = await makeVault();
  try {
    const r = await deleteArea(v, "project", "carnexus");
    assert.ok(r.trashedTo.includes(join(".bastra", "trash", "areas")));
    const trashed = await readdir(r.trashedTo);
    assert.ok(trashed.includes("fact-one.md")); // memory survived, recoverable
    const projects = await readdir(join(v, "memories", "projects"));
    assert.ok(!projects.includes("carnexus"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("guards: reserved areas and unsafe names are rejected", async () => {
  const v = await makeVault();
  try {
    await assert.rejects(renameArea(v, "top", "user", "benutzer"), /reserved/);
    await assert.rejects(deleteArea(v, "top", "taxonomy"), /reserved|not found/);
    await assert.rejects(deleteArea(v, "project", "../escape"), /invalid area name/);
    await assert.rejects(renameArea(v, "project", "carnexus", "…"), /invalid|cannot slugify/);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * #360-Folgefund A+B (Codex-Gegenreview): der Scope-Rewrite beim Rename lief
 * case-sensitiv, und der mitgezogene Doku-Ordner wurde gar nicht umgeschrieben.
 */
async function makeMixedCaseVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "areas-case-"));
  await mkdir(join(root, "memories", "projects", "carnexus"), { recursive: true });
  await writeFile(
    join(root, "memories", "projects", "carnexus", "fact-case.md"),
    "---\nid: fact-case\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: CarNexus\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nBody.\n",
  );
  await mkdir(join(root, "dokumentationen", "carnexus"), { recursive: true });
  await writeFile(
    join(root, "dokumentationen", "carnexus", "doku-carnexus-area.md"),
    "---\nid: doku-carnexus-area\ntitle: D\ntype: doc\nsummary: s\ntopic_path:\n  - doku\n  - CarNexus\n  - area\ntags:\n  - product-doc\n  - carnexus\nscope: carnexus\nrecall_when:\n  - d\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nDoc.\n",
  );
  return root;
}

test("renameArea: scope rewrite is case-folded — CarNexus counts as carnexus", async () => {
  const v = await makeMixedCaseVault();
  try {
    const r = await renameArea(v, "project", "carnexus", "new-project");
    // 1x memory (scope: CarNexus) + 1x product doc (scope: carnexus)
    assert.equal(r.scopesRewritten, 2);
    const raw = await readFile(
      join(v, "memories", "projects", "new-project", "fact-case.md"),
      "utf8",
    );
    assert.equal(matter(raw).data.scope, "new-project");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("renameArea: product docs move, scope and tags follow, id stays", async () => {
  const v = await makeMixedCaseVault();
  try {
    const r = await renameArea(v, "project", "carnexus", "new-project");
    assert.equal(r.docsFolderMoved, true);
    assert.equal(r.docsRetagged, 1);
    const docs = await readdir(join(v, "dokumentationen", "new-project"));
    // Die id überlebt den Rename — sonst bräche jedes `related:` und jeder
    // `[[wikilink]]` darauf (Codex-Gegenreview).
    assert.deepEqual(docs, ["doku-carnexus-area.md"]);
    const raw = await readFile(join(v, "dokumentationen", "new-project", docs[0]), "utf8");
    // Der Kernfehler: das Dokument lag im neuen Regal, hieß aber noch carnexus
    // — und wurde beim Recall für new-project als fremd gefiltert.
    assert.equal(matter(raw).data.scope, "new-project");
    assert.equal(matter(raw).data.id, "doku-carnexus-area");
    assert.deepEqual(matter(raw).data.topic_path, ["doku", "new-project", "area"]);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Codex-Befunde 1–4: Ein Area-Rename fasste Dateien an, die dem Vault nicht
 * gehören, und Rename/Delete waren sich uneinig, was eine "Area" überhaupt ist.
 */
async function makeVaultWithForeignNotes(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "areas-foreign-"));
  await mkdir(join(root, "memories", "projects", "carnexus"), { recursive: true });
  await writeFile(
    join(root, "memories", "projects", "carnexus", "fact-one.md"),
    "---\nid: fact-one\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: carnexus\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nBody.\n",
  );
  // Eine gewöhnliche Obsidian-Notiz, die zufällig ein Feld `scope:` trägt.
  // Kein `type:` → der Vault würde sie NIE als Memory indexieren.
  await writeFile(
    join(root, "memories", "projects", "carnexus", "Meine Notiz.md"),
    "---\nscope: carnexus\nauthor: daniel\n---\n\nGanz normale Notiz.\n",
  );
  await mkdir(join(root, "dokumentationen", "carnexus"), { recursive: true });
  await writeFile(
    join(root, "dokumentationen", "carnexus", "doku-carnexus-area.md"),
    "---\nid: doku-carnexus-area\ntitle: D\ntype: doc\nsummary: s\ntopic_path:\n  - doku\n  - carnexus\n  - area\ntags:\n  - product-doc\n  - carnexus\nscope: carnexus\nrecall_when:\n  - d\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nDoc.\n",
  );
  // Sieht einer Produktdoku ähnlich (Tags + topic_path), ist aber keine:
  // `type: reference`, und der Vault kennt sie nicht als Doku.
  await writeFile(
    join(root, "dokumentationen", "carnexus", "notiz-mit-tags.md"),
    "---\nid: notiz-mit-tags\ntitle: N\ntype: reference\nsummary: s\ntopic_path:\n  - doku\n  - carnexus\n  - area\ntags:\n  - carnexus\nscope: carnexus\nrecall_when:\n  - n\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nN.\n",
  );
  // Und eine reine Notiz ohne jede Memory-Signatur.
  await writeFile(
    join(root, "dokumentationen", "carnexus", "lose-notiz.md"),
    "---\ntags:\n  - carnexus\ntopic_path:\n  - doku\n  - carnexus\n  - area\n---\n\nLose.\n",
  );
  return root;
}

test("renameArea: eine fremde Notiz mit `scope:` wird nicht umgeschrieben", async () => {
  const v = await makeVaultWithForeignNotes();
  try {
    const r = await renameArea(v, "project", "carnexus", "new-project");
    // 1 Memory + 1 Produktdoku + 1 doku-Notiz mit type: reference und scope:
    // carnexus — alles echte Memories. Die fremde Notiz zählt NICHT mit.
    assert.equal(r.scopesRewritten, 3);
    const foreign = await readFile(
      join(v, "memories", "projects", "new-project", "Meine Notiz.md"),
      "utf8",
    );
    assert.equal(
      matter(foreign).data.scope,
      "carnexus",
      "eine Notiz, die der Vault nicht als Memory führt, darf ein Rename nicht anfassen",
    );
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("renameArea: nur echte Produktdokumente werden retagged", async () => {
  const v = await makeVaultWithForeignNotes();
  try {
    const r = await renameArea(v, "project", "carnexus", "new-project");
    assert.equal(r.docsRetagged, 1, "nur die eine echte Produktdoku");
    const docDir = join(v, "dokumentationen", "new-project");
    const doc = matter(await readFile(join(docDir, "doku-carnexus-area.md"), "utf8")).data;
    assert.deepEqual(doc.topic_path, ["doku", "new-project", "area"]);
    assert.deepEqual(doc.tags, ["product-doc", "new-project"]);
    // type: reference → keine Produktdoku, auch wenn topic_path/Tags passen.
    const notDoc = matter(await readFile(join(docDir, "notiz-mit-tags.md"), "utf8")).data;
    assert.deepEqual(notDoc.topic_path, ["doku", "carnexus", "area"]);
    assert.deepEqual(notDoc.tags, ["carnexus"]);
    // Gar kein Memory → unberührt.
    const loose = matter(await readFile(join(docDir, "lose-notiz.md"), "utf8")).data;
    assert.deepEqual(loose.tags, ["carnexus"]);
    assert.deepEqual(loose.topic_path, ["doku", "carnexus", "area"]);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("renameArea: kollidierendes Doku-Regal bricht ab, bevor irgendetwas bewegt wird", async () => {
  const v = await makeVaultWithForeignNotes();
  try {
    await mkdir(join(v, "dokumentationen", "new-project"), { recursive: true });
    await writeFile(join(v, "dokumentationen", "new-project", "fremd.md"), "# fremd\n");
    await assert.rejects(
      renameArea(v, "project", "carnexus", "new-project"),
      /docs folder already exists/,
    );
    // Nichts halb erledigt: das Projektregal liegt noch am alten Platz.
    const projects = await readdir(join(v, "memories", "projects"));
    assert.deepEqual(projects, ["carnexus"]);
    const docs = (await readdir(join(v, "dokumentationen"))).sort();
    assert.deepEqual(docs, ["carnexus", "new-project"]);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("deleteArea: das Doku-Regal des Projekts wandert mit in den Trash", async () => {
  const v = await makeVaultWithForeignNotes();
  try {
    const r = await deleteArea(v, "project", "carnexus");
    assert.ok(r.docsTrashedTo, "das Doku-Regal wurde mitgenommen");
    const trashedDocs = await readdir(r.docsTrashedTo!);
    assert.ok(trashedDocs.includes("doku-carnexus-area.md"));
    const remaining = await readdir(join(v, "dokumentationen"));
    assert.deepEqual(remaining, [], "kein verwaistes dokumentationen/<projekt> bleibt aktiv");
    // Weiterhin nichts vernichtet — beide Regale sind wiederherstellbar.
    const trashed = await readdir(r.trashedTo);
    assert.ok(trashed.includes("fact-one.md"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Beim Nachstellen von Befund 2 aufgefallen: gray-matter cacht `data` global
 * pro Dateiinhalt. Zwei INHALTSGLEICHE Dokumente teilten damit dasselbe
 * Frontmatter-Objekt — die erste Datei mutierte es, die zweite hielt ihre
 * Änderung für erledigt und blieb auf der Platte unverändert.
 */
test("renameArea: zwei inhaltsgleiche Dokumente werden beide umgeschrieben", async () => {
  const v = await mkdtemp(join(tmpdir(), "areas-twins-"));
  try {
    await mkdir(join(v, "memories", "projects", "carnexus"), { recursive: true });
    await mkdir(join(v, "dokumentationen", "carnexus"), { recursive: true });
    const twin =
      "---\nid: doku-carnexus-area\ntitle: D\ntype: doc\nsummary: s\ntopic_path:\n  - doku\n  - carnexus\n  - area\ntags:\n  - product-doc\n  - carnexus\nscope: carnexus\nrecall_when:\n  - d\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nDoc.\n";
    await writeFile(join(v, "dokumentationen", "carnexus", "a.md"), twin);
    await writeFile(join(v, "dokumentationen", "carnexus", "b.md"), twin);
    const r = await renameArea(v, "project", "carnexus", "new-project");
    assert.equal(r.docsRetagged, 2, "beide Zwillinge, nicht nur der erste");
    assert.equal(r.scopesRewritten, 2);
    for (const n of ["a.md", "b.md"]) {
      const d = matter(await readFile(join(v, "dokumentationen", "new-project", n), "utf8")).data;
      assert.deepEqual(d.topic_path, ["doku", "new-project", "area"], `${n}: topic_path`);
      assert.equal(d.scope, "new-project", `${n}: scope`);
    }
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("renameArea: scheitert der Doku-Zug, bleibt die Area ungeteilt", async () => {
  const v = await makeVault();
  try {
    await mkdir(join(v, "dokumentationen", "carnexus"), { recursive: true });
    await writeFile(join(v, "dokumentationen", "carnexus", "doku-a.md"), "---\nid: doku-a\ntitle: A\ntype: doc\nsummary: s\ntopic_path:\n  - doku\n  - carnexus\n  - area\ntags:\n  - carnexus\nscope: carnexus\nrecall_when:\n  - a\ncreated: 2026-07-17\nupdated: 2026-07-17\n---\n\nA.\n");
    // Der Preflight kennt nur „Zielordner existiert schon". Hier liegt am
    // Zielpfad eine DATEI: isDir() sagt nein, der rename scheitert trotzdem.
    await writeFile(join(v, "dokumentationen", "new-project"), "im Weg", "utf8");

    await assert.rejects(renameArea(v, "project", "carnexus", "new-project"));

    // Vorher blieb genau hier eine geteilte Area zurück: Memories unter dem
    // neuen Namen, Doku unter dem alten — und der Fehler meldete nur den
    // zweiten Schritt.
    const projects = await readdir(join(v, "memories", "projects"));
    assert.ok(projects.includes("carnexus"), "das Memory-Regal steht wieder am alten Platz");
    assert.ok(!projects.includes("new-project"), "und nicht unter dem neuen Namen");
    const fm = matter(await readFile(join(v, "memories", "projects", "carnexus", "fact-one.md"), "utf8")).data;
    assert.equal(fm.scope, "carnexus", "auch der Scope ist zurückgedreht");
    assert.ok((await readdir(join(v, "dokumentationen"))).includes("carnexus"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("reservierte Bereiche sind auch in anderer Schreibweise reserviert", async () => {
  const v = await makeVault();
  try {
    // Auf case-insensitivem APFS zeigt `memories/Projects` auf `memories/projects`.
    // Ungefaltet geprüft ließ sich das reservierte Regal darüber umbenennen.
    await assert.rejects(renameArea(v, "top", "Projects", "gekapert"), /reserved/);
    await assert.rejects(deleteArea(v, "top", "USER"), /reserved/);
    await assert.rejects(renameArea(v, "top", "people", "Taxonomy"), /reserved/);
    assert.ok((await readdir(join(v, "memories"))).includes("projects"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

// ── Codex-Gegenreview ───────────────────────────────────────────

/**
 * P0: Die Containment-Prüfung in `areaPath()` war rein lexikalisch. Zeigte ein
 * Projektordner als Symlink nach außen, schrieb `renameArea()` in fremden
 * Dateien außerhalb des Vaults die Scopes um.
 */
test("ein Projektregal, das als Symlink nach außen zeigt, ist kein Regal dieses Vaults", async () => {
  const v = await makeVault();
  const outside = await mkdtemp(join(tmpdir(), "areas-outside-"));
  try {
    await writeFile(
      join(outside, "fremd.md"),
      "---\nid: fremd\ntitle: F\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: geliehen\nrecall_when:\n  - t\ncreated: 2026-07-17\nupdated: 2026-07-17\n---\n\nF.\n",
    );
    await symlink(outside, join(v, "memories", "projects", "geliehen"));

    await assert.rejects(renameArea(v, "project", "geliehen", "neu"), /outside memories\/projects/);
    const fm = matter(await readFile(join(outside, "fremd.md"), "utf8")).data;
    assert.equal(fm.scope, "geliehen", "die fremde Datei bleibt unangetastet");
  } finally {
    await rm(v, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

/**
 * P1: Ein unlesbares Memory im umziehenden Projekt wurde nicht umgeschrieben,
 * der Rename meldete trotzdem Erfolg — die Datei lag danach im neuen Ordner
 * und trug den alten Scope. Eine Area zieht ganz um oder gar nicht.
 */
test("renameArea: ein unlesbares Memory lässt den Rename scheitern statt still danebenliegen", async () => {
  const v = await makeVault();
  const locked = join(v, "memories", "projects", "carnexus", "fact-one.md");
  try {
    await chmod(locked, 0o000);
    await assert.rejects(
      renameArea(v, "project", "carnexus", "neuer-name"),
      /konnten nicht umgeschrieben werden|rename failed/,
    );
    // Und zurückgerollt: das Projekt liegt wieder unter dem alten Namen.
    const projects = await readdir(join(v, "memories", "projects"));
    assert.deepEqual(projects, ["carnexus"]);
  } finally {
    await chmod(locked, 0o644).catch(() => {});
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Sicherheitsrunde: Die Grenze einer Area ist ihr ELTERNREGAL, nicht der
 * Vault. Ein Projektordner als Symlink auf `memories/people` verlässt den
 * Vault nicht — er verlässt aber den Bereich, den diese Area besitzt, und der
 * Rename schrieb dort fremde Scopes um.
 */
test("ein Projektregal, das INNERHALB des Vaults woanders hinzeigt, ist trotzdem kein Regal dieser Area", async () => {
  const v = await makeVault();
  try {
    await symlink(join(v, "memories", "people"), join(v, "memories", "projects", "geliehen"));
    await assert.rejects(
      renameArea(v, "project", "geliehen", "neu"),
      /outside memories\/projects/,
    );
    const fm = matter(await readFile(join(v, "memories", "people", "someone.md"), "utf8")).data;
    assert.equal(fm.scope, "bastra-recall", "die fremde Datei bleibt unangetastet");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Dasselbe für das Doku-Regal: `dokumentationen/<name>` als Symlink auf ein
 * anderes Regal ließ den Rename dort fremde Dokumente umschreiben und das
 * Delete sie in den Trash schieben — gemeldet als „die Area ist umgezogen".
 */
test("auch das Doku-Regal einer Area darf nicht woanders hinzeigen", async () => {
  const v = await makeVault();
  try {
    await mkdir(join(v, "dokumentationen"), { recursive: true });
    await symlink(join(v, "memories", "people"), join(v, "dokumentationen", "carnexus"));
    await assert.rejects(
      renameArea(v, "project", "carnexus", "neuer-name"),
      /outside dokumentationen/,
    );
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * P0: Ein Area-Rename und ein normaler Save waren nicht gegeneinander
 * serialisiert. Nachgestellt: Der Rename hat ein Memory bereits auf
 * `scope: neu` umgeschrieben, danach schreibt ein Save derselben id noch mit
 * der ALTEN Area-Identität. Beide meldeten Erfolg, die Datei lag danach im
 * neuen Regal und trug wieder den alten Scope.
 *
 * Der Save wird hier durch ein atomares temp+rename auf dieselbe Datei
 * nachgestellt — genau das, was der Save-Pfad tut, nur ohne den ganzen Daemon.
 * Das Doku-Regal mit vielen Dokumenten sorgt dafür, dass der Rename nach dem
 * Umschreiben des Memory-Regals noch reichlich zu tun hat: das Fenster, in dem
 * der Save real landet.
 */
test("renameArea: ein Save, der während des Renames die alte Area schreibt, lässt den Rename scheitern", async () => {
  const v = await makeVault();
  try {
    await mkdir(join(v, "dokumentationen", "carnexus"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      await writeFile(
        join(v, "dokumentationen", "carnexus", `doku-carnexus-${i}.md`),
        `---\nid: doku-carnexus-${i}\ntitle: D${i}\ntype: doc\nsummary: s\ntopic_path:\n  - doku\n  - carnexus\n  - area\ntags:\n  - product-doc\n  - carnexus\nscope: carnexus\nrecall_when:\n  - d\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nDoc ${i}.\n`,
      );
    }
    const stale = await readFile(
      join(v, "memories", "projects", "carnexus", "fact-one.md"),
      "utf8",
    );
    const target = join(v, "memories", "projects", "neu", "fact-one.md");

    let settled = false;
    const p = renameArea(v, "project", "carnexus", "neu").finally(() => {
      settled = true;
    });
    p.catch(() => {});

    let injected = false;
    while (!settled && !injected) {
      const raw = await readFile(target, "utf8").catch(() => null);
      if (raw && matter(raw).data.scope === "neu") {
        // Atomar wie ein echter Save — eine halb geschriebene Datei wäre
        // schlicht kein Memory und würde am Nachweis vorbeilaufen.
        const tmp = `${target}.race.tmp`;
        await writeFile(tmp, stale, "utf8");
        await rename(tmp, target);
        injected = true;
      } else {
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    assert.ok(injected, "der parallele Save muss überhaupt gelandet sein");

    await assert.rejects(p, /unvollständig|alte Area/);
    // Und die Area ist wieder ganz: zurückgerollt statt halb umgezogen.
    const projects = await readdir(join(v, "memories", "projects"));
    assert.deepEqual(projects, ["carnexus"]);
    const fm = matter(
      await readFile(join(v, "memories", "projects", "carnexus", "fact-one.md"), "utf8"),
    ).data;
    assert.equal(fm.scope, "carnexus");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * P1: `rollbackRename()` übergab NEUE LEERE `failed`-Arrays an
 * `rewriteScopes()` und `rewriteDocMetadata()` und sah sie nie wieder an. Was
 * der Rollback nicht zurückschreiben konnte, verschwieg er — und meldete
 * trotzdem „rename failed, nothing was changed".
 */
test("renameArea: der Rollback verschweigt nicht, was er nicht zurückschreiben konnte", async () => {
  const v = await makeVault();
  const locked = join(v, "memories", "projects", "carnexus", "fact-one.md");
  try {
    await chmod(locked, 0o000);
    const err = await renameArea(v, "project", "carnexus", "neuer-name").then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(err, "der Rename muss scheitern");
    assert.match(
      err!.message,
      /nicht zurückgeschrieben/,
      "der Rollback muss nennen, was er nicht zurückschreiben konnte",
    );
    assert.doesNotMatch(
      err!.message,
      /nothing was changed/,
      "„nichts wurde geändert“ ist eine Behauptung, die der Rollback hier nicht belegen kann",
    );
    assert.match(err!.message, /fact-one\.md/, "pfadgenau, wie im stuck-Pfad");
  } finally {
    await chmod(locked, 0o644).catch(() => {});
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Sicherheitsrunde: `deleteArea()` prüfte die Trash-Grenze SCHWÄCHER als der
 * Memory-Trash in core (`trashPathFor`) — lexikalisches `startsWith` plus ein
 * `assertInsideVault` auf `.bastra/trash/areas`. Zeigt `.bastra` auf ein
 * AKTIVES Regal, liegt der Trash formal weiterhin im Vault: aus dem Löschen
 * wurde ein Verschieben in den Bestand, gemeldet als „in den Trash gelegt".
 */
test("deleteArea: ein .bastra, das auf ein aktives Regal zeigt, ist kein Trash", async () => {
  const v = await makeVault();
  try {
    await symlink(join(v, "memories", "people"), join(v, ".bastra"));
    await assert.rejects(
      deleteArea(v, "project", "carnexus"),
      /own \.bastra|Private daemon state/,
    );
    // Die Area steht noch, und im aktiven Regal ist kein Trash entstanden.
    const projects = await readdir(join(v, "memories", "projects"));
    assert.ok(projects.includes("carnexus"));
    const people = await readdir(join(v, "memories", "people"));
    assert.deepEqual(people, ["someone.md"]);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});
