/**
 * Document-Hub — Identität vor Schreibrecht (Codex-Gegenreview zu #240).
 *
 * Sechs Wege, auf denen ein Write fremde Daten zerstört hat. Jeder hier gegen
 * den echten Handler nachgestellt, bevor er zu war:
 *
 *  1. Eine gewöhnliche Obsidian-Notiz an `<original>.md` galt bei
 *     `overwrite: true` als „das Sidecar" und wurde vollständig ersetzt.
 *  2. `recategorize_document`/`move_document` prüften nur `type === "doc"` —
 *     damit fraßen sie auch PRODUKTDOKUS und schrieben sie zu einem
 *     Document-Hub-Sidecar mit `scope: documents` um.
 *  3. Der Frontmatter-Rebuild beim Recategorize warf alles weg, was nicht in
 *     seiner Feldliste stand: `related`, `related_via`, `sensitivity`,
 *     `source`, eine gepflegte `confidence`.
 *  4. `a+b.pdf` und `a-b.pdf` slugifizieren auf dieselbe id. Zwei Sidecars,
 *     eine id — der Vault indexiert danach nur noch eines davon.
 *  5. Beim Kopieren wurde das Ziel zuerst gelöscht. Schlug `copyFile` fehl
 *     (Quelle ist ein Verzeichnis), war die alte Zieldatei schon weg.
 *  6. Der Sidecar-Tempname trug nur die PID: zwei gleichzeitige Writes auf
 *     dasselbe Sidecar benutzten dieselbe Tempdatei, der zweite `rename` lief
 *     ins Leere (ENOENT).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  stat,
  symlink,
  readdir,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import matter from "gray-matter";
import { Vault } from "@bastra-recall/core";
import {
  saveDocument,
  recategorizeDocument,
  moveDocument,
} from "../src/documents-write-handler.js";

async function harness(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-docid-"));
  const vault = new Vault(dir);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });
  return { dir, vault };
}

const BASE = {
  title: "Vertrag",
  category: "vertrag",
  tags: ["vertrag"],
  linked_file: false,
  folder_path: "",
  overwrite: false,
} as const;

type SaveArgs = Parameters<typeof saveDocument>[1];

// ── 1 ───────────────────────────────────────────────────────────

test("eine fremde Obsidian-Notiz am Sidecar-Pfad wird nie überschrieben", async (t) => {
  const { dir, vault } = await harness(t);

  const folder = join(dir, "documents", "notizen");
  await mkdir(folder, { recursive: true });
  const note = join(folder, "Vertrag.pdf.md");
  const NOTE =
    "# Meine Gedanken zum Vertrag\n\nHandgeschrieben, nirgends sonst.\n";
  await writeFile(note, NOTE, "utf8");

  const src = join(dir, "Vertrag.pdf");
  await writeFile(src, "PDF", "utf8");

  await assert.rejects(
    () =>
      saveDocument(vault, {
        ...BASE,
        original_path: src,
        folder_path: "notizen",
        overwrite: true,
      } as SaveArgs),
    /not a document sidecar|sidecar already exists/,
  );
  assert.equal(
    await readFile(note, "utf8"),
    NOTE,
    "die Notiz muss unangetastet sein",
  );
});

// ── 2 ───────────────────────────────────────────────────────────

/** Ein Produktdoku, wie `save_product_doc` es schreibt. */
async function writeProductDoc(dir: string, vault: Vault): Promise<string> {
  const folder = join(dir, "dokumentationen", "carnexus");
  await mkdir(folder, { recursive: true });
  const path = join(folder, "doku-carnexus-cli.md");
  await writeFile(
    path,
    matter.stringify("# CLI\n\nSo bedienst du die CLI.\n", {
      id: "doku-carnexus-cli",
      title: "CarNexus — CLI",
      type: "doc",
      summary: "Wie die CLI bedient wird.",
      topic_path: ["doku", "carnexus", "cli"],
      tags: ["product-doc", "carnexus"],
      scope: "carnexus",
      recall_when: ["how to use CarNexus CLI"],
      created: "2026-05-01",
      updated: "2026-05-01",
    }),
    "utf8",
  );
  await vault.reindexFile(path);
  return path;
}

