/**
 * Codex-Gegenreview (P1): Das Audit-Vorbild war nicht an die Mutation gebunden.
 *
 * Die Mutation las ihre Vorlage längst autoritativ unter dem ID-Claim, die
 * Aufrufer bildeten `diff_before` aber weiter selbst — aus dem Vault-Cache, aus
 * dem Zielpfad oder aus einem zweiten Vaultscan. Zwei Reproduktionen:
 *
 *   - `saveMemoryWithAuditTrail()` protokollierte bei einem gewöhnlichen
 *     Re-File `operation: update` mit `diff_before: null`: Es las den ZIELPFAD,
 *     den es beim Umzug noch gar nicht gibt — die Vorlage ist die Quelldatei.
 *   - Beim audit-behafteten Re-File über den MCP-Handler meldete `diff_before`
 *     die indexierte Fassung, während der Save die Quelldatei gepatcht hat.
 *
 * Seither reicht `saveMemory` sein unter dem Claim gelesenes Vor- und Nachbild
 * im Ergebnis heraus, und jeder Audit-Aufrufer benutzt genau das.
 *
 * Runner: `tsx --test __tests__/audit-preimage-binding.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, saveMemory, type SaveMemoryInput } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { saveMemoryWithAuditTrail, resetAuditLogCache } from "../src/audit-trail.js";

interface AuditLine {
  memory_id: string;
  operation: string;
  diff_before: Record<string, unknown> | null;
  diff_after: Record<string, unknown> | null;
}

async function auditEntries(vaultPath: string): Promise<AuditLine[]> {
  const raw = await readFile(join(vaultPath, ".bastra", "audit-log.ndjson"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditLine);
}

function input(over: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return {
    id: "umzug",
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

async function vaultDir(t: { after: (fn: () => unknown) => void }): Promise<string> {
  resetAuditLogCache();
  const dir = await mkdtemp(join(tmpdir(), "bastra-audit-preimage-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return dir;
}

test("saveMemoryWithAuditTrail protokolliert beim Re-File das Vorbild der QUELLE", async (t) => {
  const dir = await vaultDir(t);

  await saveMemoryWithAuditTrail({
    vaultRoot: dir,
    input: input({ source: "version-0.4" }),
    actor: "system",
    actorDetail: "test:create",
    sessionId: "s1",
  });

  const moved = await saveMemoryWithAuditTrail({
    vaultRoot: dir,
    input: input({ overwrite: true, folder: "memories/people", body: "Neuer Body." }),
    actor: "system",
    actorDetail: "test:refile",
    sessionId: "s1",
  });
  assert.equal(moved.created, false);

  const entries = await auditEntries(dir);
  assert.equal(entries.length, 2);
  const update = entries[1];
  assert.equal(update.operation, "update");
  assert.notEqual(
    update.diff_before,
    null,
    "eine Änderung ohne Vorzustand ist im Trail nicht rekonstruierbar",
  );
  assert.equal(
    update.diff_before?.source,
    "version-0.4",
    "das Vorbild muss die Quelldatei beschreiben",
  );
  assert.equal(update.diff_after?.source, "version-0.4");
});

test("der MCP-Save protokolliert das Vorbild der Datei, die er gepatcht hat", async (t) => {
  const dir = await vaultDir(t);
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
  });

  // Bewusst AM INDEX VORBEI angelegt: genau die Lage, in der der Cache-Blick
  // des Handlers etwas anderes sieht als die Platte. Der Save patcht die
  // Datei, die es gibt — der Cache kennt sie nicht.
  await saveMemory(dir, input({ source: "version-0.4" }));
  assert.equal(
    vault.get("umzug"),
    undefined,
    "Voraussetzung der Reproduktion: der Index kennt das Memory noch nicht",
  );

  const result = await saveMemoryHandler(
    deps,
    input({ overwrite: true, body: "Neuer Body." }) as Record<string, unknown>,
  );
  assert.equal((result as { created: boolean }).created, false);
  // Das Vorbild ist Audit-Material, kein Tool-Payload: Es trägt die volle
  // Frontmatter (auch `sensitivity: private`) und darf nicht über den Spread
  // an den Client durchrutschen.
  assert.deepEqual(
    Object.keys(result).filter((k) => k.startsWith("audit_")),
    [],
    "audit_before/audit_after gehören nicht in die Tool-Antwort",
  );

  const entries = await auditEntries(dir);
  const update = entries[entries.length - 1];
  assert.equal(update.operation, "update");
  assert.equal(
    update.diff_before?.source,
    "version-0.4",
    "ein Update ohne Vorzustand ist im Trail nicht rekonstruierbar",
  );
  assert.equal(update.diff_after?.scope, "proj");
});
