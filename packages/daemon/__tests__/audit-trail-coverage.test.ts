/**
 * #206 — the audit trail has to cover the path the agent actually writes
 * through.
 *
 * The append-only log and its wrappers existed since the Mac-app work, but
 * were wired into exactly one caller: `bridge.ts`. Every write over MCP or
 * REST — which is how the assistant writes — went past it. The one surface
 * that runs autonomously was the one with no record.
 *
 * Telemetry does not close that hole: it can be switched off and it is pruned
 * after 90 days. The audit log is append-only and permanent.
 *
 * These tests pin the coverage itself, not the format — a future write path
 * that forgets to record should fail here rather than be discovered later by
 * someone trying to reconstruct what happened.
 *
 * Runner: `tsx --test __tests__/audit-trail-coverage.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, archiveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { importVault } from "../src/import-vault.js";

interface AuditLine {
  memory_id: string;
  operation: string;
  actor: string;
  actor_detail?: string;
  diff_before: Record<string, unknown> | null;
  diff_after: Record<string, unknown> | null;
  file_path?: string;
  reason?: string;
  session_id?: string;
  timestamp: string;
}

async function makeDeps(): Promise<{ deps: ToolDeps; vaultPath: string; cleanup: () => Promise<void> }> {
  resetAuditLogCache();
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-audit-"));
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath };
  return {
    deps,
    vaultPath,
    cleanup: async () => {
      search.stop();
      await vault.stop?.();
      resetAuditLogCache();
      await rm(vaultPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

async function auditEntries(vaultPath: string): Promise<AuditLine[]> {
  const raw = await readFile(join(vaultPath, ".bastra", "audit-log.ndjson"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditLine);
}

const memo = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "project-fact",
  summary: `Zusammenfassung für ${title}`,
  body: `Inhalt von ${title}.`,
  topic_path: ["test"],
  tags: ["test"],
  scope: "audittest",
  recall_when: [`wenn ${title} gebraucht wird`],
  ...extra,
});

test("#206: an MCP save is recorded — the path that had no trail at all", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, memo("Erster Eintrag"));
    const entries = await auditEntries(vaultPath);
    assert.equal(entries.length, 1, "exactly one entry per write");
    const e = entries[0];
    assert.equal(e.memory_id, res.id);
    assert.equal(e.operation, "create");
    assert.equal(e.actor, "assistant");
    assert.equal(e.actor_detail, "mcp:save_memory", "the surface must be identifiable");
    assert.equal(e.diff_before, null, "a create has no before-state");
    assert.ok(e.diff_after, "the after-state is what makes the entry reconstructable");
    assert.equal(e.file_path, res.file_path);
    assert.ok(e.session_id, "entries must correlate with the run that caused them");
    assert.ok(Date.parse(e.timestamp) > 0, "timestamp must be parseable");
  } finally {
    await cleanup();
  }
});

test("#206: an overwrite is an update and carries the previous state", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    await saveMemoryHandler(deps, memo("Wird geändert"));
    await saveMemoryHandler(deps, memo("Wird geändert", { overwrite: true, body: "Neuer Inhalt." }));

    const entries = await auditEntries(vaultPath);
    assert.equal(entries.length, 2);
    const update = entries[1];
    assert.equal(update.operation, "update");
    assert.ok(update.diff_before, "an update without a before-state cannot be reconstructed");
    assert.equal(
      (update.diff_before as Record<string, unknown>).title,
      "Wird geändert",
      "the before-state must be the frontmatter as it actually was",
    );
  } finally {
    await cleanup();
  }
});

test("#206: archiving is recorded as a delete with the state it had", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const saved = await saveMemoryHandler(deps, memo("Wird archiviert"));
    await archiveMemoryHandler(deps, { id: saved.id });

    const entries = await auditEntries(vaultPath);
    const del = entries.find((e) => e.operation === "delete");
    assert.ok(del, "archiving takes a memory out of the index — that must leave a record");
    assert.equal(del!.memory_id, saved.id);
    assert.equal(del!.actor_detail, "mcp:archive_memory");
    assert.ok(del!.diff_before, "the state before archiving is the recoverable part");
    assert.equal(del!.diff_after, null);
  } finally {
    await cleanup();
  }
});

test("#206: a supersede reason reaches the log", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const old = await saveMemoryHandler(deps, memo("Alt"));
    const fresh = await saveMemoryHandler(deps, memo("Neu"));
    await archiveMemoryHandler(deps, { id: old.id, superseded_by: fresh.id });

    const del = (await auditEntries(vaultPath)).find((e) => e.operation === "delete");
    assert.ok(del);
    assert.match(del!.reason ?? "", new RegExp(fresh.id), "the successor belongs in the record");
  } finally {
    await cleanup();
  }
});

test("#206: the log is append-only — earlier entries are never rewritten", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    await saveMemoryHandler(deps, memo("Eins"));
    const afterFirst = await auditEntries(vaultPath);
    await saveMemoryHandler(deps, memo("Zwei"));
    await saveMemoryHandler(deps, memo("Eins", { overwrite: true, body: "Geändert." }));
    const afterAll = await auditEntries(vaultPath);

    assert.equal(afterAll.length, 3);
    assert.deepEqual(afterAll[0], afterFirst[0], "the first entry must survive byte-identical");
  } finally {
    await cleanup();
  }
});

test("#206: a failing audit never costs the user their write", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    // The audit log lives under .bastra/ — make that path un-writable by
    // occupying it with a file where a directory has to go.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(vaultPath, ".bastra"), { recursive: true });
    await writeFile(join(vaultPath, ".bastra", "audit-log.ndjson"), "", "utf8");
    const { rm: rmOne } = await import("node:fs/promises");
    await rmOne(join(vaultPath, ".bastra", "audit-log.ndjson"));
    await mkdir(join(vaultPath, ".bastra", "audit-log.ndjson"), { recursive: true });

    const res = await saveMemoryHandler(deps, memo("Trotzdem gespeichert"));
    assert.ok(res.id, "the save must succeed even when the trail cannot be written");
    assert.ok(deps.vault.get(res.id), "and the memory must really be in the vault");
  } finally {
    await cleanup();
  }
});

test("#287: one folder import is reconstructable as one audit run", async () => {
  resetAuditLogCache();
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-audit-import-vault-"));
  const sourcePath = await mkdtemp(join(tmpdir(), "bastra-audit-import-source-"));
  try {
    await writeFile(join(sourcePath, "one.md"), "# One\n\nFirst imported note.\n", "utf8");
    await writeFile(join(sourcePath, "two.md"), "# Two\n\nSecond imported note.\n", "utf8");

    const first = await importVault(vaultPath, sourcePath, { label: "audit-batch" });
    const firstEntries = await auditEntries(vaultPath);
    assert.equal(firstEntries.length, first.ids.length, "every successful import write needs one entry");
    assert.ok(firstEntries.length >= 2);
    assert.deepEqual(
      new Set(firstEntries.map((e) => e.memory_id)),
      new Set(first.ids),
      "the trail must name every node the import reported",
    );
    assert.ok(firstEntries.every((e) => e.actor === "import"));
    assert.ok(firstEntries.every((e) => e.actor_detail === "import:vault"));
    assert.ok(firstEntries.every((e) => e.operation === "create"));
    assert.equal(
      new Set(firstEntries.map((e) => e.session_id)).size,
      1,
      "all nodes from one invocation need one shared run id",
    );
    const firstRun = firstEntries[0].session_id;
    assert.ok(firstRun);

    await importVault(vaultPath, sourcePath, { label: "audit-batch" });
    const allEntries = await auditEntries(vaultPath);
    const secondEntries = allEntries.slice(firstEntries.length);
    assert.equal(secondEntries.length, firstEntries.length);
    assert.ok(secondEntries.every((e) => e.operation === "update"));
    assert.ok(secondEntries.every((e) => e.diff_before !== null));
    assert.equal(new Set(secondEntries.map((e) => e.session_id)).size, 1);
    assert.notEqual(secondEntries[0].session_id, firstRun, "a later import is a different run");
  } finally {
    resetAuditLogCache();
    await rm(vaultPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(sourcePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#287: an unavailable audit log never aborts a folder import", async () => {
  resetAuditLogCache();
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-audit-import-fail-vault-"));
  const sourcePath = await mkdtemp(join(tmpdir(), "bastra-audit-import-fail-source-"));
  try {
    await writeFile(join(sourcePath, "one.md"), "# One\n\nImported despite the broken trail.\n", "utf8");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(vaultPath, ".bastra", "audit-log.ndjson"), { recursive: true });

    const result = await importVault(vaultPath, sourcePath, { label: "audit-failure" });
    assert.equal(result.imported, 1);
    assert.equal(result.skipped.length, 0, "audit failure is not an import failure");
    assert.ok(result.ids.includes("audit-failure-one"));
  } finally {
    resetAuditLogCache();
    await rm(vaultPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(sourcePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * #377 — ein gescheitertes Audit-Append auf DIESEM Pfad muss ein Ereignis
 * hinterlassen, nicht nur eine Zeile auf stderr.
 *
 * Der Pfad trägt jeden Agentenschreibvorgang über MCP und REST. Fällt er
 * stillschweigend aus, steht die Änderung und ihr Beleg fehlt — und genau das
 * ließ sich hinterher nicht mehr feststellen, weil stderr im Moment des
 * Fehlers existiert und zwei Wochen später nicht.
 */
