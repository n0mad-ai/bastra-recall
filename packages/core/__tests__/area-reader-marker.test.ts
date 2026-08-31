/**
 * #379 — eine Reader-Markierung, die sich nicht löschen lässt, darf das Regal
 * nicht dauerhaft blockieren.
 *
 * `withAreaShared` legt vor jedem Save eine Markierung an und entfernte sie im
 * `finally` über `unlink(path).catch(() => {})` — jeder Fehler verschwand. Das
 * Tückische daran ist die Folge: Eine liegengebliebene Markierung trägt die pid
 * des NOCH LAUFENDEN Prozesses, `claimIsAbandoned` verweigert die Freigabe also
 * völlig korrekt, und der Vault hält einen Save für aktiv, den es nicht gibt.
 * Jedes Rename, Delete und Create auf diesem Regal scheitert danach, bis der
 * Prozess endet — ohne dass irgendwo stünde, warum.
 *
 * Der Repro des Issues ist ein schreibgeschützter readers-Ordner — allerdings
 * erst AB dem Moment, in dem die Markierung schon liegt: Ist der Ordner von
 * vornherein dicht, scheitert bereits das Eintragen, und der Save bricht ab,
 * ohne je etwas zu hinterlassen. Der Leak entsteht, wenn die Rechte zwischen
 * Anlegen und Aufräumen wechseln (Mount, Berechtigungsänderung, ein Ordner,
 * der einem anderen Nutzer gehört). Diese Tests nehmen die Rechte deshalb
 * INNERHALB von `fn` weg.
 *
 * Zwei Stufen, die der Fix unterscheidet: Schreibrecht am VERZEICHNIS weg
 * (dann scheitert `unlink`, die Datei selbst lässt sich aber noch entwerten)
 * und gar kein Zugriff mehr (dann bleibt nur die Meldung).
 *
 * Runner: node --import tsx --test packages/core/__tests__/area-reader-marker.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withAreaShared, withAreaExclusive } from "../src/area-claim.js";
import { normalizeScopeKey } from "../src/scope.js";
import { onMutationIncident, type MutationIncident } from "../src/mutation-incident.js";

const AREA = "testproj";

/** Denselben Pfad bilden wie `areaLockPaths` — der readers-Ordner ist nicht
 *  exportiert, und der Test soll ihn nicht raten. */
function readersDir(root: string, name: string): string {
  const digest = createHash("sha256").update(normalizeScopeKey(name)).digest("hex").slice(0, 32);
  return join(root, ".bastra", "locks", `area-${digest}.readers`);
}

