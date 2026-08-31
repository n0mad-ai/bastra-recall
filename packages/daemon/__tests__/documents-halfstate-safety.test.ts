/**
 * Document-Hub — das Commit-Fenster und die halben Zustände
 * (Codex-Gegenreview, zweite Runde).
 *
 * Zwei Löcher, beide gegen den echten Handler nachgestellt, bevor sie zu waren:
 *
 *  1. Der Compare-and-Swap lag VOR dem eigentlichen Commit-Fenster: geprüft,
 *     DANN die Tempdatei geschrieben, DANN veröffentlicht. Eine externe
 *     Änderung, die einsetzt, sobald die Tempdatei erscheint, war danach
 *     spurlos weg — und der Call meldete Erfolg.
 *  2. Ein gescheiterter Commit hinterließ halbe Zustände: die Originaldatei
 *     war schon ersetzt (während die Meldung „Nothing was written here"
 *     behauptete), und ein Move mit Ordnerwechsel ließ Original und Sidecar im
 *     Zielordner zurück, mit einem Frontmatter, das noch auf den alten Ordner
 *     zeigte, und ohne Eintrag im Vault-Index.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  readdir,
  mkdir,
} from "node:fs/promises";
import { writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault } from "@bastra-recall/core";
import {
  saveDocument,
  recategorizeDocument,
  moveDocument,
} from "../src/documents-write-handler.js";

async function harness(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-dochalf-"));
  const vault = new Vault(dir);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, vault };
}

const BASE = {
  title: "Police",
  category: "vertrag",
  tags: ["vertrag"],
  linked_file: false,
  folder_path: "alt",
  overwrite: false,
} as const;

type SaveArgs = Parameters<typeof saveDocument>[1];

/** Ein gültiges Sidecar desselben Dokuments — so, wie es aus Obsidian käme. */
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

async function savedDoc(dir: string, vault: Vault, body?: string) {
  const src = join(dir, "Police.pdf");
  await writeFile(src, "POLICE-V1", "utf8");
  return saveDocument(vault, { ...BASE, original_path: src, body } as SaveArgs);
}

/**
 * Der Auslöser hängt an der ENTSTEHENDEN TEMPDATEI, nicht an einem früheren
 * Zeitpunkt: Genau zwischen „Tempdatei ist da" und `rename` lag das Fenster,
 * das der alte Compare-and-Swap offen ließ. Gepollt statt `fs.watch`, weil
 * kqueue/FSEvents unter macOS Latenz haben und der Trigger deterministisch im
 * Fenster liegen muss — das Sidecar ist dafür absichtlich mehrere Megabyte
 * groß, sein Schreiben dauert also viele Ticks.
 */
function armOnTempFile(folder: string, act: () => void) {
  const state = { fired: false };
  const timer = setInterval(() => {
    if (state.fired) return;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    if (names.some((n) => n.includes(".md.tmp-"))) {
      state.fired = true;
      act();
    }
  }, 1);
  timer.unref?.();
  return { state, stop: () => clearInterval(timer) };
}

/**
 * Das Sidecar so aufblasen, dass das Schreiben seiner Tempdatei viele Ticks
 * dauert — erst dann liegt der Poller oben zuverlässig IM Fenster. Der Body
 * wird nachträglich auf die Platte geschrieben statt beim Save mitgegeben,
 * damit der Injection-Scan nicht über Megabytes läuft.
 */
async function inflateSidecar(path: string, vault: Vault): Promise<void> {
  const parsed = matter(await readFile(path, "utf8"));
  const fat = "Zeile mit belanglosem Inhalt.\n".repeat(400_000);
  await writeFile(path, matter.stringify(`${parsed.content}\n${fat}`, parsed.data), "utf8");
  await vault.reindexFile(path);
}

// ── Befund 1: der CAS lag vor dem Commit-Fenster ────────────────

