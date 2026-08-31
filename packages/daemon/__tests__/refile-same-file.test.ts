/**
 * Re-Filing darf die Datei nicht trashen, die es gerade geschrieben hat.
 *
 * Der Befund, nachgestellt auf APFS: Bestand `memories/People/case-id.md`,
 * Save mit `folder: memories/people` und `overwrite: true`. Ein
 * case-insensitives Dateisystem trifft dabei DIESELBE Datei, `saveMemory`
 * meldet aber die angeforderte Schreibweise zurück. Der Aufräumschritt
 * verglich `previous.filePath !== result.file_path` als STRINGS, hielt die
 * beiden für zwei Dateien und schob die „alte" in den Trash. Ergebnis:
 * „Save complete", und danach existiert keiner der beiden gemeldeten Pfade.
 *
 * Auf einem case-SENSITIVEN Dateisystem sind es wirklich zwei Dateien; dann
 * ist das Trashen richtig und der Test prüft genau das. Beide Ausgänge stehen
 * unten — was der Test festnagelt, ist die Regel: nach dem Save existiert der
 * gemeldete Pfad.
 *
 * Runner: `tsx --test __tests__/refile-same-file.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, sameFile } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";

const memory = (id: string) =>
  [
    "---",
    `id: ${id}`,
    "title: Case Person",
    "type: reference",
    "summary: eine Person",
    "topic_path:",
    "  - people",
    "tags:",
    "  - person",
    "scope: refile-test",
    "recall_when:",
    "  - case person",
    "created: 2026-08-26",
    "updated: 2026-08-26",
    "---",
    "",
    "ALT",
    "",
  ].join("\n");

test("Re-Filing nur der Schreibweise nach lässt das einzige Memory stehen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-refile-"));
  const upper = join(dir, "memories", "People", "case-id.md");
  let search: SearchIndex | undefined;
  let vault: Vault | undefined;
  try {
    await mkdir(join(dir, "memories", "People"), { recursive: true });
    await writeFile(upper, memory("case-id"), "utf8");

    vault = new Vault(dir);
    await vault.init();
    search = new SearchIndex(vault);
    search.start();
    const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };

    const res = await saveMemoryHandler(deps, {
      title: "Case Person",
      id: "case-id",
      type: "reference",
      summary: "eine Person",
      body: "NEU",
      topic_path: ["people"],
      tags: ["person"],
      scope: "refile-test",
      recall_when: ["case person"],
      folder: "memories/people",
      overwrite: true,
    });

    assert.ok(existsSync(res.file_path), `der gemeldete Pfad existiert: ${res.file_path}`);
    assert.match(await readFile(res.file_path, "utf8"), /NEU/);

    if (sameFile(upper, res.file_path)) {
      // case-insensitiv (APFS): eine Datei, zwei Schreibweisen — nichts zu trashen.
      assert.ok(existsSync(upper), "die Bestandsdatei wurde nicht in den Trash geschoben");
    } else {
      // case-sensitiv: wirklich zwei Dateien, die alte gehört weg.
      assert.equal(existsSync(upper), false, "die alte Datei wurde korrekt getrasht");
    }
  } finally {
    search?.stop();
    await vault?.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
