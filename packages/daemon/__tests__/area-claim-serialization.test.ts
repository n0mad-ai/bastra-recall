/**
 * Codex-Gegenreview Runde 10 — Area-Operationen sind jetzt serialisiert.
 *
 *   - P0-1: Die Grabsteinprüfung im Save lag lange vor dem Publish. Ein Rename,
 *     der dazwischen durchlief, ließ den Save im ALTEN Regal veröffentlichen —
 *     danach existierten beide.
 *   - P0-2: Zwei parallele Renames desselben Namens schrieben beide ihren
 *     Grabstein; in 12 von 12 Läufen zeigte die Marke auf das Ziel des
 *     VERLIERERS.
 *   - P1-1: Ein gewöhnlicher, nachweisbarer Rename-Fehler ließ den vorher
 *     gesetzten Grabstein stehen — das Projekt war danach unbeschreibbar.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/area-claim-serialization.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areaKeyForPath,
  readAreaMark,
  saveMemory,
  withAreaExclusive,
  withAreaShared,
  type SaveMemoryInput,
} from "@bastra-recall/core";
import { createArea, deleteArea, renameArea } from "../src/webui-areas.js";

async function vault(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bastra-areaclaim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "memories", "projects"), { recursive: true });
  return root;
}

function input(over: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return {
    id: "m",
    title: "M",
    type: "lesson",
    summary: "s",
    body: "Body.",
    topic_path: ["t"],
    tags: ["t"],
    recall_when: ["t"],
    scope: "carnexus",
    ...over,
  } as SaveMemoryInput;
}

test("ein laufender Save hält seinen Scope — der Rename daneben schreibt keinen Grabstein", async (t) => {
  const root = await vault(t);
  await createArea(root, "carnexus");

  // Der Save wird im Publish-Fenster festgehalten; genau dort lief bisher ein
  // kompletter Rename durch.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const saving = withAreaShared(root, ["carnexus"], async () => {
    await held;
    return "saved";
  });

  await assert.rejects(
    () => renameArea(root, "project", "carnexus", "neu"),
    /save\(s\) are writing into/,
    "der Rename darf nicht mitten in einen Save laufen",
  );
  // Und er hat nichts hinterlassen: kein Grabstein, kein bewegtes Regal.
  assert.equal(await readAreaMark(root, "carnexus"), null);
  assert.equal(existsSync(join(root, "memories", "projects", "carnexus")), true);
  assert.equal(existsSync(join(root, "memories", "projects", "neu")), false);

  release();
  assert.equal(await saving, "saved");

  // Danach geht der Rename ganz normal.
  await renameArea(root, "project", "carnexus", "neu");
  assert.equal((await readAreaMark(root, "carnexus"))?.to, "neu");
});

test("zwei parallele Renames: die Marke zeigt auf das Regal, das wirklich existiert", async (t) => {
  for (let round = 0; round < 6; round++) {
    const root = await vault(t);
    await createArea(root, "carnexus");
    await saveMemory(root, input());

    const settled = await Promise.allSettled([
      renameArea(root, "project", "carnexus", "ziel-a"),
      renameArea(root, "project", "carnexus", "ziel-b"),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    assert.equal(ok.length, 1, `genau ein Rename darf gewinnen (Runde ${round})`);

    const winner = (ok[0] as PromiseFulfilledResult<{ name: string }>).value.name;
    const mark = await readAreaMark(root, "carnexus");
    assert.equal(mark?.kind, "renamed");
    assert.equal(
      mark?.to,
      winner,
      `der Grabstein muss auf das existierende Regal zeigen, nicht auf das Ziel des Verlierers (Runde ${round})`,
    );
    assert.equal(existsSync(join(root, "memories", "projects", winner)), true);
    const loser = winner === "ziel-a" ? "ziel-b" : "ziel-a";
    assert.equal(existsSync(join(root, "memories", "projects", loser)), false);
  }
});

test("ein gescheiterter Rename lässt keinen Grabstein zurück", async (t) => {
  const root = await vault(t);
  await createArea(root, "carnexus");
  // Eine DATEI am Zielpfad: `isDir()` sagt nein, `rename()` scheitert trotzdem.
  await writeFile(join(root, "memories", "projects", "neu"), "keine Area", "utf8");

  await assert.rejects(() => renameArea(root, "project", "carnexus", "neu"));
  assert.equal(
    await readAreaMark(root, "carnexus"),
    null,
    "das Regal steht unverändert da — dann darf es auch kein Grabstein sperren",
  );
  assert.equal(existsSync(join(root, "memories", "projects", "carnexus")), true);
  // Und ein Save in die unveränderte Area geht weiterhin.
  const saved = await saveMemory(root, input());
  assert.match(saved.file_path, /projects\/carnexus\//);
});

test("Delete und Create desselben Namens laufen nicht gegeneinander", async (t) => {
  const root = await vault(t);
  await createArea(root, "carnexus");

  const settled = await Promise.allSettled([
    deleteArea(root, "project", "carnexus"),
    createArea(root, "carnexus"),
  ]);
  // Beide Ausgänge sind zulässig — verboten ist nur ein Endzustand, in dem der
  // Ordner existiert UND ein Grabstein ihn sperrt.
  const mark = await readAreaMark(root, "carnexus");
  const dirThere = existsSync(join(root, "memories", "projects", "carnexus"));
  assert.equal(
    dirThere && mark !== null,
    false,
    `lebendes Regal mit Grabstein: ${JSON.stringify({ mark, settled: settled.map((s) => s.status) })}`,
  );
});

// ── Codex-Abschlussprüfung: die Sperre selbst ───────────────────

test("einen verwaisten Area-Lock übernimmt genau einer", async (t) => {
  // Nachgestellt mit 30 Runden à 16 Konkurrenten: Der eigene Reclaim
  // (`claimIsAbandoned` + ungeschütztes `rename`) ließ alle 16 gleichzeitig in
  // den exklusiven Abschnitt. Jetzt läuft die Übernahme über
  // `acquireCommitClaim()`, dieselbe Konstruktion wie im Save-Pfad.
  for (let round = 0; round < 6; round++) {
    const root = await vault(t);
    const locks = join(root, ".bastra", "locks");
    await mkdir(locks, { recursive: true });
    // Ein Lock eines Prozesses, den es nachweislich nicht mehr gibt: fremder
    // Host + überaltert, damit `claimIsAbandoned` ihn freigibt.
    const digest = createHash("sha256").update("carnexus").digest("hex").slice(0, 32);
    const lockPath = join(locks, `area-${digest}.lock`);
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, host: "eine-andere-maschine", ts: 0, token: "alt" }),
      "utf8",
    );
    const past = new Date(Date.now() - 5 * 60_000);
    await utimes(lockPath, past, past);

    let inside = 0;
    let maxInside = 0;
    const settled = await Promise.allSettled(
      Array.from({ length: 16 }, () =>
        withAreaExclusive(root, ["carnexus"], async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 5));
          inside--;
        }),
      ),
    );
    assert.equal(maxInside, 1, `nie mehr als einer im exklusiven Abschnitt (Runde ${round})`);
    assert.equal(
      settled.filter((x) => x.status === "fulfilled").length,
      1,
      `genau ein Reclaimer darf gewinnen (Runde ${round})`,
    );
  }
});

test("der Area-Schlüssel kommt aus dem Pfad, nicht aus dem Scope", async (t) => {
  const root = await vault(t);
  assert.equal(areaKeyForPath(root, join(root, "memories/projects/carnexus/m.md")), "carnexus");
  assert.equal(areaKeyForPath(root, join(root, "memories/people/mike.md")), "people");
  assert.equal(areaKeyForPath(root, join(root, "dokumentationen/carnexus/d.md")), "carnexus");
  // Kein Regal: eine Datei direkt in `memories/`, Bookmarks, der Document-Hub.
  assert.equal(areaKeyForPath(root, join(root, "memories/lose.md")), null);
  assert.equal(areaKeyForPath(root, join(root, "bookmarks/b.md")), null);
  assert.equal(areaKeyForPath(root, join(root, "documents/alt/x.md.md")), null);
});

test("ein exklusiver people-Lock blockiert einen Save mit folder: memories/people", async (t) => {
  // Bestätigt war: gehaltener `people`-Lock, `saveMemory({ scope: "carnexus",
  // folder: "memories/people" })` lief glatt durch — ein Top-Rename war damit
  // nicht gegen Saves ins Top-Regal serialisiert.
  const root = await vault(t);
  await mkdir(join(root, "memories", "people"), { recursive: true });

  // Erst warten, bis der Lock WIRKLICH gehalten wird: `withAreaExclusive` läuft
  // bis dahin durch mehrere awaits, und ein Save, der in dieses Fenster fällt,
  // würde umgekehrt die Area-Operation zurücktreten lassen.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const acquired = new Promise<void>((r) => (ready = r));
  const holding = withAreaExclusive(root, ["people"], () => {
    ready();
    return held;
  });
  await acquired;

  await assert.rejects(
    () => saveMemory(root, input({ id: "mike", folder: "memories/people" })),
    /the area 'people' is being renamed, deleted or created right now/,
  );
  assert.equal(existsSync(join(root, "memories", "people", "mike.md")), false);

  release();
  await holding;
  // Und danach geht derselbe Save.
  const saved = await saveMemory(root, input({ id: "mike", folder: "memories/people" }));
  assert.match(saved.file_path, /memories\/people\/mike\.md$/);
});

test("ein Re-File sperrt Quell- UND Zielregal", async (t) => {
  const root = await vault(t);
  await createArea(root, "carnexus");
  const first = await saveMemory(root, input());
  assert.match(first.file_path, /projects\/carnexus\//);

  // Das ZIEL des Re-Files ist gesperrt.
  let releaseTarget!: () => void;
  const heldTarget = new Promise<void>((r) => (releaseTarget = r));
  let targetReady!: () => void;
  const targetAcquired = new Promise<void>((r) => (targetReady = r));
  const holdingTarget = withAreaExclusive(root, ["people"], () => {
    targetReady();
    return heldTarget;
  });
  await targetAcquired;
  await assert.rejects(
    () => saveMemory(root, input({ overwrite: true, folder: "memories/people" })),
    /the area 'people' is being renamed/,
  );
  releaseTarget();
  await holdingTarget;

  // Und die QUELLE ebenso — sie wird beim Umzug getrasht.
  let releaseSource!: () => void;
  const heldSource = new Promise<void>((r) => (releaseSource = r));
  let sourceReady!: () => void;
  const sourceAcquired = new Promise<void>((r) => (sourceReady = r));
  const holdingSource = withAreaExclusive(root, ["carnexus"], () => {
    sourceReady();
    return heldSource;
  });
  await sourceAcquired;
  await assert.rejects(
    () => saveMemory(root, input({ overwrite: true, folder: "memories/people" })),
    /the area 'carnexus' is being renamed/,
  );
  releaseSource();
  await holdingSource;

  // Ohne Sperre zieht er ganz um.
  const moved = await saveMemory(root, input({ overwrite: true, folder: "memories/people" }));
  assert.match(moved.file_path, /memories\/people\//);
  assert.equal(existsSync(first.file_path), false, "die Quelle ist weg");
});
