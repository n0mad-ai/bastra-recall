/**
 * Codex-Gegenreview — vier Restfehler rund um Trash, Re-File und Audit-Vorbild.
 *
 *   - Befund 1 (P0): Beim Re-File wurde die Quelle VOR dem Publish gegen die
 *     Vorlage geprüft und danach ungeprüft getrasht. Eine externe Änderung, die
 *     eintraf, sobald das neue Ziel sichtbar wurde, ging still verloren:
 *     `outcome: fulfilled`, das aktive Memory trug die ALTE Fassung, die
 *     neuere lag nur im Trash.
 *   - Befund 2 (P0): `moveToTrash()` wählte sein Ziel per `existsSync` +
 *     `rename`. Zwei parallele Aufrufe mit derselben id meldeten beide Erfolg,
 *     und im Trash lag nur eine der beiden Fassungen.
 *   - Befund 4 (P1): Das Audit-Vorbild war ein von gray-matter gecachtes,
 *     ungeklontes `data`-Objekt und ließ sich nachträglich verändern.
 *   - Dazu der Area-Grabstein: Ein Save mit dem Scope einer umbenannten Area
 *     legte das gerade weggezogene Regal einfach neu an.
 *
 * Runner: node --import tsx --test packages/core/__tests__/refile-trash-cas.test.ts
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
  markAreaRenamed,
  markAreaDeleted,
  MEMORY_WRITE_CONFLICT,
  type SaveMemoryInput,
} from "../src/index.js";
import { moveToTrashUnderClaim } from "../src/audit-log.js";
import { withIdClaim } from "../src/id-transaction.js";

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

/** Alle .md-Dateien im aktiven Bestand, ohne `.bastra`. */
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

const tick = () => new Promise((r) => setImmediate(r));

// ─── Befund 1 ────────────────────────────────────────────────────

test("eine externe Änderung nach dem Ziel-Publish landet nicht still im Trash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-refile-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await saveMemory(root, input({ body: "Fassung eins." }));
  const targetPath = join(root, "memories", "people", `${ID}.md`);

  // Der externe Writer (Obsidian, Cloud-Sync) kennt den id-Lock nicht. Er
  // schlägt in exakt dem Moment zu, in dem das neue Ziel sichtbar wird — also
  // NACH dem Source-Vergleich, den es vor dem Publish schon gab.
  let raced = false;
  const external = (async () => {
    for (let i = 0; i < 100_000 && !existsSync(targetPath); i++) await tick();
    if (existsSync(first.file_path)) {
      writeFileSync(first.file_path, "---\nid: umzug\ntype: lesson\n---\n\nEXTERN.\n", "utf8");
      raced = true;
    }
  })();

  const outcome = await saveMemory(root, input({ overwrite: true, folder: "memories/people" }))
    .then((r) => ({ ok: true as const, r }))
    .catch((e) => ({ ok: false as const, e: e as Error & { code?: string } }));
  await external;

  assert.ok(raced, "die externe Änderung muss vor dem Trashen gelandet sein");
  assert.equal(outcome.ok, false, "ein verlorener Schreibvorgang darf nicht als Erfolg gelten");
  if (outcome.ok) return;
  assert.equal((outcome.e as { code?: string }).code, MEMORY_WRITE_CONFLICT);

  // Die externe Fassung ist der aktive Bestand — nicht das, was der Save
  // veröffentlicht hätte, und nicht nur eine Trash-Kopie.
  assert.deepEqual(
    await activeFiles(root),
    [first.file_path],
    "die Quelle bleibt aktiv, das Ziel wird zurückgerollt",
  );
  assert.match(await readFile(first.file_path, "utf8"), /EXTERN/);
});

test("ohne Dazwischenschreiben zieht ein Re-File weiterhin ganz um", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-refile-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await saveMemory(root, input());
  const moved = await saveMemory(root, input({ overwrite: true, folder: "memories/people" }));

  assert.equal(moved.refiled_from, first.file_path);
  assert.deepEqual(await activeFiles(root), [moved.file_path]);
  assert.ok(existsSync(join(root, ".bastra", "trash", `${ID}.md`)));
});

// ─── Befund 2 ────────────────────────────────────────────────────

/** Ein Memory-File mit genau der id, die der Claim trägt — seit
 *  Codex-Gegenreview Runde 10 (P0-5) prüft die Trash-Primitive diese Bindung
 *  selbst, und ein nackter Marker-String ist kein Memory. */
const mem = (id: string, marker: string) => `---\nid: ${id}\ntype: lesson\n---\n\n${marker}\n`;
const bodyOf = (raw: string) => raw.split("---\n")[2]?.trim() ?? "";