test("recategorize_document fasst eine Produktdoku nicht an", async (t) => {
  const { dir, vault } = await harness(t);
  const path = await writeProductDoc(dir, vault);
  const before = await readFile(path, "utf8");

  await assert.rejects(
    () =>
      recategorizeDocument(vault, {
        id: "doku-carnexus-cli",
        title: "Umbenannt",
      }),
    /not a document sidecar/,
  );
  assert.equal(
    await readFile(path, "utf8"),
    before,
    "die Produktdoku bleibt, wie sie war",
  );
});

test("move_document fasst eine Produktdoku nicht an", async (t) => {
  const { dir, vault } = await harness(t);
  const path = await writeProductDoc(dir, vault);
  const before = await readFile(path, "utf8");

  await assert.rejects(
    () =>
      moveDocument(vault, {
        id: "doku-carnexus-cli",
        folder_path: "verschoben",
      }),
    /not a document sidecar/,
  );
  assert.equal(
    await readFile(path, "utf8"),
    before,
    "die Produktdoku bleibt, wo sie war",
  );
});

// ── 3 ───────────────────────────────────────────────────────────

test("recategorize erhält Felder, die nicht in seiner Feldliste stehen", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Police.pdf");
  await writeFile(src, "POLICE", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Police",
    original_path: src,
    folder_path: "alt",
  } as SaveArgs);

  // Alles, was ein gelebtes Sidecar über die Zeit ansammelt: Graph-Kanten
  // vom Related-Enricher, ein Sensitivity-Level, die Provenienz, eine
  // heruntergesetzte confidence.
  const parsed = matter(await readFile(doc.sidecar_path, "utf8"));
  const enriched = {
    ...parsed.data,
    related: ["doc-alt-anderes-pdf"],
    related_via: [
      { id: "doc-alt-anderes-pdf", reason: "gleiche Police", score: 0.8 },
    ],
    sensitivity: "private",
    source: "scan:brother-mfc",
    confidence: 0.6,
  };
  await writeFile(
    doc.sidecar_path,
    matter.stringify(parsed.content, enriched),
    "utf8",
  );
  await vault.reindexFile(doc.sidecar_path);

  await recategorizeDocument(vault, {
    id: doc.id,
    title: "Police 2026",
    force: true,
  });

  const after = matter(await readFile(doc.sidecar_path, "utf8")).data as Record<
    string,
    unknown
  >;
  assert.equal(after.title, "Police 2026", "der gewollte Patch greift");
  assert.deepEqual(after.related, ["doc-alt-anderes-pdf"]);
  assert.deepEqual(after.related_via, [
    { id: "doc-alt-anderes-pdf", reason: "gleiche Police", score: 0.8 },
  ]);
  assert.equal(after.sensitivity, "private");
  assert.equal(after.source, "scan:brother-mfc");
  assert.equal(after.confidence, 0.6);
});

// ── 4 ───────────────────────────────────────────────────────────

test("zwei Dateinamen mit derselben Doc-id ergeben kein zweites Sidecar", async (t) => {
  const { dir, vault } = await harness(t);

  const plus = join(dir, "a+b.pdf");
  const minus = join(dir, "a-b.pdf");
  await writeFile(plus, "PLUS", "utf8");
  await writeFile(minus, "MINUS", "utf8");

  const first = await saveDocument(vault, {
    ...BASE,
    title: "A plus B",
    original_path: plus,
  } as SaveArgs);

  await assert.rejects(
    () =>
      saveDocument(vault, {
        ...BASE,
        title: "A minus B",
        original_path: minus,
      } as SaveArgs),
    /id .* already belongs to/,
  );

  assert.equal(vault.get(first.id)!.filePath, first.sidecar_path);
});

// ── 5 ───────────────────────────────────────────────────────────

