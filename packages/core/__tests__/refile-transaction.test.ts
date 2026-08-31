/**
 * Codex-Gegenreview (P0): Ein Umzug ist EINE Operation.
 *
 * Zwei Befunde, dieselbe Wurzel — das Re-Filing war halb im Save-Pfad und halb
 * in den Aufrufern:
 *
 *   - Ein direkter `saveMemory(overwrite: true, folder: neuesRegal)` schrieb
 *     die neue Datei, ließ die alte stehen und meldete `created: true`. Das
 *     Aufräumen lag in `tool-handlers.ts` und `auditedSave` und lief NACH der
 *     Freigabe des id-Locks; ein Absturz dazwischen hinterließ zwei aktive
 *     Dateien mit einer id.
 *   - Der Zielpfad kam aus dem injizierten Locator, also im Daemon aus dem
 *     Vault-Index. War der veraltet, schrieb der Save auf den alten Pfad, und
 *     die autoritative Auskunft las die Abweichung als bewusstes Re-Filing.
 *     Ergebnis wieder: zwei aktive Dateien.
 *
 * Die Unterscheidung, die beides trägt: Ein vom Index ABGELEITETER Ordner ist
 * kein Re-File-Auftrag. Nur ein ausdrücklich übergebener `folder` ist einer.
 *
 * Runner: node --import tsx --test packages/core/__tests__/refile-transaction.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import {
  saveMemory,
  MEMORY_WRITE_CONFLICT,
  type SaveMemoryInput,
  type Located,
} from "../src/index.js";

const ID = "umzug";

function input(over: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return {
    id: ID,
    title: "Umzug",
    type: "lesson",
    summary: "s",
    body: "Body.",
    topic_path: ["t"],
    tags: ["t"],
    scope: "proj",
    recall_when: ["t"],
    ...over,
  } as SaveMemoryInput;
}

/** Alle .md-Dateien im Vault, ohne den Trash unter `.bastra`. */
async function activeFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await activeFiles(root, full)));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

test("ein Re-Filing trasht die Quelle unter derselben Transaktion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-refile-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await saveMemory(root, input());
  assert.equal(first.created, true);

  const moved = await saveMemory(
    root,
    input({ overwrite: true, folder: "memories/people" }),
  );
  assert.match(moved.file_path, /people/);
  assert.equal(moved.created, false, "ein Umzug erschafft nichts");
  assert.equal(moved.refiled_from, first.file_path);

  assert.deepEqual(
    await activeFiles(root),
    [moved.file_path],
    "die alte Datei darf nicht als zweite aktive Datei stehenbleiben",
  );
  assert.ok(
    existsSync(join(root, ".bastra", "trash", `${ID}.md`)),
    "sie liegt im Trash, nicht im Nichts",
  );
});

test("ein veralteter Locator verschiebt das Memory nicht", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-stale-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await saveMemory(root, input());
  // Extern verschoben — der Index bekommt davon nichts mit.
  const elsewhereDir = join(root, "memories", "people");
  await mkdir(elsewhereDir, { recursive: true });
  const elsewhere = join(elsewhereDir, `${ID}.md`);
  await writeFile(elsewhere, await readFile(first.file_path, "utf8"), "utf8");
  await rm(first.file_path);

  // Der Locator antwortet weiter mit dem alten Pfad — genau die Auskunft, die
  // ein Daemon mit veraltetem Index gäbe.
  const staleLocator = {
    locate: (): Located => ({ kind: "unique", filePath: first.file_path }),
  };

  const updated = await saveMemory(
    root,
    input({ overwrite: true, summary: "neu" }),
    { locator: staleLocator },
  );

  assert.deepEqual(
    await activeFiles(root),
    [elsewhere],
    "ohne ausdrücklichen folder darf kein zweites File am veralteten Pfad entstehen",
  );
  assert.equal(updated.file_path, elsewhere);
  assert.equal(updated.refiled_from, undefined, "das war kein Umzug");
  assert.equal(matter(await readFile(elsewhere, "utf8")).data.summary, "neu");
});

test("ein AUSDRÜCKLICHER folder bleibt ein Re-File-Auftrag", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-explicit-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await saveMemory(root, input());
  const moved = await saveMemory(
    root,
    input({ overwrite: true, folder: "memories/people" }),
    { locator: { locate: (): Located => ({ kind: "unique", filePath: first.file_path }) } },
  );

  assert.match(moved.file_path, /people/, "der Auftrag des Callers gewinnt");
  assert.equal(moved.refiled_from, first.file_path);
  assert.deepEqual(await activeFiles(root), [moved.file_path]);
});

test("eine extern geänderte QUELLE bricht das Re-File ab, statt sie zu überholen", async (t) => {
  // Codex-Gegenreview (P0): Beim Re-Filing ist die Quelle die Patch-Vorlage,
  // aber verglichen wurde vor dem Publish nur das ZIEL — und getrasht wurde die
  // Quelle danach ungeprüft. Der id-Lock hilft dagegen nicht: Obsidian und
  // Cloud-Sync kennen ihn nicht. Ergebnis war ein Erfolg, nach dem das aktive
  // Memory die ALTE Fassung trug und die neuere nur noch im Trash lag.
  const root = await mkdtemp(join(tmpdir(), "bastra-refile-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await saveMemory(root, input({ body: "before-external" }));
  const beforeRaw = await readFile(first.file_path, "utf8");
  const externalRaw = beforeRaw.replace("before-external", "after-external");
  assert.notEqual(externalRaw, beforeRaw);

  // Der externe Writer schlägt zu, NACHDEM die Vorlage gelesen ist und BEVOR
  // veröffentlicht wird. Das Fenster ist sonst nicht deterministisch zu
  // treffen, deshalb hängt der Test am ersten Zugriff auf `body` — der liegt
  // im Save genau dort, zwischen Vorlage und Commit.
  const order = input({ overwrite: true, folder: "memories/people" });
  let fired = false;
  const withExternalEdit = new Proxy(order, {
    get(t2, prop, recv) {
      if (prop === "body" && !fired) {
        fired = true;
        writeFileSync(first.file_path, externalRaw, "utf8");
      }
      return Reflect.get(t2, prop, recv);
    },
  }) as SaveMemoryInput;

  await assert.rejects(
    saveMemory(root, withExternalEdit),
    (err: unknown) =>
      (err as { code?: string }).code === MEMORY_WRITE_CONFLICT &&
      /source file changed/.test((err as Error).message),
    "eine überholte Vorlage ist ein Write-Conflict, kein Erfolg",
  );
  assert.equal(fired, true, "der externe Writer muss im Fenster gelandet sein");

  assert.deepEqual(
    await activeFiles(root),
    [first.file_path],
    "nichts veröffentlicht — das Ziel darf gar nicht erst entstehen",
  );
  assert.equal(
    await readFile(first.file_path, "utf8"),
    externalRaw,
    "die neuere Fassung steht unangetastet im aktiven Bestand",
  );
  assert.equal(
    existsSync(join(root, ".bastra", "trash", `${ID}.md`)),
    false,
    "und nichts wurde getrasht",
  );
});
