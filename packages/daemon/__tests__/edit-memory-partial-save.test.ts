/**
 * #519 — die Teiländerung eines bestehenden Memories läuft durch DENSELBEN
 * Save-Pfad wie ein vollständiger Save.
 *
 * Der Befund hinter dem Issue: Es gab kein Primitiv für „ändere eine Zeile".
 * Wer das wollte, musste `save_memory(overwrite: true)` mit komplettem Body und
 * allen Pflichtfeldern schicken — also nahmen Agenten die Abkürzung und
 * editierten die `.md`-Datei im Vault direkt. Damit fielen Audit-Eintrag,
 * `updated`-Stempel, id-Lock, atomares Schreiben, Index-Aktualisierung und die
 * Sensitivitätsgrenze weg.
 *
 * Diese Datei prüft genau die Garantien, deren Fehlen das Issue beschreibt.
 *
 * Runner: `npx tsx --test packages/daemon/__tests__/edit-memory-partial-save.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Vault,
  SearchIndex,
  saveMemory,
  AUTO_RELATED_START,
  AUTO_RELATED_END,
  type SaveMemoryInput,
} from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { editMemoryHandler, type EditMemoryResult } from "../src/edit-memory-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { TRUSTED_LOCAL_APP } from "../src/private-access.js";
import type { ToolDeps } from "../src/tool-deps.js";

const TODAY = new Date().toISOString().slice(0, 10);

interface AuditLine {
  memory_id: string;
  operation: string;
  actor_detail?: string;
  reason?: string;
  diff_before: Record<string, unknown> | null;
  diff_after: Record<string, unknown> | null;
}

async function auditEntries(vaultRoot: string): Promise<AuditLine[]> {
  const raw = await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditLine);
}

interface Fixture {
  deps: ToolDeps;
  vaultRoot: string;
  /** Legt ein Memory an und indexiert es — der Ausgangszustand jedes Tests. */
  seed: (over?: Partial<SaveMemoryInput>) => Promise<string>;
}

async function fixture(t: { after: (fn: () => unknown) => void }): Promise<Fixture> {
  resetAuditLogCache();
  const vaultRoot = await mkdtemp(join(tmpdir(), "bastra-519-edit-"));
  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: vaultRoot };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    resetAuditLogCache();
    await rm(vaultRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    deps,
    vaultRoot,
    seed: async (over: Partial<SaveMemoryInput> = {}) => {
      const result = await saveMemory(vaultRoot, {
        id: "hooks-lesson",
        title: "Hooks lesson",
        type: "lesson",
        summary: "What we learned about hooks.",
        body: "Erste Zeile.\n\nZweite Zeile.\n",
        topic_path: ["tools", "hooks"],
        tags: ["hooks"],
        scope: "bastra",
        recall_when: ["writing a claude code hook"],
        ...over,
      } as SaveMemoryInput);
      await vault.reindexFile(result.file_path);
      return result.file_path;
    },
  };
}

/** Die Bytes auf der Platte — der einzige Beweis für „nichts geschrieben". */
const bytes = (path: string): Promise<string> => readFile(path, "utf8");

// ── Identität, Metadaten, Sensitivität ──────────────────────────────

test("#519: append ergänzt den Body, ohne Identität, Metadaten oder Sensitivität anzufassen", async (t) => {
  const { deps, seed } = await fixture(t);
  const path = await seed({
    sensitivity: "team",
    write_origin: "user-directed",
    confidence: 0.4,
    source: "conversation",
  });

  const result = (await editMemoryHandler(deps, {
    id: "hooks-lesson",
    append: "Nachtrag: der Hook läuft auch ohne Daemon.",
  })) as EditMemoryResult;

  assert.equal(result.created, false);
  assert.deepEqual(result.operations, ["append"]);
  assert.equal(result.updated, TODAY);

  const mem = deps.vault.get("hooks-lesson");
  assert.ok(mem);
  // Der bestehende Text ist unangetastet, der Nachtrag steht dahinter.
  assert.match(mem.body, /Erste Zeile\./);
  assert.match(mem.body, /Zweite Zeile\./);
  assert.match(mem.body, /Nachtrag: der Hook läuft auch ohne Daemon\./);
  // Identität und alles, was ein Direkt-Edit oder ein nachlässiger Overwrite
  // verloren hätte (#240/A6 ist die Historie dazu).
  assert.equal(mem.fm.id, "hooks-lesson");
  assert.equal(mem.fm.type, "lesson");
  assert.equal(mem.fm.scope, "bastra");
  assert.equal(mem.fm.title, "Hooks lesson");
  assert.equal(mem.fm.sensitivity, "team");
  assert.equal(mem.fm.write_origin, "user-directed");
  assert.equal(mem.fm.confidence, 0.4);
  assert.equal(mem.fm.source, "conversation");
  assert.deepEqual(mem.fm.recall_when, ["writing a claude code hook"]);
  assert.equal(mem.fm.updated, TODAY);
  assert.equal(mem.filePath, path);
});