test("ein fehlschlagender Kopiervorgang löscht die vorhandene Zieldatei nicht", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Akte.pdf");
  await writeFile(src, "AKTE ORIGINAL", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Akte",
    original_path: src,
    folder_path: "akten",
  } as SaveArgs);

  // Quelle des zweiten Saves ist ein VERZEICHNIS — copyFile muss scheitern.
  const bogus = join(dir, "zweitquelle", "Akte.pdf");
  await mkdir(bogus, { recursive: true });

  await assert.rejects(
    () =>
      saveDocument(vault, {
        ...BASE,
        title: "Akte",
        original_path: bogus,
        folder_path: "akten",
        overwrite: true,
      } as SaveArgs),
    /not a regular file|EISDIR/,
  );

  assert.equal(
    await readFile(doc.original_path, "utf8"),
    "AKTE ORIGINAL",
    "das bestehende Dokument muss den Fehlschlag überleben",
  );
});

// ── 6 ───────────────────────────────────────────────────────────

test("gleichzeitige Writes aufs selbe Sidecar treten sich nicht auf die Tempdatei", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Beleg.pdf");
  await writeFile(src, "BELEG", "utf8");
  await saveDocument(vault, {
    ...BASE,
    title: "Beleg",
    original_path: src,
    folder_path: "belege",
  } as SaveArgs);

  const again = () =>
    saveDocument(vault, {
      ...BASE,
      title: "Beleg",
      original_path: src,
      folder_path: "belege",
      overwrite: true,
    } as SaveArgs);

  const results = await Promise.allSettled([
    again(),
    again(),
    again(),
    again(),
    again(),
    again(),
  ]);
  // Seit dem Umbau auf die ID-Transaktion (Codex-Gegenreview P0) gilt für
  // Dokumente dieselbe Regel wie für Memories: Gleichzeitige Writes auf EINE
  // id serialisieren sich, genau einer gewinnt, die übrigen bekommen einen
  // sichtbaren Write-Conflict. Was es weiterhin NICHT geben darf, ist ein
  // Fehlschlag an geteilter Infrastruktur — einer verschwundenen Tempdatei
  // (ENOENT) etwa, für einen Write, der inhaltlich fertig war.
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(results.length - failed.length, 1, "genau einer gewinnt");
  for (const r of failed) {
    const message = (r as PromiseRejectedResult).reason.message as string;
    assert.match(
      message,
      /write conflict/,
      `nur ein Konflikt ist ein zulässiger Fehlschlag, nicht: ${message}`,
    );
  }

  const sidecar = join(dir, "documents", "belege", "Beleg.pdf.md");
  assert.ok(
    (await stat(sidecar)).isFile(),
    "das Sidecar steht danach vollständig da",
  );
});

test("auch ein Move erhält die Felder außerhalb der Rebuild-Liste", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Bescheid.pdf");
  await writeFile(src, "BESCHEID", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Bescheid",
    original_path: src,
    folder_path: "alt",
  } as SaveArgs);

  const parsed = matter(await readFile(doc.sidecar_path, "utf8"));
  await writeFile(
    doc.sidecar_path,
    matter.stringify(parsed.content, {
      ...parsed.data,
      related: ["doc-alt-akte-pdf"],
      sensitivity: "private",
      confidence: 0.5,
    }),
    "utf8",
  );
  await vault.reindexFile(doc.sidecar_path);

  const moved = await moveDocument(vault, { id: doc.id, folder_path: "neu" });

  const after = matter(await readFile(moved.sidecar_path, "utf8"))
    .data as Record<string, unknown>;
  assert.equal(after.folder_path, "neu", "der Move greift");
  assert.deepEqual(after.related, ["doc-alt-akte-pdf"]);
  assert.equal(after.sensitivity, "private");
  assert.equal(after.confidence, 0.5);
});

// ── 7 ───────────────────────────────────────────────────────────

