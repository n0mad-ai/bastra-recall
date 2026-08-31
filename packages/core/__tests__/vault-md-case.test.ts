/**
 * Codex-Befund 7: Initialscan und Watcher waren sich uneinig, was eine
 * Markdown-Datei ist.
 *
 * Nachgestellt: `UPPER.MD` liegt im Vault. `vault.init()` lud sie nicht
 * (`extname(name) === ".md"`, exakt), ein explizites `reindexFile()` schon
 * (die Read-Seite kennt keine Extension-Regel), und nach einem Neustart war
 * sie wieder weg. Der Watcher hätte sie sogar hinzugefügt
 * (`p.toLowerCase().endsWith(".md")`) — dieselbe Datei war also je nach
 * Eingangstür Memory oder Nichts.
 *
 * Runner: node --import tsx --test packages/core/__tests__/vault-md-case.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/index.js";

function memoryMarkdown(id: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${id}`,
    "type: lesson",
    "summary: s",
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
    "Body.",
    "",
  ].join("\n");
}

test("vault.init() loads .MD like the watcher does — one extension rule, not two", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-mdcase-"));
  await writeFile(join(dir, "UPPER.MD"), memoryMarkdown("upper-case-note"), "utf8");
  await writeFile(join(dir, "lower.md"), memoryMarkdown("lower-case-note"), "utf8");
  const vault = new Vault(dir);
  try {
    await vault.init();
    assert.ok(vault.get("lower-case-note"), "control: the lowercase file loads");
    assert.ok(
      vault.get("upper-case-note"),
      "UPPER.MD is a memory to the watcher — the initial walk must agree",
    );

    // Und der Neustart darf sie nicht wieder verlieren: genau das war der
    // Vorfall — per reindexFile sichtbar, nach Restart weg.
    const second = new Vault(dir);
    await second.init();
    assert.ok(second.get("upper-case-note"), "the .MD memory survives a restart");
    await second.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