test("#519: der Frontmatter-Patch ist eine Whitelist — scope/type/id werden abgelehnt, nichts wird geschrieben", async (t) => {
  const { deps, seed } = await fixture(t);
  const path = await seed();
  const before = await bytes(path);

  await assert.rejects(
    () => editMemoryHandler(deps, { id: "hooks-lesson", frontmatter: { scope: "anderes-regal" } }),
    /invalid edit_memory args/,
  );
  await assert.rejects(
    () => editMemoryHandler(deps, { id: "hooks-lesson", frontmatter: { sensitivity: "public" } }),
    /invalid edit_memory args/,
  );

  assert.equal(await bytes(path), before, "ein abgelehnter Patch darf die Datei nicht anfassen");
});

test("#519: der Frontmatter-Patch ändert genau die erlaubten Felder", async (t) => {
  const { deps, seed } = await fixture(t);
  await seed();

  const result = (await editMemoryHandler(deps, {
    id: "hooks-lesson",
    frontmatter: { summary: "Kürzer gefasst.", tags: ["hooks", "daemon"], confidence: 0.9 },
  })) as EditMemoryResult;
  assert.deepEqual(result.operations, ["frontmatter"]);

  const mem = deps.vault.get("hooks-lesson");
  assert.equal(mem?.fm.summary, "Kürzer gefasst.");
  assert.deepEqual(mem?.fm.tags, ["hooks", "daemon"]);
  assert.equal(mem?.fm.confidence, 0.9);
  assert.equal(mem?.fm.updated, TODAY);
});

// ── Ein nicht zutreffendes Suchmuster schreibt NICHTS ────────────────

test("#519: str_replace mit fehlendem old_str schreibt NICHTS und sagt warum", async (t) => {
  const { deps, seed } = await fixture(t);
  const path = await seed();
  const before = await bytes(path);

  await assert.rejects(
    () =>
      editMemoryHandler(deps, {
        id: "hooks-lesson",
        str_replace: { old_str: "steht so nicht da", new_str: "X" },
      }),
    /does not occur in the body.*NOTHING was written/s,
  );

  assert.equal(await bytes(path), before);
});

test("#519: str_replace mit mehrdeutigem old_str schreibt NICHTS und sagt, wie oft es vorkam", async (t) => {
  const { deps, seed } = await fixture(t);
  const path = await seed({ body: "Zeile.\n\nZeile.\n" });
  const before = await bytes(path);

  await assert.rejects(
    () =>
      editMemoryHandler(deps, {
        id: "hooks-lesson",
        str_replace: { old_str: "Zeile.", new_str: "Andere Zeile." },
      }),
    /occurs 2 times.*NOTHING was written/s,
  );

  assert.equal(await bytes(path), before);
});

test("#519: str_replace tauscht genau die eine eindeutige Stelle", async (t) => {
  const { deps, seed } = await fixture(t);
  await seed();

  await editMemoryHandler(deps, {
    id: "hooks-lesson",
    str_replace: { old_str: "Zweite Zeile.", new_str: "Zweite Zeile, korrigiert." },
  });

  const body = deps.vault.get("hooks-lesson")?.body ?? "";
  assert.match(body, /Erste Zeile\./);
  assert.match(body, /Zweite Zeile, korrigiert\./);
  assert.equal(body.includes("\nZweite Zeile.\n"), false);
});

test("#519: expected_updated hält eine Änderung, die auf einem veralteten Stand rechnet", async (t) => {
  const { deps, seed } = await fixture(t);
  const path = await seed();
  const before = await bytes(path);

  await assert.rejects(
    () => editMemoryHandler(deps, { id: "hooks-lesson", append: "zu spät", expected_updated: "2020-01-01" }),
    /expected_updated.*NOTHING was written/s,
  );

  assert.equal(await bytes(path), before);
});