test("save_document(overwrite) patcht das Sidecar, statt es neu zu bauen", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Police.pdf");
  await writeFile(src, "POLICE", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Police",
    original_path: src,
    folder_path: "versicherung",
    body: "Erfasster Inhalt.",
  } as SaveArgs);

  // Der gelebte Zustand: der Related-Enricher hat Kanten gezogen, jemand hat
  // die Sensitivity gesetzt, die confidence heruntergestuft und in Obsidian
  // einen eigenen Alias vergeben.
  const parsed = matter(await readFile(doc.sidecar_path, "utf8"));
  await writeFile(
    doc.sidecar_path,
    matter.stringify(parsed.content, {
      ...parsed.data,
      created: "2019-03-04",
      aliases: [...(parsed.data.aliases as string[]), "meine-police"],
      related: ["doc-versicherung-antrag-pdf"],
      related_via: [
        { id: "doc-versicherung-antrag-pdf", reason: "same-folder", score: 0.8 },
      ],
      sensitivity: "private",
      source: "scan",
      confidence: 0.4,
    }),
    "utf8",
  );
  await vault.reindexFile(doc.sidecar_path);

  // Eine Titel-/Tag-Korrektur — genau der Metadaten-Refresh, den der Hub
  // selbst anbietet (er gibt den In-Vault-Pfad als original_path zurück).
  await saveDocument(vault, {
    ...BASE,
    title: "Police (korrigiert)",
    tags: ["versicherung", "police"],
    original_path: doc.original_path,
    folder_path: "versicherung",
    overwrite: true,
  } as SaveArgs);

  const after = matter(await readFile(doc.sidecar_path, "utf8")).data as Record<
    string,
    unknown
  >;
  assert.equal(after.title, "Police (korrigiert)", "der Refresh greift");
  assert.deepEqual(after.tags, ["versicherung", "police"]);
  assert.equal(after.created, "2019-03-04", "created ist keine Neuerfassung");
  assert.deepEqual(after.related, ["doc-versicherung-antrag-pdf"]);
  assert.deepEqual(after.related_via, [
    { id: "doc-versicherung-antrag-pdf", reason: "same-folder", score: 0.8 },
  ]);
  assert.equal(after.sensitivity, "private");
  assert.equal(after.source, "scan");
  assert.equal(after.confidence, 0.4);
  assert.ok(
    (after.aliases as string[]).includes("meine-police"),
    "der handvergebene Alias überlebt",
  );
  assert.ok(
    (after.aliases as string[]).includes(doc.id),
    "der id-Alias bleibt trotzdem da",
  );
});

// ── 8 ───────────────────────────────────────────────────────────

test("ein Sidecar mit `scope: Documents` ist dasselbe Sidecar", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Rechnung.pdf");
  await writeFile(src, "RECHNUNG", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Rechnung",
    category: "rechnung",
    original_path: src,
    folder_path: "rechnungen",
  } as SaveArgs);

  const parsed = matter(await readFile(doc.sidecar_path, "utf8"));
  await writeFile(
    doc.sidecar_path,
    matter.stringify(parsed.content, { ...parsed.data, scope: "Documents" }),
    "utf8",
  );
  await vault.reindexFile(doc.sidecar_path);

  // Ungefaltet verglichen ist das Sidecar sich selbst fremd: der Hub
  // verweigert seinem eigenen Dokument Move und Recategorize.
  const moved = await moveDocument(vault, {
    id: doc.id,
    folder_path: "archiv",
  });
  assert.match(moved.sidecar_path, /documents\/archiv\//);
});

// ── 9 ───────────────────────────────────────────────────────────