test("#377: ein gescheitertes Audit-Append meldet audit_failed statt nur auf stderr zu gehen", async (t) => {
  const { onMutationIncident } = await import("@bastra-recall/core");
  const { recordAudit } = await import("../src/audit-trail.js");
  const { mkdir } = await import("node:fs/promises");

  resetAuditLogCache();
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-audit-fail-"));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));

  // Ein VERZEICHNIS am Pfad des Ledgers: der Append scheitert deterministisch
  // mit EISDIR — kein Zeitfenster, keine Flakiness.
  await mkdir(join(vaultPath, ".bastra", "audit-log.ndjson"), { recursive: true });

  // Die Fehlermeldung geht weiterhin auf stderr; im Test wäre sie nur Lärm.
  const err = console.error;
  console.error = () => {};
  const seen: Array<Record<string, unknown>> = [];
  const off = onMutationIncident((i) => seen.push(i as unknown as Record<string, unknown>));
  try {
    await recordAudit({
      vaultRoot: vaultPath,
      memoryId: "m-377",
      operation: "update",
      actor: "assistant",
      actorDetail: "mcp:save_memory",
      diffBefore: null,
      diffAfter: { title: "GEHEIMER-TITEL" },
    });
  } finally {
    off();
    console.error = err;
  }

  assert.equal(seen.length, 1, `genau ein Incident erwartet, gesehen: ${JSON.stringify(seen)}`);
  const incident = seen[0];
  assert.equal(incident.status, "audit_failed", "die Mutation steht — sie darf nicht wiederholt werden");
  assert.equal(incident.phase, "audit");
  assert.equal(incident.op, "audit_update");
  assert.equal(incident.memory_id, "m-377");
  assert.equal(typeof incident.operation_id, "string");

  // Und weiterhin: keine Inhalte, keine Pfade. `err.message` trägt hier den
  // Pfad des Ledgers, deshalb steht er ausdrücklich NICHT im Ereignis.
  const raw = JSON.stringify(incident);
  assert.ok(!raw.includes("GEHEIMER-TITEL"), "kein Frontmatter-Wert im Ereignis");
  assert.ok(!raw.includes(vaultPath), "kein absoluter Pfad im Ereignis");
});

