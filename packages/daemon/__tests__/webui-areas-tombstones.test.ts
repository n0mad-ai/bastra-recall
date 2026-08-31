/**
 * Area-Grabsteine (`.bastra/areas/`, core/area-claim.ts) im Zusammenspiel mit
 * der Area-Verwaltung: rename setzt, ein vollständiger Rollback räumt ab,
 * delete setzt, createArea ist die bewusste Wiederinbetriebnahme. Dazu die
 * Trash-Grenze von `deleteArea()` gegen nach INNEN zeigende Symlinks.
 *
 * Runner: `tsx --test __tests__/webui-areas-tombstones.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAreaWritable, readAreaMark } from "@bastra-recall/core";
import { createArea, deleteArea, renameArea } from "../src/webui-areas.js";

function memory(id: string, scope: string): string {
  return (
    `---\nid: ${id}\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\n` +
    `tags:\n  - t\nscope: ${scope}\nrecall_when:\n  - t\n` +
    `created: 2026-08-26\nupdated: 2026-08-26\n---\n\nBody.\n`
  );
}

async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "area-marks-"));
  await mkdir(join(root, "memories", "projects", "carnexus"), { recursive: true });
  await mkdir(join(root, "memories", "people"), { recursive: true });
  await writeFile(
    join(root, "memories", "projects", "carnexus", "fact-one.md"),
    memory("fact-one", "carnexus"),
  );
  return root;
}

/** Ein Doku-Regal, dessen Elternordner sich gleich sperren lässt. */
async function withDocsShelf(root: string): Promise<void> {
  await mkdir(join(root, "dokumentationen", "carnexus"), { recursive: true });
  await writeFile(join(root, "dokumentationen", "carnexus", "doku-carnexus-area.md"), memory("doku-carnexus-area", "carnexus"));
}

/**
 * Der gemeldete P0: Die Nachprüfung am Ende von `renameArea()` sieht nur ins
 * NEUE Regal. Nachgestellt — nachdem das vorhandene Memory nach `neu`
 * gewandert war, legte ein Save mit `scope: carnexus` das ALTE Regal neu an,
 * und der Rename meldete trotzdem Erfolg (`Projektordner: [carnexus, neu]`).
 * Derselbe Save kann auch lange danach kommen, aus einer Session mit dem alten
 * Projektnamen im Kontext. Der alte Name muss deshalb dauerhaft gesperrt sein.
 */