test("ein quarantänisiertes Sidecar derselben id blockiert den Save", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Akte.pdf");
  await writeFile(src, "AKTE", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Akte",
    original_path: src,
    folder_path: "a",
  } as SaveArgs);

  // Dieselbe id ein zweites Mal auf der Platte — der Index nimmt nur einen
  // Pfad auf und stellt den anderen in Quarantäne.
  const twin = join(dir, "documents", "b", "Akte.pdf.md");
  await mkdir(join(dir, "documents", "b"), { recursive: true });
  await writeFile(twin, await readFile(doc.sidecar_path, "utf8"), "utf8");
  await vault.reconcile();
  const paths = vault.pathsFor(doc.id);
  assert.equal(paths.length, 2, "der Vault kennt beide Pfade");

  // Der Save auf den QUARANTÄNISIERTEN Pfad: `vault.get()` zeigte nur den
  // indexierten, der Pfad passte nicht — und der Save lief durch, während
  // das andere Sidecar mit derselben id unverändert stehen blieb.
  const other = paths.find((p) => p !== doc.sidecar_path)!;
  const loser = other === twin ? doc.sidecar_path : twin;
  await assert.rejects(
    saveDocument(vault, {
      ...BASE,
      title: "Akte",
      original_path: src,
      folder_path: loser.includes(`${sep}b${sep}`) ? "b" : "a",
      overwrite: true,
    } as SaveArgs),
    /already belongs to/,
  );
});

// ── Codex-Gegenreview (P0) ──────────────────────────────────────

/**
 * Der Realpath-Schutz galt für Dokumente noch nicht: Die Containment-Prüfung
 * war rein lexikalisch. Ein Symlink `documents/linked -> /außerhalb` plus
 * `folder_path: "linked"` schrieb Original UND Sidecar außerhalb des Vaults.
 */
