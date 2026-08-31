/**
 * C-084 — fremde Frontmatter-Keys überleben ein Overwrite (entschieden
 * 29.08.2026).
 *
 * Der Save baut das Frontmatter aus einer festen Feldliste NEU. Alles, was
 * nicht in dieser Liste steht, fiel deshalb bei jedem Overwrite weg — und der
 * häufigste Fall ist kein exotischer: Ein Vault liegt in Obsidian, jemand setzt
 * `cssclasses` im Properties-Panel oder ein Plugin schreibt sein Feld, und der
 * nächste Agenten-Save löscht es kommentarlos. Sichtbar wird das erst, wenn
 * jemand die Datei in der App wieder aufmacht.
 *
 * Geprüft wird deshalb an der Datei und nicht am Rückgabewert: Der Vertrag ist,
 * was auf der Platte steht, nachdem der Save durch ist.
 *
 * Die Gegenrichtung ist genauso wichtig und steht weiter unten: Ein fremder Key
 * darf ein verwaltetes Feld NICHT überstimmen (bekannt schlägt fremd), und die
 * Felder, die der Save bewusst weglässt, dürfen nicht durch die Hintertür
 * zurückkommen.
 *
 * Runner: node --import tsx --test packages/core/__tests__/save-unknown-keys.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import matter from "gray-matter";
import { saveMemory } from "../src/save.js";
import { SAVE_MANAGED_FRONTMATTER_KEYS } from "../src/save-frontmatter.js";
import type { SaveMemoryInput } from "../src/save.js";

const base = (over: Partial<SaveMemoryInput> = {}): SaveMemoryInput =>
  ({
    title: "Deploy Runbook",
    type: "lesson",
    summary: "summary",
    topic_path: ["ops"],
    tags: ["deploy"],
    scope: "testproj",
    recall_when: ["when deploying"],
    body: "Body.",
    ...over,
  }) as SaveMemoryInput;

const FILE = ["memories", "projects", "testproj", "deploy-runbook.md"];

/** Legt das Memory an und schreibt danach fremde Keys ins Frontmatter — so,
 *  wie eine fremde App es täte: an der Save-API vorbei, direkt in die Datei. */
async function seedWithForeignKeys(
  dir: string,
  foreign: Record<string, unknown>,
): Promise<string> {
  await saveMemory(dir, base());
  const file = path.join(dir, ...FILE);
  const parsed = matter(await readFile(file, "utf8"));
  // Kopieren, nicht mutieren — aus demselben Grund wie in `save.ts`:
  // gray-matter cached `matter(content)` je Input-String, und zwei Vaults mit
  // gleichem Inhalt teilen sich denselben Eintrag. Ein `Object.assign` auf
  // `parsed.data` schriebe die fremden Keys in den Cache und damit in jeden
  // folgenden Test, der zufällig dieselbe Datei erzeugt.
  const data = { ...parsed.data, ...foreign };
  await writeFile(file, matter.stringify(parsed.content, data), "utf8");
  return file;
}

test("ein Overwrite erhält einen fremden Key", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-save-foreign-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await seedWithForeignKeys(dir, { cssclasses: ["wide-table"] });

  await saveMemory(dir, base({ summary: "neue summary", overwrite: true }));

  const fm = matter(await readFile(file, "utf8")).data;
  assert.deepEqual(fm.cssclasses, ["wide-table"], "der fremde Key ist weg");
  assert.equal(fm.summary, "neue summary", "und der Save hat trotzdem gewirkt");
});

test("der Obsidian-Fall: Properties aus dem Panel überleben den Agenten-Save", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-save-obsidian-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Was in einem echten Obsidian-Vault an so einer Datei hängt: eine
  // Publish-Markierung, ein Dataview-Feld, ein Datum aus dem Panel, ein
  // verschachtelter Plugin-Block.
  const file = await seedWithForeignKeys(dir, {
    publish: false,
    "dataview-status": "in-progress",
    reviewed_on: "2026-03-14",
    plugin_meta: { pinned: true, colour: "amber", order: 3 },
  });

  await saveMemory(dir, base({ body: "Neuer Text.", overwrite: true }));

  const fm = matter(await readFile(file, "utf8")).data;
  assert.equal(fm.publish, false, "false ist ein Wert, kein fehlendes Feld");
  assert.equal(fm["dataview-status"], "in-progress");
  assert.equal(fm.reviewed_on, "2026-03-14");
  assert.deepEqual(fm.plugin_meta, { pinned: true, colour: "amber", order: 3 });
});