test("eine externe Änderung während des Tempdatei-Schreibens geht nicht verloren", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  await inflateSidecar(doc.sidecar_path, vault);
  const EXTERN = EXTERNAL_SIDECAR(doc.id);

  const armed = armOnTempFile(join(dir, "documents", "alt"), () =>
    writeFileSync(doc.sidecar_path, EXTERN, "utf8"),
  );
  t.after(armed.stop);

  const outcome = await recategorizeDocument(vault, {
    id: doc.id,
    title: "Police 2026",
  }).then(
    () => "fulfilled" as const,
    (err: Error) => err,
  );
  armed.stop();

  assert.equal(armed.state.fired, true, "das Commit-Fenster wurde getroffen");
  assert.notEqual(outcome, "fulfilled", "ein stiller Erfolg ist der Defekt");
  assert.match((outcome as Error).message, /changed on disk/);
  assert.equal(
    await readFile(doc.sidecar_path, "utf8"),
    EXTERN,
    "die externe Bearbeitung muss unangetastet auf der Platte stehen",
  );
});

test("force überschreibt auch spät keine fremde Datei am Sidecar-Pfad", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  await inflateSidecar(doc.sidecar_path, vault);
  const NOTIZ = "# Meine Gedanken\n\nHandgeschrieben, nirgends sonst.\n";

  const armed = armOnTempFile(join(dir, "documents", "alt"), () =>
    writeFileSync(doc.sidecar_path, NOTIZ, "utf8"),
  );
  t.after(armed.stop);

  const outcome = await recategorizeDocument(vault, {
    id: doc.id,
    title: "Police 2026",
    force: true,
  }).then(
    () => "fulfilled" as const,
    (err: Error) => err,
  );
  armed.stop();

  assert.equal(armed.state.fired, true, "das Commit-Fenster wurde getroffen");
  assert.notEqual(outcome, "fulfilled", "force ist kein Freibrief auf den Pfad");
  assert.match((outcome as Error).message, /no longer the sidecar/);
  assert.equal(
    await readFile(doc.sidecar_path, "utf8"),
    NOTIZ,
    "die fremde Datei muss unangetastet sein",
  );
});

// ── Befund 2: halbe Zustände ────────────────────────────────────

/**
 * `saveDocument` ersetzte die Originaldatei, BEVOR das Sidecar veröffentlicht
 * war. Nachgestellt: Aufruf rejected mit „changed on disk" — und das Original
 * war trotzdem schon die neue Fassung, während die Meldung „Nothing was
 * written here" behauptete.
 *
 * Das Fenster wird über `args.summary` getroffen: der Handler liest das Feld
 * erst NACH dem Kopieren der Originaldatei.
 */
test("ein gescheiterter Overwrite lässt die Originaldatei unverändert", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  const EXTERN = EXTERNAL_SIDECAR(doc.id);

  // Gleicher Dateiname, andere Fassung — sonst wäre es ein anderes Dokument
  // (id und Sidecar-Pfad leiten sich aus dem Basename ab).
  const v2 = join(dir, "zweitquelle", "Police.pdf");
  await mkdir(join(dir, "zweitquelle"), { recursive: true });
  await writeFile(v2, "REPLACEMENT-V2", "utf8");

  let fired = false;
  const args = {
    ...BASE,
    original_path: v2,
    overwrite: true,
    get summary(): string | undefined {
      if (!fired) {
        fired = true;
        writeFileSync(doc.sidecar_path, EXTERN, "utf8");
      }
      return undefined;
    },
  };

  await assert.rejects(
    () => saveDocument(vault, args as SaveArgs),
    /changed on disk/,
  );
  assert.equal(fired, true, "das Commit-Fenster wurde getroffen");

  // Der Endzustand, gemeinsam geprüft.
  assert.equal(
    await readFile(doc.original_path, "utf8"),
    "POLICE-V1",
    "die Originaldatei darf den Fehlschlag nicht überlebt haben — sie darf ihn " +
      "gar nicht erst mitgemacht haben",
  );
  assert.equal(
    await readFile(doc.sidecar_path, "utf8"),
    EXTERN,
    "die externe Bearbeitung bleibt",
  );
  const rest = (await readdir(join(dir, "documents", "alt"))).filter(
    (n) => n.includes(".bak-") || n.includes(".tmp-"),
  );
  assert.deepEqual(rest, [], `kein Backup darf liegenbleiben: ${rest.join(", ")}`);
});