test("renameArea: der alte Name trägt danach einen Grabstein und ist nicht mehr beschreibbar", async () => {
  const v = await makeVault();
  try {
    await renameArea(v, "project", "carnexus", "neu");
    const mark = await readAreaMark(v, "carnexus");
    assert.ok(mark, "der alte Name muss markiert sein");
    assert.equal(mark!.kind, "renamed");
    assert.equal(mark!.to, "neu");
    // Das ist der Griff, an dem der Save-Pfad hängt.
    await assert.rejects(assertAreaWritable(v, "carnexus"), /was renamed to 'neu'/);
    // Und der neue Name ist beschreibbar.
    await assertAreaWritable(v, "neu");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Der Grabstein muss VOR der Ordnerbewegung stehen: Ein Absturz dazwischen
 * darf nicht die Variante hinterlassen, bei der das Regal umgezogen und der
 * alte Name frei ist. Hier nachgestellt an der beobachtbaren Folge — der
 * gescheiterte Rename (unlesbares Memory) rollt zwar zurück, aber weil er das
 * Memory nicht zurückschreiben konnte, ist der Zustand geteilt, und dann
 * bleibt der alte Name gesperrt.
 */
test("renameArea: nach einem unvollständigen Rollback bleibt der alte Name gesperrt", async () => {
  const v = await makeVault();
  const locked = join(v, "memories", "projects", "carnexus", "fact-one.md");
  try {
    await chmod(locked, 0o000);
    await assert.rejects(renameArea(v, "project", "carnexus", "neu"), /rename failed/);
    const mark = await readAreaMark(v, "carnexus");
    assert.ok(mark, "geteilter Zustand — der Grabstein ist die sichere Seite");
    assert.equal(mark!.kind, "renamed");
  } finally {
    await chmod(locked, 0o644).catch(() => {});
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Die Gegenrichtung: Ein VOLLSTÄNDIGER Rollback stellt den alten Namen als den
 * richtigen wieder her — dann muss der Grabstein weg, sonst wäre ein Projekt
 * nach einem gescheiterten Rename dauerhaft unbeschreibbar.
 *
 * Herbeigeführt über ein gesperrtes `dokumentationen/`: Der Scope-Rewrite im
 * Memory-Regal gelingt (und wird zurückgeschrieben), nur der Doku-Zug
 * scheitert an EACCES.
 */
test("renameArea: ein vollständiger Rollback räumt den Grabstein wieder ab", async () => {
  const v = await makeVault();
  await withDocsShelf(v);
  const docsParent = join(v, "dokumentationen");
  try {
    await chmod(docsParent, 0o555);
    const err = await renameArea(v, "project", "carnexus", "neu").then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(err, "der Rename muss scheitern");
    assert.match(err!.message, /nothing was changed/, "der Rollback war vollständig");
    assert.equal(
      await readAreaMark(v, "carnexus"),
      null,
      "nach vollständigem Rollback ist der alte Name wieder der richtige",
    );
    await assertAreaWritable(v, "carnexus");
    const projects = await readdir(join(v, "memories", "projects"));
    assert.deepEqual(projects, ["carnexus"]);
  } finally {
    await chmod(docsParent, 0o755).catch(() => {});
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * `a → b` und später `b → a`: Der Rename nimmt den ZIELnamen in Betrieb. Ohne
 * das liefe der Rückweg in den eigenen alten Grabstein — das Regal läge wieder
 * unter `carnexus`, und kein Save dürfte hinein.
 */
test("renameArea: der Rückweg nimmt den alten Namen wieder in Betrieb", async () => {
  const v = await makeVault();
  try {
    await renameArea(v, "project", "carnexus", "neu");
    await renameArea(v, "project", "neu", "carnexus");
    assert.equal(await readAreaMark(v, "carnexus"), null);
    await assertAreaWritable(v, "carnexus");
    const mark = await readAreaMark(v, "neu");
    assert.equal(mark?.kind, "renamed", "jetzt ist 'neu' der fortgezogene Name");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Ein Top-Regal (`memories/<name>`) kann ein Save gar nicht wiederbeleben —
 * `subfolderFor()` routet nur nach `memories/projects/<scope>` bzw.
 * `dokumentationen/<scope>`. Ein Grabstein auf einen Top-Namen würde dafür ein
 * gleichnamiges PROJEKT sperren, das mit dem umbenannten Ordner nichts zu tun
 * hat.
 */
test("renameArea: ein Top-Regal setzt keinen Grabstein", async () => {
  const v = await makeVault();
  try {
    await renameArea(v, "top", "people", "menschen");
    assert.equal(await readAreaMark(v, "people"), null);
    await assertAreaWritable(v, "people");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Dieselbe Klasse beim Delete: Die Area wandert in den Trash, danach legt ein
 * Save mit `scope: carnexus` das Regal still wieder an — „gelöscht" gemeldet
 * und mit einem einzelnen Memory zurück, ohne dass jemand das entschieden hat.
 */
test("deleteArea: der gelöschte Name trägt einen Grabstein", async () => {
  const v = await makeVault();
  try {
    await deleteArea(v, "project", "carnexus");
    const mark = await readAreaMark(v, "carnexus");
    assert.equal(mark?.kind, "deleted");
    await assert.rejects(assertAreaWritable(v, "carnexus"), /was deleted/);
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Und auch hier: Ein Delete, das vollständig zurückgerollt ist, hat den Namen
 * nicht gelöscht — das Regal liegt wieder an seinem Platz.
 */
test("deleteArea: ein vollständiger Rollback räumt den Grabstein wieder ab", async () => {
  const v = await makeVault();
  await withDocsShelf(v);
  const docsParent = join(v, "dokumentationen");
  try {
    await chmod(docsParent, 0o555);
    await assert.rejects(
      deleteArea(v, "project", "carnexus"),
      /delete failed, nothing was changed/,
    );
    assert.equal(await readAreaMark(v, "carnexus"), null);
    await assertAreaWritable(v, "carnexus");
    const projects = await readdir(join(v, "memories", "projects"));
    assert.deepEqual(projects, ["carnexus"]);
  } finally {
    await chmod(docsParent, 0o755).catch(() => {});
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Der eine Weg, einen Grabstein aufzuheben: Wer die Area unter dem Namen NEU
 * anlegt, entscheidet das bewusst. Der Grabstein darf `createArea` deshalb
 * nicht blockieren — er soll nur die beiläufige Wiederbelebung durch einen
 * Save verhindern.
 */
test("createArea: ist die Wiederinbetriebnahme und wird vom Grabstein nicht blockiert", async () => {
  const v = await makeVault();
  try {
    await deleteArea(v, "project", "carnexus");
    assert.equal((await readAreaMark(v, "carnexus"))?.kind, "deleted");
    const area = await createArea(v, "carnexus");
    assert.equal(area.name, "carnexus");
    assert.equal(await readAreaMark(v, "carnexus"), null);
    await assertAreaWritable(v, "carnexus");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("createArea: hebt auch einen Rename-Grabstein auf", async () => {
  const v = await makeVault();
  try {
    await renameArea(v, "project", "carnexus", "neu");
    await createArea(v, "carnexus");
    assert.equal(await readAreaMark(v, "carnexus"), null);
    await assertAreaWritable(v, "carnexus");
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

/**
 * Sicherheitsrunde, zweite Ebene: `assertAreaTrashBoundary()` prüfte die
 * privaten UNTERREGALE nur mit `assertInsideDir` — und das fragt lediglich, ob
 * das Ziel irgendwo unter dem Elternpfad landet. Ein nach INNEN zeigender
 * Symlink kam glatt durch, obwohl `trashPathFor()` in core/audit-log.ts für
 * denselben Trash längst `assertOwnSubdir` verlangt.
 */
test("deleteArea: ein .bastra/trash, das auf die Locks zeigt, ist kein Trash", async () => {
  const v = await makeVault();
  try {
    await mkdir(join(v, ".bastra", "locks"), { recursive: true });
    await symlink(join(v, ".bastra", "locks"), join(v, ".bastra", "trash"));
    await assert.rejects(
      deleteArea(v, "project", "carnexus"),
      /Private daemon state must not be a symlink/,
    );
    const projects = await readdir(join(v, "memories", "projects"));
    assert.ok(projects.includes("carnexus"), "die Area steht noch");
    assert.deepEqual(
      await readdir(join(v, ".bastra", "locks")),
      [],
      "und liegt nicht zwischen den Lock-Dateien",
    );
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});

test("deleteArea: ein .bastra/trash/areas, das auf den Trash selbst zeigt, ist kein Area-Trash", async () => {
  const v = await makeVault();
  try {
    await mkdir(join(v, ".bastra", "trash"), { recursive: true });
    await symlink(join(v, ".bastra", "trash"), join(v, ".bastra", "trash", "areas"));
    await assert.rejects(
      deleteArea(v, "project", "carnexus"),
      /Private daemon state must not be a symlink/,
    );
    const projects = await readdir(join(v, "memories", "projects"));
    assert.ok(projects.includes("carnexus"));
  } finally {
    await rm(v, { recursive: true, force: true });
  }
});