// ── Audit-Trail und Index ───────────────────────────────────────────

test("#519: jede Teiländerung schreibt einen Audit-Eintrag mit Vor- und Nachbild", async (t) => {
  const { deps, seed, vaultRoot } = await fixture(t);
  await seed();
  // Der Seed läuft über core `saveMemory` und protokolliert nichts — was im
  // Log steht, stammt also ausschließlich vom Edit.
  assert.deepEqual(await auditEntries(vaultRoot), []);

  await editMemoryHandler(deps, {
    id: "hooks-lesson",
    append: "Nachtrag.",
    frontmatter: { summary: "Neu gefasst." },
  });

  const entries = await auditEntries(vaultRoot);
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.memory_id, "hooks-lesson");
  assert.equal(entry.operation, "update");
  assert.equal(entry.actor_detail, "mcp:edit_memory");
  assert.match(entry.reason ?? "", /edit_memory: append \+ frontmatter \(body \d+ → \d+ chars\)/);
  assert.equal(entry.diff_before?.summary, "What we learned about hooks.");
  assert.equal(entry.diff_after?.summary, "Neu gefasst.");
  assert.equal(entry.diff_after?.updated, TODAY);
});

test("#519: der Index wird über den Schreibpfad aktualisiert, nicht dem Watcher überlassen", async (t) => {
  const { deps, seed } = await fixture(t);
  await seed();

  await editMemoryHandler(deps, { id: "hooks-lesson", append: "Sofort sichtbar." });

  // Ohne Reindex im Handler stünde hier noch der alte Body: der Watcher ist auf
  // Cloud-Mounts genau der unzuverlässige Weg, den das Issue benennt.
  assert.match(deps.vault.get("hooks-lesson")?.body ?? "", /Sofort sichtbar\./);
  assert.equal(
    deps.search.recall("Sofort sichtbar", { k: 5 }).some((h) => h.id === "hooks-lesson"),
    true,
    "der Suchindex kennt den neuen Text im selben Zug",
  );
});

// ── Nebenläufigkeit ─────────────────────────────────────────────────

test("#519: nebenläufige Teiländerungen verlieren nichts", async (t) => {
  const { deps, seed } = await fixture(t);
  const path = await seed();

  const settled = await Promise.allSettled([
    editMemoryHandler(deps, { id: "hooks-lesson", append: "Nachtrag A." }),
    editMemoryHandler(deps, { id: "hooks-lesson", append: "Nachtrag B." }),
    editMemoryHandler(deps, { id: "hooks-lesson", append: "Nachtrag C." }),
  ]);

  const raw = await bytes(path);
  // Die ID-Transaktion lässt genau einen Schreiber an die id; wer Erfolg
  // meldet, MUSS in der Datei stehen. Ein abgelehnter Versuch ist erlaubt —
  // aber nur als WIEDERHOLBARER Konflikt, wortgleich mit dem, den auch ein
  // gekreuzter `save_memory` bekommt. Ein Erfolg, der später still
  // überschrieben wurde, wäre der Verlust, den ein Direkt-Edit produziert.
  let fulfilled = 0;
  const rejected: string[] = [];
  for (const [i, outcome] of settled.entries()) {
    const marker = `Nachtrag ${"ABC"[i]}.`;
    if (outcome.status === "fulfilled") {
      fulfilled += 1;
      assert.match(raw, new RegExp(marker.replace(".", "\\.")), `${marker} meldete Erfolg, fehlt aber in der Datei`);
    } else {
      rejected.push(marker);
      assert.match(
        (outcome.reason as Error).message,
        /NOTHING was written|changed while the edit|memory write conflict/,
        `${marker} wurde abgelehnt, aber nicht als wiederholbarer Konflikt`,
      );
    }
  }
  assert.ok(fulfilled >= 1, "mindestens eine Teiländerung muss durchkommen");

  // Und die Wiederholung, die der Konflikt verlangt, kommt durch — der
  // abgelehnte Nachtrag ist also aufgeschoben, nicht verloren.
  for (const marker of rejected) {
    await editMemoryHandler(deps, { id: "hooks-lesson", append: marker });
  }
  const after = await bytes(path);
  for (const marker of ["Nachtrag A.", "Nachtrag B.", "Nachtrag C."]) {
    assert.match(after, new RegExp(marker.replace(".", "\\.")), `${marker} fehlt nach der Wiederholung`);
  }
  // Und die Datei ist danach ein wohlgeformtes Memory, kein halber Datensatz.
  const mem = deps.vault.get("hooks-lesson");
  assert.equal(mem?.fm.id, "hooks-lesson");
  assert.equal(mem?.fm.title, "Hooks lesson");
});

