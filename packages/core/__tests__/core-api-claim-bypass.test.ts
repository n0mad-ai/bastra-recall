/**
 * Codex-Gegenreview (P0): Die Invariante muss an der API-Oberfläche halten.
 *
 * „Eine ID, eine Datei, ein transaktionaler Writer" war zuletzt eine Aussage
 * über die INTERNEN Aufrufstellen. Die öffentlich exportierten Einstiege boten
 * daneben zwei Wege am autoritativen Plattenscan vorbei:
 *
 *   - `saveMemory(vault, input, { authority })` — der Aufrufer brachte die
 *     Auskunft „wo lebt diese id" selbst mit, und eine veraltete Auskunft unter
 *     dem Lock ist wieder der ursprüngliche Doppel-ID-Defekt.
 *   - `mutateMemoryFile(file, id, mutation)` ohne `vaultRoot` — lief ganz ohne
 *     Claim, also neben jeder Transaktion.
 *
 * Dazu `deleteMemoryFile`, das per blindem `unlink` auf einen Pfad löschte,
 * ohne je zu prüfen, welches Memory dort liegt.
 *
 * Runner: node --import tsx --test packages/core/__tests__/core-api-claim-bypass.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveMemory,
  deleteMemoryFile,
  mutateMemoryFile,
  type Located,
  type SaveMemoryInput,
  type SaveMemoryCommitOptions,
} from "../src/index.js";

const ID = "bypass";

function input(over: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return {
    id: ID,
    title: "Bypass",
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

const memoryFile = (id: string, body = "ALT") =>
  `---\nid: ${id}\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\n` +
  `scope: proj\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\n${body}\n`;

test("eine mitgegebene authority hebelt den Plattenscan nicht mehr aus", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await saveMemory(root, input());

  // Genau der Aufruf, mit dem der Reviewer den Defekt reproduziert hat: eine
  // veraltete Auskunft „die id ist frei", übergeben über den öffentlichen
  // Commit-Vertrag. `as unknown as` steht hier, weil der Vertrag das Feld nicht
  // mehr kennt — der Test prüft, dass es auch zur LAUFZEIT nichts mehr bewirkt,
  // denn ein JS-Aufrufer sieht keine Typen.
  const stale = {
    authority: { locate: async (): Promise<Located> => ({ kind: "none" }) },
  } as unknown as SaveMemoryCommitOptions;

  await assert.rejects(
    saveMemory(root, input({ folder: "memories/people" }), stale),
    /memory already exists/,
    "der Scan unter dem Lock entscheidet, nicht der Aufrufer",
  );

  assert.deepEqual(
    await activeFiles(root),
    [first.file_path],
    "kein zweites File mit derselben id",
  );
});

test("mutateMemoryFile ohne vaultRoot wird abgewiesen, statt am Claim vorbeizuschreiben", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-mutate-noroot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "m.md");
  const before = memoryFile("m");
  await writeFile(file, before, "utf8");

  // Der Aufruf, den es bisher gab: drei Argumente, kein Vault. Über Typen
  // unerreichbar, über JS jederzeit — deshalb die Laufzeitprüfung.
  const untyped = mutateMemoryFile as unknown as (
    f: string,
    id: string,
    m: { frontmatter: (fm: Record<string, unknown>) => Record<string, unknown> },
  ) => Promise<unknown>;

  await assert.rejects(
    untyped(file, "m", { frontmatter: (fm) => ({ ...fm, obsolete: true }) }),
    /requires a vaultRoot/,
  );
  assert.equal(await readFile(file, "utf8"), before, "nichts geschrieben");
});

test("deleteMemoryFile löscht nur, was unter dem Claim DIESES Memory ist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "memories");
  await mkdir(dir, { recursive: true });

  // Ein veralteter Index zeigt auf einen Pfad, an dem inzwischen ein ANDERES
  // Memory liegt. Vorher hätte das blinde `unlink` es gelöscht.
  const foreign = join(dir, "fremd.md");
  await writeFile(foreign, memoryFile("fremd"), "utf8");
  await assert.rejects(
    deleteMemoryFile(foreign, "meins", { vaultRoot: root }),
    /does not hold memory 'meins'/,
  );
  assert.ok(existsSync(foreign), "die fremde Datei steht noch");

  // Und der gewöhnliche Fall funktioniert unverändert.
  const own = join(dir, "meins.md");
  await writeFile(own, memoryFile("meins"), "utf8");
  const res = await deleteMemoryFile(own, "meins", { vaultRoot: root });
  assert.equal(res.deleted, true);
  assert.equal(existsSync(own), false);
});