test("#377: ein erfolgreiches Audit-Append meldet gar nichts", async (t) => {
  const { onMutationIncident } = await import("@bastra-recall/core");
  const { recordAudit } = await import("../src/audit-trail.js");

  resetAuditLogCache();
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-audit-ok-"));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));

  const seen: unknown[] = [];
  const off = onMutationIncident((i) => seen.push(i));
  try {
    await recordAudit({
      vaultRoot: vaultPath,
      memoryId: "m-ok",
      operation: "create",
      actor: "assistant",
      actorDetail: "mcp:save_memory",
      diffBefore: null,
      diffAfter: { title: "T" },
    });
  } finally {
    off();
  }

  assert.deepEqual(seen, [], "der Normalfall ist kein Incident");
});

/**
 * #380 — `audit_warning` erreichte nur den Bridge-Pfad.
 *
 * `auditedSave` in core kennt den Satz seit `dfb044e`: die Mutation steht, ihr
 * Beleg fehlt, NICHT wiederholen. Über MCP und REST sah ein Aufrufer davon
 * nichts — die Antwort war ein gewöhnlicher Erfolg. Für den Betreiber ist der
 * Fall seit #377 als `mutation_incident` sichtbar; hier geht es um den
 * AUFRUFER, der wissen muss, dass sein Schreibvorgang unprotokolliert blieb.
 */