test("ein Symlink im Dokumentenordner führt nicht aus dem Vault heraus", async (t) => {
  const { dir, vault } = await harness(t);
  const outside = await mkdtemp(join(tmpdir(), "bastra-doc-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));

  await mkdir(join(dir, "documents"), { recursive: true });
  await symlink(outside, join(dir, "documents", "linked"));

  const src = join(dir, "Geheim.pdf");
  await writeFile(src, "GEHEIM", "utf8");
  await assert.rejects(
    saveDocument(vault, {
      ...BASE,
      title: "Geheim",
      original_path: src,
      folder_path: "linked",
    } as SaveArgs),
    /outside the documents folder/,
  );
  assert.deepEqual(
    await readdir(outside),
    [],
    "nichts darf im Symlink-Ziel gelandet sein",
  );
});

/**
 * Zwei Dateinamen, eine abgeleitete id (`a+b.pdf` und `a-b.pdf` →
 * `doc-a-b-pdf`). Parallel gestartet kamen beide durch, weil die
 * Kollisionsprüfung nur den Index fragte und keine Sperre hielt. Unter der
 * ID-Transaktion gewinnt genau einer, der andere sieht die Kollision.
 */
test("zwei Dateinamen mit derselben abgeleiteten id kollidieren auch parallel", async (t) => {
  const { dir, vault } = await harness(t);
  const plus = join(dir, "a+b.pdf");
  const minus = join(dir, "a-b.pdf");
  await writeFile(plus, "PLUS", "utf8");
  await writeFile(minus, "MINUS", "utf8");

  const results = await Promise.allSettled([
    saveDocument(vault, {
      ...BASE,
      title: "Plus",
      original_path: plus,
      folder_path: "",
    } as SaveArgs),
    saveDocument(vault, {
      ...BASE,
      title: "Minus",
      original_path: minus,
      folder_path: "",
    } as SaveArgs),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "genau ein Sidecar darf die id bekommen");

  const sidecars = (await readdir(join(dir, "documents"))).filter((n) =>
    n.endsWith(".md"),
  );
  assert.equal(
    sidecars.length,
    1,
    `zwei Sidecars mit einer id wären der Defekt: ${sidecars.join(", ")}`,
  );
});

/**
 * Codex-Gegenreview (P0): `recategorizeDocument()` verlor Änderungen still.
 *
 * Es las das Sidecar, baute das Frontmatter neu und schrieb zurück — ohne
 * Sperre und ohne Vergleich. Gemessen: 20 parallele Läufe, einer änderte den
 * Titel, einer die Tags, BEIDE meldeten Erfolg, und in 20 von 20 Läufen blieb
 * nur eine der beiden Änderungen übrig.
 *
 * Unter der ID-Transaktion gewinnt einer, und der andere erfährt es. Ein
 * stiller Verlust ist der einzige unzulässige Ausgang.
 */
test("gleichzeitige Metadaten-Patches verlieren keine Änderung still", async (t) => {
  const { dir, vault } = await harness(t);
  const src = join(dir, "Police.pdf");
  await writeFile(src, "POLICE", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Police",
    original_path: src,
    folder_path: "vertraege",
  } as SaveArgs);

  for (let round = 0; round < 10; round++) {
    const results = await Promise.allSettled([
      recategorizeDocument(vault, { id: doc.id, title: `Titel-${round}`, force: true }),
      recategorizeDocument(vault, { id: doc.id, tags: [`tag-${round}`], force: true }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    for (const r of results) {
      if (r.status === "rejected") {
        assert.match((r.reason as Error).message, /write conflict/, `Runde ${round}`);
      }
    }
    const fm = matter(await readFile(doc.sidecar_path, "utf8")).data;
    if (won.length === 2) {
      // Beide durchgekommen heißt: nacheinander gelaufen. Dann müssen auch
      // BEIDE Änderungen auf der Platte stehen — genau das ging vorher verloren.
      assert.equal(fm.title, `Titel-${round}`, `Runde ${round}: Titel verloren`);
      assert.deepEqual(fm.tags, [`tag-${round}`], `Runde ${round}: Tags verloren`);
    } else {
      assert.equal(won.length, 1, `Runde ${round}: unerwartet ${won.length} Gewinner`);
    }
  }
});

/**
 * Sicherheitsrunde: Die Grenze ist das DOKUMENTENREGAL, nicht der Vault.
 *
 * Ein Symlink, der den Vault gar nicht verlässt, kam an der alten Prüfung
 * vorbei: `dokumente/linked -> ../memories` plus `folder_path: "linked"`
 * schrieb Original UND Sidecar mitten in den Memory-Bestand. Der Pfad lag im
 * Vault, das Regal hatte er trotzdem verlassen.
 */
test("ein Symlink INNERHALB des Vaults führt nicht in ein fremdes Regal", async (t) => {
  const { dir, vault } = await harness(t);
  const foreignShelf = join(dir, "memories", "projects", "fremd");
  await mkdir(foreignShelf, { recursive: true });
  await mkdir(join(dir, "documents"), { recursive: true });
  await symlink(foreignShelf, join(dir, "documents", "linked"));

  const src = join(dir, "Beleg.pdf");
  await writeFile(src, "BELEG", "utf8");
  await assert.rejects(
    saveDocument(vault, {
      ...BASE,
      title: "Beleg",
      original_path: src,
      folder_path: "linked",
    } as SaveArgs),
    /outside the documents folder/,
  );
  assert.deepEqual(
    await readdir(foreignShelf),
    [],
    "im fremden Regal darf nichts gelandet sein",
  );
});

// ── Codex-Gegenreview (P1): Compare-and-Swap vor der Veröffentlichung ──

/**
 * Der Document-Hub verlor externe Änderungen still.
 *
 * Die mtime-Prüfung in `recategorizeDocument` läuft VOR dem ID-Claim, und der
 * Claim serialisiert ohnehin nur Bastra-Writer. Zwischen dem Lesen des
 * Sidecars unter dem Claim und dem `rename` liegt ein Fenster, in dem
 * Obsidian, ein Cloud-Sync oder ein Editor schreiben darf. Was dort landete,
 * war danach spurlos weg — und der Call meldete Erfolg.
 *
 * Nachgestellt wird das Fenster deterministisch statt über ein Rennen: Der
 * Handler liest das Sidecar (`readSidecarRaw`) und greift ERST DANACH auf
 * `args.title` zu (`title: args.title ?? m.fm.title`). Ein Getter auf genau
 * diesem Feld schreibt also exakt in die Lücke zwischen Lesen und
 * Veröffentlichen.
 */
function argsWithExternalWriteAfterRead(
  base: Record<string, unknown>,
  field: "title",
  value: string,
  external: { path: string; content: string },
): Record<string, unknown> {
  let fired = false;
  return {
    ...base,
    get [field]() {
      if (!fired) {
        fired = true;
        writeFileSync(external.path, external.content, "utf8");
      }
      return value;
    },
  };
}

const EXTERNAL_SIDECAR = (id: string) =>
  matter.stringify("\n# Von Hand ergänzt\n\nDieser Absatz kam aus Obsidian.\n", {
    id,
    title: "Police",
    type: "doc",
    aliases: [id],
    summary: "vertrag: Police",
    topic_path: ["documents", "alt"],
    tags: ["vertrag"],
    scope: "documents",
    recall_when: ["find document Police"],
    related: [],
    confidence: 1,
    created: "2026-01-01",
    updated: "2026-01-01",
    original_path: "/egal/Police.pdf",
    document_category: "vertrag",
    linked_file: false,
    folder_path: "alt",
  });

async function savedDoc(dir: string, vault: Vault) {
  const src = join(dir, "Police.pdf");
  await writeFile(src, "POLICE", "utf8");
  return saveDocument(vault, {
    ...BASE,
    title: "Police",
    original_path: src,
    folder_path: "alt",
  } as SaveArgs);
}

test("eine externe Änderung im Commit-Fenster geht nicht verloren", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  const EXTERN = EXTERNAL_SIDECAR(doc.id);

  await assert.rejects(
    () =>
      recategorizeDocument(
        vault,
        argsWithExternalWriteAfterRead(
          { id: doc.id },
          "title",
          "Police 2026",
          { path: doc.sidecar_path, content: EXTERN },
        ) as Parameters<typeof recategorizeDocument>[1],
      ),
    (err: Error) => {
      assert.match(err.message, /changed on disk/);
      // Die Meldung muss sagen, was der Aufrufer TUN kann.
      assert.match(err.message, /read_document/);
      assert.match(err.message, /force=true/);
      return true;
    },
  );

  assert.equal(
    await readFile(doc.sidecar_path, "utf8"),
    EXTERN,
    "die externe Bearbeitung muss unangetastet auf der Platte stehen",
  );
});

test("auch ein Move verliert eine externe Änderung im Commit-Fenster nicht", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  const newSidecar = join(dir, "documents", "neu", "Police.pdf.md");
  const EXTERN = EXTERNAL_SIDECAR(doc.id);

  // `commitMoveDocument` liest `args.folder_path` zweimal: einmal für den
  // Datei-Move (vor dem Lesen des Sidecars), einmal beim Bauen des
  // Frontmatters (danach). Der zweite Zugriff ist das Commit-Fenster — und
  // das Sidecar liegt zu dem Zeitpunkt bereits am NEUEN Pfad.
  let seen = 0;
  const args = {
    id: doc.id,
    get folder_path() {
      if (++seen === 2) writeFileSync(newSidecar, EXTERN, "utf8");
      return "neu";
    },
  };

  await assert.rejects(
    () => moveDocument(vault, args as Parameters<typeof moveDocument>[1]),
    /changed on disk/,
  );
  assert.equal(seen >= 2, true, "das Commit-Fenster wurde überhaupt getroffen");
  assert.equal(
    await readFile(newSidecar, "utf8"),
    EXTERN,
    "die externe Bearbeitung muss unangetastet auf der Platte stehen",
  );
  // Codex-Gegenreview (P0): Bis hierher prüfte der Test nur das gerettete
  // Sidecar — und ließ damit einen halben Zustand durch: Das Original war
  // bereits im Zielordner, `vault.forgetFile()` schon gelaufen, und das
  // Dokument fehlte im Index. Der Endzustand gehört gemeinsam geprüft.
  assert.deepEqual(
    (await readdir(join(dir, "documents", "neu"))).sort(),
    ["Police.pdf", "Police.pdf.md"],
    "Original und Sidecar liegen zusammen, nicht auf zwei Ordner verteilt",
  );
  assert.deepEqual(
    await readdir(join(dir, "documents", "alt")).catch(() => []),
    [],
    "im alten Ordner bleibt nichts liegen",
  );
  assert.equal(
    vault.get(doc.id)?.filePath,
    newSidecar,
    "der Vault-Index muss das Dokument weiter kennen — und zwar dort, wo es liegt",
  );
});

test("ein neu entstehendes Sidecar hat kein Preimage und wird trotzdem geschrieben", async (t) => {
  const { dir, vault } = await harness(t);

  // Fall A: nichts liegt am Pfad — „nicht vorhanden" ist ein gültiger
  // Ausgangszustand, kein Konflikt.
  const doc = await savedDoc(dir, vault);
  assert.equal((await stat(doc.sidecar_path)).isFile(), true);

  // Fall B: der Refresh derselben Datei über `overwrite` — Preimage vorhanden
  // und unverändert, also muss der Vergleich durchgehen.
  const again = await saveDocument(vault, {
    ...BASE,
    title: "Police 2026",
    original_path: doc.original_path,
    folder_path: "alt",
    overwrite: true,
  } as SaveArgs);
  assert.equal(again.sidecar_path, doc.sidecar_path);
  assert.equal(
    matter(await readFile(doc.sidecar_path, "utf8")).data.title,
    "Police 2026",
  );
});

test("force=true überschreibt die externe Bearbeitung bewusst", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);

  await recategorizeDocument(
    vault,
    argsWithExternalWriteAfterRead(
      { id: doc.id, force: true },
      "title",
      "Police 2026",
      { path: doc.sidecar_path, content: EXTERNAL_SIDECAR(doc.id) },
    ) as Parameters<typeof recategorizeDocument>[1],
  );

  assert.equal(
    matter(await readFile(doc.sidecar_path, "utf8")).data.title,
    "Police 2026",
    "force heißt: der eigene Patch gewinnt",
  );
});

/**
 * `force` überstimmt eine BEARBEITUNG, nie eine IDENTITÄT. Landet im
 * Commit-Fenster etwas, das gar nicht mehr das Sidecar dieses Dokuments ist —
 * eine handgeschriebene Obsidian-Notiz am selben Pfad —, dann gibt es nichts,
 * was ein Nutzer mit `force` hätte abnicken können.
 */
test("force überschreibt keine fremde Datei am Sidecar-Pfad", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  const NOTIZ = "# Meine Gedanken\n\nHandgeschrieben, nirgends sonst.\n";

  await assert.rejects(
    () =>
      recategorizeDocument(
        vault,
        argsWithExternalWriteAfterRead(
          { id: doc.id, force: true },
          "title",
          "Police 2026",
          { path: doc.sidecar_path, content: NOTIZ },
        ) as Parameters<typeof recategorizeDocument>[1],
      ),
    /no longer the sidecar/,
  );
  assert.equal(
    await readFile(doc.sidecar_path, "utf8"),
    NOTIZ,
    "die fremde Datei muss unangetastet sein",
  );
});