async function vault(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bastra-reader-marker-"));
  t.after(async () => {
    // Der Test nimmt Schreibrechte weg; ohne Rückgabe schlägt das Aufräumen fehl.
    await chmod(readersDir(root, AREA), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function collect<T>(fn: () => Promise<T>): Promise<{ result: T; seen: MutationIncident[] }> {
  const seen: MutationIncident[] = [];
  const off = onMutationIncident((i) => seen.push(i));
  try {
    return { result: await fn(), seen };
  } finally {
    off();
  }
}

test("der Normalfall: die Markierung verschwindet und meldet nichts", async (t) => {
  const root = await vault(t);

  const { seen } = await collect(() => withAreaShared(root, [AREA], async () => "ok"));

  assert.deepEqual(await readdir(readersDir(root, AREA)), [], "kein Marker bleibt liegen");
  assert.deepEqual(seen, [], "ein gelungener Release ist kein Incident");
});

test("lässt sich die Markierung nicht löschen, wird sie entwertet und gemeldet", async (t) => {
  const root = await vault(t);
  // Einen Lauf durchlassen, damit der readers-Ordner existiert.
  await withAreaShared(root, [AREA], async () => undefined);
  const dir = readersDir(root, AREA);

  const err = console.error;
  console.error = () => {};
  let seen: MutationIncident[];
  try {
    // Die Markierung liegt schon, dann fällt das Schreibrecht am Verzeichnis
    // weg: `unlink` scheitert mit EACCES, das Überschreiben der Datei selbst
    // bleibt erlaubt.
    ({ seen } = await collect(() =>
      withAreaShared(root, [AREA], async () => {
        await chmod(dir, 0o500);
      }),
    ));
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    console.error = err;
  }

  const incident = seen.find((i) => i.phase === "reader-marker-release");
  assert.ok(incident, `ein Incident muss ankommen, gesehen: ${JSON.stringify(seen)}`);
  assert.equal(incident.op, "area_shared");
  assert.equal(
    incident.status,
    "rolled_back",
    "entwertet heißt: die Blockade läuft aus, es braucht keinen Menschen",
  );

  // Die Markierung liegt noch da, trägt aber keine pid mehr — genau das lässt
  // sie nach der Altersregel verfallen, statt an einem lebenden Prozess zu
  // hängen.
  const [file] = await readdir(dir);
  assert.ok(file, "die Markierung liegt noch da");
  const body = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown>;
  assert.equal(body.released, true);
  assert.ok(!("pid" in body), "ohne pid greift die Altersregel statt der Besitzerregel");
});

test("die entwertete Markierung blockiert das Regal nicht dauerhaft", async (t) => {
  const root = await vault(t);
  await withAreaShared(root, [AREA], async () => undefined);
  const dir = readersDir(root, AREA);

  const err = console.error;
  console.error = () => {};
  try {
    await withAreaShared(root, [AREA], async () => {
      await chmod(dir, 0o500);
    });
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    console.error = err;
  }

  // Solange die entwertete Markierung frisch ist, gilt sie als lebender Reader
  // — das ist richtig so, ein Save könnte gerade erst fertig geworden sein.
  await assert.rejects(
    () => withAreaExclusive(root, [AREA], async () => undefined),
    /are writing into/,
    "frisch entwertet zählt noch als in flight",
  );

  // Nach dem Verwaisungsfenster ist sie weg — ohne die Entwertung hinge sie an
  // der pid dieses Prozesses und bliebe bis zum Prozessende liegen.
  const [file] = await readdir(dir);
  const old = new Date(Date.now() - 60_000);
  await utimes(join(dir, file), old, old);

  await withAreaExclusive(root, [AREA], async () => undefined);
  assert.deepEqual(await readdir(dir), [], "die verfallene Markierung ist eingesammelt");
});

test("auch ohne Schreibrecht auf die Markierung bleibt der Befund sichtbar", async (t) => {
  const root = await vault(t);
  await withAreaShared(root, [AREA], async () => undefined);
  const dir = readersDir(root, AREA);

  const err = console.error;
  const lines: string[] = [];
  console.error = (msg: unknown) => void lines.push(String(msg));
  let seen: MutationIncident[];
  try {
    // Weder löschen noch entwerten: das Verzeichnis verliert sein Schreibrecht
    // (kein `unlink`) UND die Markierung selbst wird nur-lesbar (kein
    // Überschreiben). Das ist der Fall, in dem die Blockade wirklich steht.
    ({ seen } = await collect(() =>
      withAreaShared(root, [AREA], async () => {
        const [file] = await readdir(dir);
        await chmod(join(dir, file), 0o400);
        await chmod(dir, 0o500);
      }),
    ));
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    for (const f of await readdir(dir).catch(() => [])) {
      await chmod(join(dir, f), 0o600).catch(() => {});
    }
    console.error = err;
  }

  const incident = seen.find((i) => i.phase === "reader-marker-release");
  assert.ok(incident, `ein Incident muss ankommen, gesehen: ${JSON.stringify(seen)}`);
  assert.equal(
    incident.status,
    "partial",
    "hier ist die Blockade echt — das ist der Status, der einen Menschen braucht",
  );
  assert.ok(
    lines.some((l) => l.includes("until the process restarts")),
    `die Konsequenz muss dastehen, gesehen: ${JSON.stringify(lines)}`,
  );
});