test("#380: recordAudit gibt die Warnung heraus, statt sie zu behalten", async (t) => {
  const { recordAudit } = await import("../src/audit-trail.js");
  const { mkdir } = await import("node:fs/promises");

  resetAuditLogCache();
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-audit-warn-"));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));
  await mkdir(join(vaultPath, ".bastra", "audit-log.ndjson"), { recursive: true });

  const err = console.error;
  console.error = () => {};
  let warning: string | undefined;
  try {
    warning = await recordAudit({
      vaultRoot: vaultPath,
      memoryId: "m-380",
      operation: "update",
      actor: "assistant",
      actorDetail: "mcp:save_memory",
      diffBefore: null,
      diffAfter: null,
    });
  } finally {
    console.error = err;
  }

  assert.ok(warning, "im Fehlerfall muss ein Satz zurückkommen");
  assert.match(warning, /do NOT retry/, "das ist die eigentliche Botschaft");
  assert.match(warning, /was committed/, "und die Mutation gilt als geschehen");
});

test("#380: im Normalfall gibt recordAudit nichts heraus", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const res = (await saveMemoryHandler(deps, memo("Ohne Warnung"))) as Record<string, unknown>;
    assert.ok(!("warning" in res) || !String(res.warning).includes("audit"), 
      `eine gelungene Protokollierung erzeugt keine Warnung: ${JSON.stringify(res.warning)}`);
  } finally {
    await cleanup();
  }
});

test("#380: die MCP-Antwort trägt die Warnung, wenn der Beleg fehlt", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { deps, vaultPath, cleanup } = await makeDeps();
  const err = console.error;
  console.error = () => {};
  try {
    // Ledgerpfad als Verzeichnis: der Append scheitert, der Save läuft durch.
    await mkdir(join(vaultPath, ".bastra", "audit-log.ndjson"), { recursive: true });
    resetAuditLogCache();

    const res = (await saveMemoryHandler(deps, memo("Mit Warnung"))) as Record<string, unknown>;

    assert.ok(res.id, "der Save selbst ist gelungen — das ist die Zusage von dfb044e");
    assert.ok(
      typeof res.warning === "string" && res.warning.includes("do NOT retry"),
      `die Antwort muss die Warnung tragen, war: ${JSON.stringify(res.warning)}`,
    );
  } finally {
    console.error = err;
    await cleanup();
  }
});

test("#380: auch archive_memory sagt es, wenn sein Beleg fehlt", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { deps, vaultPath, cleanup } = await makeDeps();
  const err = console.error;
  console.error = () => {};
  try {
    const saved = await saveMemoryHandler(deps, memo("Wird archiviert"));
    // Erst NACH dem Save den Ledger unbrauchbar machen, damit der Save selbst
    // sauber protokolliert ist und nur das Archivieren die Warnung erzeugt.
    await rm(join(vaultPath, ".bastra", "audit-log.ndjson"), { force: true });
    await mkdir(join(vaultPath, ".bastra", "audit-log.ndjson"), { recursive: true });
    resetAuditLogCache();

    const res = (await archiveMemoryHandler(deps, { id: saved.id })) as Record<string, unknown>;

    assert.equal(res.id, saved.id, "archiviert wurde trotzdem");
    assert.ok(
      typeof res.warning === "string" && res.warning.includes("do NOT retry"),
      `die Antwort muss die Warnung tragen, war: ${JSON.stringify(res.warning)}`,
    );
  } finally {
    console.error = err;
    await cleanup();
  }
});
