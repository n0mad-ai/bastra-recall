/**
 * #240/A4 — soft-delete and restore must never destroy data.
 *
 * `trashPathFor()` returns one fixed path per id, so trashing the same id
 * twice replaced the first trashed version via `rename()` — silently and
 * unrecoverably, against the documented "recoverable — never a hard delete".
 * `restoreFromTrash()` was likewise a bare rename and would overwrite a file
 * that had become active again at the destination.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile, rm, mkdir, readdir, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  moveToTrashUnderClaim,
  restoreFromTrashUnderClaim,
  trashPathFor,
  latestTrashPathFor,
} from "../src/audit-log.js";
import { withIdClaim } from "../src/id-transaction.js";

/**
 * Die Trash-Primitiven verlangen einen `IdClaim`, und der ist seit der
 * Codex-Gegenreview Runde 10 NOMINAL: Ein Stellvertreter aus dem Testcode lässt
 * sich nicht mehr bauen, weil genau das die Zusage „wer den Claim hat, hält den
 * Lock" als API-Garantie aushebelte. Diese Tests nehmen deshalb echte Claims.
 *
 * Und die Datei muss das Memory des Claims halten (P0-5) — ein Marker-String
 * ohne Frontmatter ist kein Memory mehr, also tragen die Fixtures echtes
 * Frontmatter und der Marker steht im Body.
 */
function mem(id: string, marker: string): string {
  return `---\nid: ${id}\ntype: lesson\n---\n\n${marker}\n`;
}

async function bodyOf(file: string): Promise<string> {
  return (await readFile(file, "utf8")).split("---\n")[2]?.trim() ?? "";
}

const moveToTrash = (vaultRoot: string, filePath: string, id: string) =>
  withIdClaim({ vaultRoot, id, filePath }, (claim) =>
    moveToTrashUnderClaim(vaultRoot, filePath, claim),
  ).then((r) => r.trashPath);

const restoreFromTrash = (vaultRoot: string, trashFile: string, destFile: string) =>
  withIdClaim({ vaultRoot, id: "restore-test", filePath: destFile }, (claim) =>
    restoreFromTrashUnderClaim(vaultRoot, trashFile, destFile, claim),
  );

async function vaultWith(
  t: { after: (fn: () => unknown) => void },
  marker: string,
  id = "victim",
) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-trash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "victim.md");
  await writeFile(file, mem(id, marker), "utf8");
  return { dir, file };
}

test("trashing the same id twice keeps both versions", async (t) => {
  const { dir, file } = await vaultWith(t, "VERSION-ONE");

  const firstTrash = await moveToTrash(dir, file, "victim");
  assert.equal(await bodyOf(firstTrash), "VERSION-ONE");

  await writeFile(file, mem("victim", "VERSION-TWO"), "utf8");
  const secondTrash = await moveToTrash(dir, file, "victim");

  assert.notEqual(firstTrash, secondTrash, "the second trash must not reuse the path");
  assert.equal(await bodyOf(firstTrash), "VERSION-ONE", "v1 must survive");
  assert.equal(await bodyOf(secondTrash), "VERSION-TWO");

  const trashed = await readdir(path.dirname(firstTrash));
  assert.equal(trashed.length, 2, `expected two trash entries, got ${JSON.stringify(trashed)}`);
});

test("the first trash keeps the base path, so existing lookups still resolve", async (t) => {
  const { dir, file } = await vaultWith(t, "ONLY");

  const dest = await moveToTrash(dir, file, "victim");
  assert.equal(dest, trashPathFor(dir, "victim"));
});

test("latestTrashPathFor returns the newest version, not the base path", async (t) => {
  const { dir, file } = await vaultWith(t, "VERSION-ONE");
  await moveToTrash(dir, file, "victim");

  await writeFile(file, mem("victim", "VERSION-TWO"), "utf8");
  const second = await moveToTrash(dir, file, "victim");

  const latest = await latestTrashPathFor(dir, "victim");
  assert.equal(latest, second);
  assert.equal(await bodyOf(latest!), "VERSION-TWO");
});

test("latestTrashPathFor returns undefined when nothing was trashed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-trash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await latestTrashPathFor(dir, "never-existed"), undefined);
});