// ── #464: dieselbe Autorisierungsgrenze wie save_memory(overwrite) ───

test("#519/#464: ein abgelehnter privater Zugriff lässt die Originalbytes unverändert", async (t) => {
  const { deps, seed } = await fixture(t);
  const path = await seed({ sensitivity: "private" });
  const before = await bytes(path);

  // Ohne Capability — so rufen der REST-Dispatcher und der stdio-Server auf.
  await assert.rejects(
    () => editMemoryHandler(deps, { id: "hooks-lesson", append: "heimlich" }),
    /^Error: memory not found: hooks-lesson$/,
  );
  assert.equal(await bytes(path), before, "ein abgelehnter privater Schreibzugriff darf nichts anfassen");

  // Und das Feld ist kein Selbstbedienungsladen: ein `allow_private` im
  // Request-Body ist genau der Fehler, den #464 schließt.
  await assert.rejects(
    () => editMemoryHandler(deps, { id: "hooks-lesson", append: "heimlich", allow_private: true }),
    /memory not found: hooks-lesson/,
  );
  assert.equal(await bytes(path), before);

  // Der vertrauenswürdige lokale Transport kommt durch — sonst wäre die Grenze
  // eine Sperre statt einer Autorisierung.
  const ok = (await editMemoryHandler(
    deps,
    { id: "hooks-lesson", append: "Nachtrag der App." },
    TRUSTED_LOCAL_APP,
  )) as EditMemoryResult;
  assert.equal(ok.created, false);
  assert.match(deps.vault.get("hooks-lesson")?.body ?? "", /Nachtrag der App\./);
  assert.equal(deps.vault.get("hooks-lesson")?.fm.sensitivity, "private", "die Sensitivität überlebt den Edit");
});

// ── Der Auto-Related-Block ist über Body-Operationen unerreichbar ────

test("#519: append landet VOR dem Auto-Related-Block, str_replace kann ihn nicht treffen", async (t) => {
  const { deps, seed } = await fixture(t);
  const path = await seed();

  // Den Block so anhängen, wie der Background-Pass ihn schreibt.
  const withBlock = (await bytes(path)).replace(
    /\n*$/,
    `\n\n## Auto-Related ${AUTO_RELATED_START}\n- [[andere-lesson]]\n${AUTO_RELATED_END}\n`,
  );
  await writeFile(path, withBlock, "utf8");
  await deps.vault.reindexFile(path);

  await editMemoryHandler(deps, { id: "hooks-lesson", append: "Nachtrag." });

  const body = deps.vault.get("hooks-lesson")?.body ?? "";
  assert.ok(
    body.indexOf("Nachtrag.") < body.indexOf(AUTO_RELATED_START),
    "der Nachtrag muss vor dem generierten Block stehen",
  );
  assert.match(body, /\[\[andere-lesson\]\]/, "der Block selbst bleibt unangetastet");

  // Und der Blockinhalt ist für str_replace nicht sichtbar.
  const before = await bytes(path);
  await assert.rejects(
    () =>
      editMemoryHandler(deps, {
        id: "hooks-lesson",
        str_replace: { old_str: "[[andere-lesson]]", new_str: "[[x]]" },
      }),
    /does not occur in the body/,
  );
  assert.equal(await bytes(path), before);
});

// ── Die Identitätsprüfung des Save-Pfads gilt auch hier ─────────────

test("#519: ein unbekanntes Memory und ein Edit ohne Operation schreiben nichts", async (t) => {
  const { deps, seed } = await fixture(t);
  await seed();

  await assert.rejects(
    () => editMemoryHandler(deps, { id: "gibt-es-nicht", append: "x" }),
    /memory not found: gibt-es-nicht/,
  );
  await assert.rejects(
    () => editMemoryHandler(deps, { id: "hooks-lesson" }),
    /at least one of str_replace, append or frontmatter/,
  );
});