test("zwei parallele Trash-Bewegungen derselben id verlieren keine Fassung", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-trash-par-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const a = join(root, "a.md");
  const b = join(root, "b.md");
  await writeFile(a, mem("victim", "INHALT-A"), "utf8");
  await writeFile(b, mem("victim", "INHALT-B"), "utf8");

  // EIN echter Claim, zwei gleichzeitige Bewegungen darunter: Genau das ist
  // die Frage dieses Tests — belegt die Zielpfadwahl atomar? Ein nachgebauter
  // Claim geht seit der Nominalisierung nicht mehr.
  const settled = await withIdClaim({ vaultRoot: root, id: "victim", filePath: a }, (claim) =>
    Promise.allSettled([
      moveToTrashUnderClaim(root, a, claim),
      moveToTrashUnderClaim(root, b, claim),
    ]),
  );
  assert.deepEqual(
    settled.map((s) => s.status),
    ["fulfilled", "fulfilled"],
  );

  const trashDir = join(root, ".bastra", "trash");
  const names = (await readdir(trashDir)).sort();
  assert.equal(names.length, 2, `beide Fassungen müssen im Trash liegen, gefunden: ${names}`);
  const contents = (
    await Promise.all(names.map(async (n) => bodyOf(await readFile(join(trashDir, n), "utf8"))))
  ).sort();
  assert.deepEqual(contents, ["INHALT-A", "INHALT-B"]);
});

test("moveToTrashUnderClaim bewegt nichts, wenn die Datei nicht mehr die erwartete ist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-trash-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const file = join(root, "m.md");
  const neu = mem("m", "NEU");
  await writeFile(file, neu, "utf8");

  await assert.rejects(
    () =>
      withIdClaim({ vaultRoot: root, id: "m", filePath: file }, (claim) =>
        moveToTrashUnderClaim(root, file, claim, "ALT"),
      ),
    (err: Error & { code?: string }) => err.code === MEMORY_WRITE_CONFLICT,
  );
  assert.equal(await readFile(file, "utf8"), neu, "die Datei bleibt, wo sie ist");
  assert.equal(existsSync(join(root, ".bastra", "trash")), false);
});

test("ein Claim beweist keinen Besitz an einem beliebigen Pfad", async (t) => {
  // Codex-Gegenreview Runde 10 (P0-5): Mit einem echten Claim für A und dem
  // PFAD von B verschwand B aus dem Bestand und landete unter `a.md` im Trash,
  // während A aktiv blieb.
  const root = await mkdtemp(join(tmpdir(), "bastra-claim-bind-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const a = join(root, "a.md");
  const b = join(root, "b.md");
  await writeFile(a, mem("a", "MEMORY-A"), "utf8");
  await writeFile(b, mem("b", "MEMORY-B"), "utf8");

  await assert.rejects(
    () =>
      withIdClaim({ vaultRoot: root, id: "a", filePath: a }, (claim) =>
        moveToTrashUnderClaim(root, b, claim),
      ),
    /does not hold memory 'a'/,
  );
  assert.ok(existsSync(b), "B bleibt im Bestand");
  assert.equal(existsSync(join(root, ".bastra", "trash")), false);
});

// ─── Befund 3/4: das Vorbild kommt aus der Mutation und ist geklont ──

test("saveMemory reicht das unter dem Claim gelesene Vor- und Nachbild heraus", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-preimage-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = await saveMemory(root, input({ source: "version-0.4" }));
  assert.equal(created.audit_before, null, "ein Create hat kein Vorbild");
  assert.equal(created.audit_after.source, "version-0.4");

  // Re-File: Die Vorlage ist die QUELLE, nicht der (noch leere) Zielpfad.
  const moved = await saveMemory(
    root,
    input({ overwrite: true, folder: "memories/people", body: "Neuer Body." }),
  );
  assert.equal(
    moved.audit_before?.source,
    "version-0.4",
    "das Vorbild muss die Quelldatei beschreiben, nicht das leere Ziel",
  );
  assert.equal(moved.audit_after.source, "version-0.4");
});

test("das Vorbild ist tief geklont — ein zweiter gray-matter-Parse kann es nicht verändern", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-preimage-clone-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await saveMemory(root, input({ tags: ["eins"] }));
  const filePath = join(root, "memories", "projects", "proj", `${ID}.md`);
  const raw = await readFile(filePath, "utf8");

  const second = await saveMemory(root, input({ overwrite: true, tags: ["zwei"] }));
  assert.deepEqual(second.audit_before?.tags, ["eins"]);

  // gray-matter cached `matter(content)` je Input-String: Dieser Parse liefert
  // dasselbe `data`-Objekt, aus dem das Vorbild gebildet wurde.
  const parsed = matter(raw).data as Record<string, unknown>;
  (parsed.tags as string[]).push("GESCHMUGGELT");
  parsed.title = "GESCHMUGGELT";

  assert.deepEqual(second.audit_before?.tags, ["eins"], "das Vorbild darf sich nicht ändern");
  assert.equal(second.audit_before?.title, "Umzug");
});

// ─── Area-Grabstein ─────────────────────────────────────────────

test("ein Save mit dem Scope einer umbenannten Area schreibt nichts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-area-mark-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });

  await markAreaRenamed(root, "proj", "proj-neu");

  await assert.rejects(
    () => saveMemory(root, input({ scope: "proj" })),
    /renamed to 'proj-neu'/,
  );
  assert.deepEqual(await activeFiles(root), [], "das weggezogene Regal darf nicht neu entstehen");
});

test("ein Save mit dem Scope einer gelöschten Area schreibt nichts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-area-del-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await markAreaDeleted(root, "proj");

  await assert.rejects(() => saveMemory(root, input({ scope: "proj" })), /was deleted/);
  assert.deepEqual(await activeFiles(root), []);
});