test("restore refuses to overwrite an active file at the destination", async (t) => {
  const { dir, file } = await vaultWith(t, "TRASHED");
  const trashed = await moveToTrash(dir, file, "victim");

  // The id got recreated after the delete — a common shape (archive, then
  // save a fresh memory under the same title).
  await writeFile(file, mem("victim", "ACTIVE-EDIT-DO-NOT-LOSE"), "utf8");

  await assert.rejects(
    () => restoreFromTrash(dir, trashed, file),
    /refusing to restore over an existing file/,
  );
  assert.equal(
    await bodyOf(file),
    "ACTIVE-EDIT-DO-NOT-LOSE",
    "the active version must be untouched",
  );
  assert.equal(await bodyOf(trashed), "TRASHED", "the trashed copy stays recoverable");
});

test("restore into a free destination still works", async (t) => {
  const { dir, file } = await vaultWith(t, "TRASHED");
  const trashed = await moveToTrash(dir, file, "victim");

  const dest = path.join(dir, "memories", "projects", "x", "victim.md");
  await restoreFromTrash(dir, trashed, dest);

  assert.equal(await bodyOf(dest), "TRASHED");
});

test("a crafted id cannot escape the trash folder", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-trash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "sub"), { recursive: true });

  assert.throws(() => trashPathFor(dir, "../../escape"), /refusing trash path/);
});

/**
 * #365/11 — `latestTrashPathFor` matched by prefix, so a dotted neighbour id
 * looked like a timestamp version. For the id `foo`, `foo.bar.md` was a
 * candidate, and a restore of `foo` could put `foo.bar`s trashed content on
 * `foo`s original path. Dotted ids never come out of `slugify()`, but they do
 * come out of hand-written or imported `id:` frontmatter, which
 * `isPathSafeComponent` lets through.
 */

test("a dotted neighbour id is not mistaken for a trashed version", async (t) => {
  const { dir, file } = await vaultWith(t, "NEIGHBOUR", "foo.bar");
  await moveToTrash(dir, file, "foo.bar");

  assert.equal(
    await latestTrashPathFor(dir, "foo"),
    undefined,
    "`foo` was never trashed — `foo.bar.md` must not stand in for it",
  );
});

test("the newest neighbour never outranks the id's own trashed file", async (t) => {
  const { dir, file } = await vaultWith(t, "OWN", "foo");
  const own = await moveToTrash(dir, file, "foo");

  await writeFile(file, mem("foo.bar", "NEIGHBOUR"), "utf8");
  await moveToTrash(dir, file, "foo.bar");

  // Make the neighbour strictly newer, so a prefix match would prefer it.
  const past = new Date(Date.now() - 60_000);
  await utimes(own, past, past);

  const latest = await latestTrashPathFor(dir, "foo");
  assert.equal(latest, own);
  assert.equal(await bodyOf(latest!), "OWN");
});

test("a dotted id still finds its own timestamped versions", async (t) => {
  const { dir, file } = await vaultWith(t, "VERSION-ONE", "foo.bar");
  await moveToTrash(dir, file, "foo.bar");

  await writeFile(file, mem("foo.bar", "VERSION-TWO"), "utf8");
  const second = await moveToTrash(dir, file, "foo.bar");

  const latest = await latestTrashPathFor(dir, "foo.bar");
  assert.equal(latest, second);
  assert.equal(await bodyOf(latest!), "VERSION-TWO");
});

test("an unrelated file in the trash folder is never a candidate", async (t) => {
  const { dir, file } = await vaultWith(t, "OWN");
  const own = await moveToTrash(dir, file, "victim");

  // Neither a version stamp nor the base name — e.g. a stray editor artefact.
  await writeFile(path.join(path.dirname(own), "victim.backup.md"), "STRAY", "utf8");

  assert.equal(await latestTrashPathFor(dir, "victim"), own);
});

/**
 * Codex-Gegenreview: Der Restore erzeugt erst den Hardlink am Zielpfad und
 * entfernt danach den Trash-Link. Scheitert dieses `unlink` — ein nicht
 * beschreibbares Trash-Verzeichnis reicht —, meldete er einen Fehler, während
 * BEIDE Dateien existierten: die aktive und die im Trash, mit derselben id.
 * Ein Fehlschlag muss den Zustand von vorher hinterlassen.
 */