/**
 * Ein Recategorize mit Ordnerwechsel, das NACH dem Datei-Move scheitert. Der
 * Fehler kommt aus dem Call selbst (Getter auf `category`, den der Handler
 * erst nach dem Move liest), das Sidecar am neuen Pfad trägt also noch genau
 * unsere Bytes — der Move muss vollständig zurückgenommen werden.
 *
 * Vorher blieb: alter Ordner leer, neuer Ordner voll, `forgetFile` schon
 * gelaufen, Dokument aus dem Index verschwunden.
 */
test("ein gescheiterter Ordnerwechsel rollt den Move vollständig zurück", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  const before = await readFile(doc.sidecar_path, "utf8");

  const args = {
    id: doc.id,
    folder_path: "neu",
    get category(): string {
      throw new Error("Kaputt nach dem Move");
    },
  };

  await assert.rejects(
    () => recategorizeDocument(vault, args as Parameters<typeof recategorizeDocument>[1]),
    /Kaputt nach dem Move/,
  );

  // Endzustand gemeinsam: beide Ordner, Bytes, Frontmatter, Index.
  const alt = await readdir(join(dir, "documents", "alt"));
  assert.deepEqual(
    alt.sort(),
    ["Police.pdf", "Police.pdf.md"],
    `alter Ordner muss wieder vollständig sein: ${alt.join(", ")}`,
  );
  const neu = await readdir(join(dir, "documents", "neu")).catch(() => []);
  assert.deepEqual(neu, [], `neuer Ordner muss leer sein: ${neu.join(", ")}`);
  assert.equal(await readFile(doc.sidecar_path, "utf8"), before, "Sidecar unverändert");
  assert.equal(
    await readFile(doc.original_path, "utf8"),
    "POLICE-V1",
    "Original unverändert",
  );
  assert.equal(
    matter(before).data.folder_path,
    "alt",
    "das Frontmatter zeigt weiter auf den alten Ordner",
  );
  assert.equal(
    vault.get(doc.id)?.filePath,
    doc.sidecar_path,
    "der Vault-Index kennt das Dokument weiterhin am alten Pfad",
  );
});

/**
 * Derselbe Fehlschlag, aber die externe Änderung IST der Grund: Jemand schreibt
 * während des Commits an den neuen Sidecar-Pfad. Zurückrollen dürfen wir dann
 * nicht — das würde die fremde Bearbeitung an den alten Pfad mitschleifen.
 * Also bleibt der Move stehen, und der Index muss ihm folgen statt auf einen
 * leeren Pfad zu zeigen. Vorher fehlte das Dokument im Index komplett.
 */
test("ein Move, der wegen einer externen Änderung scheitert, lässt keinen halben Zustand zurück", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  const newSidecar = join(dir, "documents", "neu", "Police.pdf.md");
  const EXTERN = EXTERNAL_SIDECAR(doc.id);

  // `commitMoveDocument` liest `args.folder_path` zweimal: einmal für den
  // Datei-Move, einmal beim Bauen des Frontmatters. Der zweite Zugriff liegt
  // hinter dem Move — das Sidecar liegt dann bereits am neuen Pfad.
  let seen = 0;
  const args = {
    id: doc.id,
    get folder_path(): string {
      if (++seen === 2) writeFileSync(newSidecar, EXTERN, "utf8");
      return "neu";
    },
  };

  const outcome = await moveDocument(
    vault,
    args as Parameters<typeof moveDocument>[1],
  ).then(
    () => "fulfilled" as const,
    (err: Error) => err,
  );

  assert.equal(seen >= 2, true, "das Commit-Fenster wurde getroffen");
  assert.notEqual(outcome, "fulfilled", "ein stiller Erfolg ist der Defekt");
  const message = (outcome as Error).message;
  assert.match(message, /changed on disk/);
  // Die Meldung darf nur behaupten, was stimmt: der Move STEHT.
  assert.match(message, /could NOT be fully undone/);
  assert.match(message, /new folder/);

  // Endzustand gemeinsam: beide Ordner, Bytes, Index.
  const alt = await readdir(join(dir, "documents", "alt")).catch(() => []);
  assert.deepEqual(alt, [], `alter Ordner ist leer: ${alt.join(", ")}`);
  const neu = (await readdir(join(dir, "documents", "neu"))).sort();
  assert.deepEqual(neu, ["Police.pdf", "Police.pdf.md"]);
  assert.equal(
    await readFile(newSidecar, "utf8"),
    EXTERN,
    "die externe Bearbeitung muss unangetastet auf der Platte stehen",
  );
  assert.equal(
    await readFile(join(dir, "documents", "neu", "Police.pdf"), "utf8"),
    "POLICE-V1",
  );
  assert.equal(
    vault.get(doc.id)?.filePath,
    newSidecar,
    "der Index muss dem stehengebliebenen Move folgen, nicht ins Leere zeigen",
  );
});

