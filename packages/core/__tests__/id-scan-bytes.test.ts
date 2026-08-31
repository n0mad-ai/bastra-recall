/**
 * Codex-Gegenreview (Telemetrie): `id_scan.bytes` zählte keine Bytes.
 *
 * `stats.bytes += raw.length` zählt UTF-16-Codeeinheiten. Jeder Umlaut wiegt
 * auf der Platte 2 Bytes und zählte 1, ein Emoji 4 gegen 2 — auf einem
 * deutschsprachigen Vault meldete das Feld „Gelesene Bytes" damit systematisch
 * zu wenig. Und es ist genau die Zahl, an der der Preis des autoritativen
 * Plattenscans abgelesen wird (siehe `IdScanObservation`): Wer den Preis zu
 * niedrig misst, sieht eine Regression nicht.
 *
 * Runner: node --import tsx --test packages/core/__tests__/id-scan-bytes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVaultForIdAsync, type IdScanStats } from "../src/memory-locator.js";

function memoryMarkdown(id: string, summary: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${id}`,
    "type: lesson",
    `summary: ${summary}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    "  - probe",
    `created: ${now}`,
    `updated: ${now}`,
    "---",
    "",
    "Größe, Übergrößen und ähnliche Ausdrücke — plus ein 🧠.",
    "",
  ].join("\n");
}

test("id_scan.bytes misst UTF-8-Bytes, nicht UTF-16-Codeeinheiten", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-idscan-bytes-"));
  try {
    const file = join(root, "umlaute.md");
    const content = memoryMarkdown("umlaute", "Ärger, Öl, Übermaß und ein 🧠");
    await writeFile(file, content, "utf8");
    // Kontrolle: Die Datei ist auf der Platte messbar größer als ihre
    // Zeichenkette lang ist — sonst prüft der Test nichts.
    const onDisk = (await stat(file)).size;
    assert.ok(onDisk > content.length, "Kontrolle: Nicht-ASCII belegt mehr Bytes als Zeichen");

    const stats: IdScanStats = { dirs: 0, files: 0, bytes: 0, blindSpots: 0 };
    const located = await scanVaultForIdAsync(root, "umlaute", stats);

    assert.equal(located.kind, "unique", "Kontrolle: der Scan hat die Datei gelesen");
    assert.equal(stats.files, 1);
    assert.equal(stats.bytes, onDisk, "gezählt werden muss, was wirklich von der Platte kam");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
