/**
 * Der Daemon importiert `@bastra-recall/core` über dessen package.json-exports
 * — also `packages/core/dist`, nicht `packages/core/src`. Jeder daemon-Test,
 * der core-Verhalten prüft, misst deshalb den zuletzt GEBAUTEN Core, nicht den
 * aktuellen Quellstand.
 *
 * Das ist keine Theorie: In der Reparaturkette um #360 lief die gesamte
 * daemon-Suite mehrfach grün gegen eine dist, die vor den core-Änderungen
 * gebaut worden war. Ein Fix in core konnte damit "grün" melden, ohne von
 * einem einzigen daemon-Test berührt worden zu sein — und ein Defekt, den ein
 * externer Prüfer gegen den Quellstand reproduzierte, blieb hier unsichtbar.
 *
 * Der Schutz ist zweiteilig: `pretest` im Root-package.json baut core vor
 * jedem Lauf, und dieser Test schlägt an, falls jemand ihn entfernt oder die
 * Suite ohne ihn startet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("../../core", import.meta.url));

/** Neuester mtime aller .ts unter dir (ohne dist/node_modules). */
function newestSource(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      newest = Math.max(newest, newestSource(full));
    } else if (e.name.endsWith(".ts")) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

test("core/dist ist nicht älter als core/src — sonst testet der Daemon einen alten Core", () => {
  const src = newestSource(join(CORE, "src"));
  let dist: number;
  try {
    dist = statSync(join(CORE, "dist", "index.js")).mtimeMs;
  } catch {
    assert.fail(
      "packages/core/dist fehlt. Der Daemon importiert core über dist — ohne Build " +
        "prüfen die daemon-Tests nichts. `npm run build --workspace=@bastra-recall/core`.",
    );
  }
  assert.ok(
    dist >= src,
    `packages/core/dist ist älter als packages/core/src (${new Date(dist).toISOString()} < ` +
      `${new Date(src).toISOString()}). Die daemon-Tests messen dann den zuletzt gebauten ` +
      `Core, nicht den aktuellen Quellstand — grüne Läufe sagen hier nichts aus. ` +
      "Abhilfe: npm run build --workspace=@bastra-recall/core (macht pretest automatisch).",
  );
});