// ── Codex-Gegenreview Runde 10 (P0-3/P0-4) ──────────────────────

test("der Original-Rollback löscht keine externe Fassung", async (t) => {
  // Nachgestellt: Bastra ersetzt Original V1 durch V2, ein externer Writer
  // schreibt danach V3, der Sidecar-CAS schlägt korrekt fehl — und der
  // Rollback löschte V3 und stellte V1 wieder her. Der Sidecar-Schutz
  // verschob den Datenverlust damit nur auf das Original.
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);
  const EXTERN = EXTERNAL_SIDECAR(doc.id);

  const v2 = join(dir, "zweitquelle", "Police.pdf");
  await mkdir(join(dir, "zweitquelle"), { recursive: true });
  await writeFile(v2, "REPLACEMENT-V2", "utf8");

  let fired = false;
  const args = {
    ...BASE,
    original_path: v2,
    overwrite: true,
    get summary(): string | undefined {
      if (!fired) {
        fired = true;
        // Beides im selben Fenster — die Kopie steht schon, der Sidecar noch
        // nicht: eine fremde Fassung des ORIGINALS und eine fremde Fassung des
        // Sidecars, damit der Commit scheitert.
        writeFileSync(doc.original_path, "POLICE-V3-EXTERN", "utf8");
        writeFileSync(doc.sidecar_path, EXTERN, "utf8");
      }
      return undefined;
    },
  };

  const outcome = await saveDocument(vault, args as SaveArgs).then(
    () => "fulfilled" as const,
    (err: Error) => err,
  );

  assert.equal(fired, true, "das Commit-Fenster wurde getroffen");
  assert.notEqual(outcome, "fulfilled", "ein stiller Erfolg ist der Defekt");
  assert.equal(
    await readFile(doc.original_path, "utf8"),
    "POLICE-V3-EXTERN",
    "die externe Fassung des Originals darf der Rollback nicht anfassen",
  );
  assert.match(
    (outcome as Error).message,
    /could not be rolled back/,
    "und der Halbzustand gehört gemeldet, nicht verschwiegen",
  );
});

test("ein Move belegt seine Zielpfade und ersetzt dort nichts", async (t) => {
  const { dir, vault } = await harness(t);
  const doc = await savedDoc(dir, vault);

  // Eine fremde Datei genau am Zielpfad des Originals.
  const neu = join(dir, "documents", "neu");
  await mkdir(neu, { recursive: true });
  await writeFile(join(neu, "Police.pdf"), "FREMD-UND-WICHTIG", "utf8");

  await assert.rejects(
    () => moveDocument(vault, { id: doc.id, folder_path: "neu" }),
    /already exists/,
  );
  assert.equal(await readFile(join(neu, "Police.pdf"), "utf8"), "FREMD-UND-WICHTIG");
  assert.equal(await readFile(doc.original_path, "utf8"), "POLICE-V1", "nichts wurde bewegt");
  assert.deepEqual(
    (await readdir(join(dir, "documents", "alt"))).sort(),
    ["Police.pdf", "Police.pdf.md"],
  );
});