test("scheitert das Aufräumen des Trash-Links, bleibt keine halbe Wiederherstellung zurück", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-restore-halfway-"));
  const trashDir = path.join(dir, ".bastra", "trash");
  const trashed = path.join(trashDir, "m.md");
  const dest = path.join(dir, "m.md");
  try {
    await mkdir(trashDir, { recursive: true });
    await writeFile(trashed, "---\nid: m\ntype: lesson\n---\n\nBody.\n", "utf8");
    // Das Verzeichnis nicht beschreibbar: der Hardlink ans Ziel gelingt, das
    // Entfernen des Trash-Eintrags nicht.
    await chmod(trashDir, 0o500);

    await assert.rejects(restoreFromTrash(dir, trashed, dest));
    assert.equal(existsSync(dest), false, "kein zweiter aktiver Link darf zurückbleiben");
    assert.equal(existsSync(trashed), true, "die Trash-Fassung bleibt unangetastet");
  } finally {
    await chmod(trashDir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

// ── #381: die Marke wird zur Laufzeit geprüft ───────────────────
//
// Die nominale Typisierung schützt den TypeScript-Vertrag; zur Laufzeit war die
// Marke nie geprüft. `@bastra-recall/core` ist ein veröffentlichtes Paket und
// die beiden Primitiven sind exportiert — ein Aufrufer ohne Typprüfung konnte
// ein schlichtes `{ id, locate }` übergeben und damit ohne den Lock arbeiten,
// auf den sich beide verlassen. Die Tests bauen genau diesen Aufrufer nach,
// deshalb das `as never`: In TypeScript ist der Fehler bereits ausgeschlossen,
// und ohne die Laufzeitprüfung wäre er es nirgends sonst.

test("#381: ein nachgebauter Claim kommt nicht an den Trash", async (t) => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "bastra-claim-brand-"));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const file = path.join(vaultRoot, "memories", "m.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, mem("m", "ORIGINAL"), "utf8");

  const gefaelscht = { id: "m", locate: async () => ({ kind: "none" }) } as never;

  await assert.rejects(
    () => moveToTrashUnderClaim(vaultRoot, file, gefaelscht),
    /requires a real id claim/,
    "ohne Marke darf nichts bewegt werden",
  );
  // Und die Datei liegt unangetastet da, wo sie war.
  assert.equal(await bodyOf(file), "ORIGINAL");
  assert.ok(existsSync(file));
});

test("#381: auch der Restore verlangt die Marke", async (t) => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "bastra-claim-brand-restore-"));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const file = path.join(vaultRoot, "memories", "m.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, mem("m", "ORIGINAL"), "utf8");

  // Echt in den Trash — mit gültigem Claim, das ist der Normalweg.
  const trashPath = await moveToTrash(vaultRoot, file, "m");
  assert.ok(existsSync(trashPath));

  const gefaelscht = { id: "m", locate: async () => ({ kind: "none" }) } as never;

  await assert.rejects(
    () => restoreFromTrashUnderClaim(vaultRoot, trashPath, file, gefaelscht),
    /requires a real id claim/,
  );
  assert.ok(existsSync(trashPath), "die Trash-Fassung liegt noch da");
  assert.ok(!existsSync(file), "und nichts wurde zurückgeschrieben");
});

test("#381: der echte Claim aus withIdClaim funktioniert unverändert", async (t) => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "bastra-claim-brand-ok-"));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const file = path.join(vaultRoot, "memories", "m.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, mem("m", "ORIGINAL"), "utf8");

  // Die Prüfung darf den Normalweg nicht anfassen — Trash und Restore am Stück.
  const trashPath = await moveToTrash(vaultRoot, file, "m");
  await withIdClaim({ vaultRoot, id: "m", filePath: file }, (claim) =>
    restoreFromTrashUnderClaim(vaultRoot, trashPath, file, claim),
  );

  assert.equal(await bodyOf(file), "ORIGINAL", "zurückgeholt wie gehabt");
});
