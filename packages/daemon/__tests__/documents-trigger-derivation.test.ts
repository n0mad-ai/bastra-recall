/**
 * Issue #289: der abgeleitete Default-Trigger eines Dokuments muss das Dokument
 * unterscheiden.
 *
 * Gemessen an einem echten Vault: die Phrase `"sonstiges"` stand als
 * `recall_when` von 19 Dokumenten, `"foto bild unsortiert"` von 4 — der
 * mittlere Default-Trigger war `tags.slice(0,3).join(" ")` und damit für jedes
 * Dokument derselbe, sobald die Tags generisch waren. Ein Trigger, der eine
 * Situation beansprucht, die er nicht auflösen kann, ist schlechter als keiner:
 * er zieht auf einem Feld mit Gewicht 5 beliebig viele Dokumente hoch.
 *
 * Run: npx tsx --test packages/daemon/__tests__/documents-trigger-derivation.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault } from "@bastra-recall/core";

import { saveDocument } from "../src/documents-write-handler.js";

async function triggersOf(
  vault: Vault,
  dir: string,
  file: string,
  title: string,
  tags: string[],
  category: string,
  recallWhen?: string[],
): Promise<string[]> {
  const source = join(dir, file);
  await writeFile(source, "fake-bytes");
  const result = await saveDocument(vault, {
    original_path: source,
    folder_path: "Inbox",
    title,
    tags,
    category,
    linked_file: false,
    overwrite: false,
    ...(recallWhen ? { recall_when: recallWhen } : {}),
  });
  const fm = matter(await readFile(result.sidecar_path, "utf8")).data as {
    recall_when: string[];
  };
  return fm.recall_when;
}

test("der abgeleitete Tag-Trigger traegt den Titel, statt nur die Kategorie zu wiederholen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-doc-trigger-"));
  try {
    const vault = new Vault(join(dir, "vault"));
    await vault.init();

    const triggers = await triggersOf(
      vault,
      dir,
      "afd-pitch-v2_2026-05-09.pdf",
      "afd-pitch-v2",
      ["sonstiges"],
      "sonstiges",
    );

    // Der blanke Kategoriename darf nicht mehr als eigener Trigger dastehen.
    assert.equal(
      triggers.includes("sonstiges"),
      false,
      `bare category still stands as a trigger: ${JSON.stringify(triggers)}`,
    );
    // Aber die Kategorie geht nicht verloren — sie wird nur unterscheidbar.
    const tagTrigger = triggers.find((t) => t.startsWith("sonstiges"));
    assert.ok(tagTrigger, `no tag-derived trigger at all: ${JSON.stringify(triggers)}`);
    assert.ok(
      tagTrigger.includes("afd-pitch-v2"),
      `tag trigger does not name the document: ${tagTrigger}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zwei Dokumente derselben Kategorie bekommen verschiedene Trigger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-doc-trigger-"));
  try {
    const vault = new Vault(join(dir, "vault"));
    await vault.init();

    const first = await triggersOf(
      vault,
      dir,
      "PHOTO-2026-01-27-13-24-26.jpg",
      "PHOTO-2026-01-27-13-24-26",
      ["foto", "bild", "unsortiert"],
      "bild",
    );
    const second = await triggersOf(
      vault,
      dir,
      "PHOTO-2026-01-27-16-34-01.jpg",
      "PHOTO-2026-01-27-16-34-01",
      ["foto", "bild", "unsortiert"],
      "bild",
    );

    // Genau das war der Befund: identische Tags, identischer Trigger.
    const shared = first.filter((t) => second.includes(t));
    assert.deepEqual(
      shared,
      [],
      `two documents share a trigger verbatim: ${JSON.stringify(shared)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ein mitgeschickter Kategorie-Trigger wird ebenso qualifiziert wie ein abgeleiteter", async () => {
  // Der gemessene Schaden kam NICHT über den Default: ein Agent hat beim
  // Massenimport `["nach Dokument suchen <Name>", "<Kategorie>", "file <Name>"]`
  // von Hand mitgeschickt. Eine Regel, die nur den Default absichert, hätte
  // genau diesen Vorfall nicht verhindert.
  const dir = await mkdtemp(join(tmpdir(), "bastra-doc-trigger-"));
  try {
    const vault = new Vault(join(dir, "vault"));
    await vault.init();

    const triggers = await triggersOf(
      vault,
      dir,
      "afd-pitch-v2_2026-05-09.pdf",
      "afd-pitch-v2",
      ["sonstiges"],
      "sonstiges",
      ["nach Dokument suchen afd-pitch-v2", "sonstiges", "file afd-pitch-v2_2026-05-09"],
    );

    assert.equal(
      triggers.includes("sonstiges"),
      false,
      `a hand-written bare category survived: ${JSON.stringify(triggers)}`,
    );
    // Die beiden dokumentspezifischen Trigger bleiben Wort für Wort erhalten.
    assert.ok(triggers.includes("nach Dokument suchen afd-pitch-v2"), JSON.stringify(triggers));
    assert.ok(triggers.includes("file afd-pitch-v2_2026-05-09"), JSON.stringify(triggers));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explizit uebergebene recall_when bleiben unangetastet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-doc-trigger-"));
  try {
    const vault = new Vault(join(dir, "vault"));
    await vault.init();

    const own = ["Stromrechnung Januar nachschlagen"];
    const triggers = await triggersOf(
      vault,
      dir,
      "rechnung.pdf",
      "Stromrechnung Januar",
      ["rechnung"],
      "finanzen",
      own,
    );

    assert.deepEqual(triggers, own);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