test("bekannt schlägt fremd — ein gleichnamiger Bestandswert überstimmt den Save nicht", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-save-collision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await seedWithForeignKeys(dir, { keeper: "bleibt" });

  // `summary` und `tags` sind verwaltete Felder. Käme der Durchreiche-Schritt
  // vor der Kollisionsregel, stünde hinterher der ALTE Wert in der Datei.
  await saveMemory(
    dir,
    base({ summary: "die neue Fassung", tags: ["deploy", "runbook"], overwrite: true }),
  );

  const fm = matter(await readFile(file, "utf8")).data;
  assert.equal(fm.summary, "die neue Fassung");
  assert.deepEqual(fm.tags, ["deploy", "runbook"]);
  assert.equal(fm.keeper, "bleibt", "der fremde Key daneben ist unberührt");
});

test("die bewusst weggelassenen Bookmark-Felder kommen nicht als fremde Keys zurück", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-save-bookmark-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Die Bookmark-Felder schreibt der Save NUR bei `type: "bookmark"` — ein
  // Memory soll kein bookmark-förmiges Frontmatter tragen. Stehen sie trotzdem
  // in der Datei (hier: von außen hineingeschrieben, wie es ein Import oder
  // eine fremde App täte), muss der Save sie weiterhin weglassen. Genau dafür
  // steht die Bookmark-Gruppe in SAVE_MANAGED_FRONTMATTER_KEYS: Ohne sie wären
  // es „fremde" Keys, und der Durchreiche-Schritt trüge sie zurück in die
  // Datei, aus der sie herausgehalten werden sollen.
  const file = await seedWithForeignKeys(dir, {
    url: "https://example.invalid/artikel",
    read_status: "unread",
    og_image: "https://example.invalid/bild.png",
    source_app: "Safari",
  });

  await saveMemory(dir, base({ overwrite: true }));

  const fm = matter(await readFile(file, "utf8")).data;
  assert.equal(fm.type, "lesson", "es ist und bleibt ein Memory, kein Bookmark");
  assert.ok(!("url" in fm), "url darf nicht als fremder Key zurückkommen");
  assert.ok(!("read_status" in fm), "read_status ebenso wenig");
  assert.ok(!("og_image" in fm), "og_image ebenso wenig");
  assert.ok(!("source_app" in fm), "source_app ebenso wenig");
});

test("eine Neuanlage bringt keine fremden Keys mit", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-save-fresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await saveMemory(dir, base());

  const fm = matter(await readFile(path.join(dir, ...FILE), "utf8")).data;
  // Ohne Vorgängerdatei gibt es nichts durchzureichen — jedes Feld im
  // Frontmatter muss aus der verwalteten Liste stammen.
  const unmanaged = Object.keys(fm).filter((k) => !SAVE_MANAGED_FRONTMATTER_KEYS.has(k));
  assert.deepEqual(unmanaged, [], `unerwartete Felder bei der Neuanlage: ${unmanaged.join(", ")}`);
});

test("der Durchreiche-Schritt prüft fremde Werte nicht — auch nicht auf Typ", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-save-untouched-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Ein Feld, das wie ein verwaltetes aussieht, aber keines ist: Ein fremdes
  // `tags_de` mit einem Wert, den unsere Typprüfungen für `tags` ablehnen
  // würden. Es gehört uns nicht, also fassen wir es nicht an.
  const file = await seedWithForeignKeys(dir, { tags_de: "kein Array", leer: "" });

  await saveMemory(dir, base({ overwrite: true }));

  const fm = matter(await readFile(file, "utf8")).data;
  assert.equal(fm.tags_de, "kein Array");
  assert.equal(fm.leer, "", "ein leerer String ist ein Wert, kein fehlendes Feld");
});