/**
 * Sicherheitsrunde: Geprüft wurden nur die Nachfahren der Grenze, nie ihre
 * IDENTITÄT. Ist der Dokumentenordner SELBST ein Symlink auf ein aktives
 * Regal, ging jede Prüfung durch — Ziel gegen Ziel verglichen — und Original
 * wie Sidecar landeten mitten im Memory-Bestand. Zusätzlich unsichtbar für
 * den autoritativen ID-Scan, der nicht in Symlink-Verzeichnisse absteigt.
 */
test("ein Dokumentenordner, der selbst ein Symlink ist, wird nicht beschrieben", async (t) => {
  const { dir, vault } = await harness(t);
  const foreignShelf = join(dir, "memories", "projects", "fremd");
  await mkdir(foreignShelf, { recursive: true });
  await symlink(foreignShelf, join(dir, "documents"));

  const src = join(dir, "Beleg.pdf");
  await writeFile(src, "BELEG", "utf8");
  await assert.rejects(
    saveDocument(vault, {
      ...BASE,
      title: "Beleg",
      original_path: src,
      folder_path: "",
    } as SaveArgs),
    /is not .*'s own documents|not .* own documents/,
  );
  assert.deepEqual(
    await readdir(foreignShelf),
    [],
    "im fremden Regal darf nichts gelandet sein",
  );
});
