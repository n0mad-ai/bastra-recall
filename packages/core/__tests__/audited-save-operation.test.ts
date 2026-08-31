/**
 * #240/C6 — auditedSave must classify a slug-inferred overwrite as `update`.
 *
 * It looked the predecessor up via `input.id` only, but the effective id is
 * `input.id ?? slugify(input.title)` and was derived later, inside saveMemory.
 * On the normal path (agent sends a title, no id) the lookup therefore found
 * nothing, and a destructive overwrite was recorded as `create` with
 * `diff_before: null` — the pre-image was gone and the mutation could not be
 * reconstructed from the audit trail. Same root cause as #239.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { AuditLog } from "../src/audit-log.js";
import { auditedSave } from "../src/audit-save.js";
import type { SaveMemoryInput } from "../src/save.js";

const INPUT = {
  title: "Deploy Runbook",
  type: "lesson",
  summary: "How to roll back a deploy.",
  topic_path: ["ops"],
  tags: ["deploy"],
  scope: "audittest",
  recall_when: ["when rolling back a deploy"],
  body: "Body v1.",
} as SaveMemoryInput;

async function harness(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-audited-save-"));
  const vault = new Vault(dir);
  await vault.init();
  const auditLog = new AuditLog(dir);
  t.after(async () => {
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const save = async (input: SaveMemoryInput) => {
    const out = await auditedSave({
      vault,
      auditLog,
      vaultRoot: dir,
      input,
      context: { actor: "assistant", reason: "test mutation" },
    });
    await vault.reindexFile(out.result.file_path);
    return out;
  };
  return { save, vault, auditLog, dir };
}

test("a slug-inferred overwrite is audited as update, with the pre-image kept", async (t) => {
  const { save } = await harness(t);

  const first = await save(INPUT);
  assert.equal(first.audit.operation, "create");
  assert.equal(first.audit.diff_before, null);

  const second = await save({ ...INPUT, body: "Body v2.", overwrite: true });
  assert.equal(second.result.created, false, "the file already existed");
  assert.equal(
    second.audit.operation,
    "update",
    "a destructive overwrite must not be recorded as a creation",
  );
  assert.ok(
    second.audit.diff_before,
    "the overwritten state must be reconstructable from the trail",
  );
  assert.equal(
    (second.audit.diff_before as Record<string, unknown>).id,
    first.result.id,
  );
});

test("an explicit id still classifies correctly", async (t) => {
  const { save } = await harness(t);

  await save({ ...INPUT, id: "explicit-runbook" });
  const second = await save({ ...INPUT, id: "explicit-runbook", overwrite: true });

  assert.equal(second.audit.operation, "update");
  assert.ok(second.audit.diff_before);
});

/**
 * Codex-Gegenreview (P1): Autoritative Besitzprüfung, aber Vorbild aus dem
 * Cache.
 *
 * Die Mutation arbeitet seit dem Umbau auf die ID-Transaktion autoritativ von
 * der PLATTE (`claim.locate()`), `diff_before` kam aber weiter aus dem
 * Vault-Index. Zwei nachgestellte Fälle, beide mit einem Audit, das eine andere
 * Datei beschreibt als die mutierte:
 *
 *   1. Der Index kennt das Memory nicht (extern nach der Initialisierung
 *      aufgetaucht) — protokolliert wurde `diff_before: null`, also „neu
 *      angelegt", während auf der Platte überschrieben wurde.
 *   2. Der Index ist veraltet (extern geändert) — protokolliert wurde die ALTE
 *      Fassung, überschrieben die neue.
 *
 * `operation` ist davon unberührt: sie kommt aus `result.created` und damit
 * ohnehin aus der Mutation selbst.
 */
test("das Save-Audit liest sein Vorbild von der Platte, auch wenn der Index es nicht kennt", async (t) => {
  const { save, vault } = await harness(t);
  const first = await save(INPUT);
  // Der Index vergisst die Datei — sie bleibt liegen. Genau der Zustand, in dem
  // ein extern aufgetauchtes Memory beim nächsten Save überschrieben wird.
  vault.forgetFile(first.result.file_path);
  assert.equal(vault.get(first.result.id), undefined, "Kontrolle: der Cache kennt es nicht mehr");

  const second = await save({ ...INPUT, body: "Body v2.", overwrite: true });

  assert.equal(second.result.created, false, "auf der Platte lag die Datei sehr wohl");
  assert.ok(
    second.audit.diff_before,
    "ein Overwrite ohne Vorbild ist ein Trail, aus dem die Mutation nicht rekonstruierbar ist",
  );
  assert.equal((second.audit.diff_before as Record<string, unknown>).id, first.result.id);
});

test("das Save-Audit nennt die Fassung von der Platte, nicht den veralteten Cache-Stand", async (t) => {
  const { save, vault } = await harness(t);
  const first = await save(INPUT);
  const file = first.result.file_path;

  // Extern geändert, ohne Reindex: der Cache hält v1, die Platte v-extern.
  const raw = await readFile(file, "utf8");
  await writeFile(file, raw.replace("summary: How to roll back a deploy.", "summary: extern geaendert"), "utf8");
  assert.equal(
    vault.get(first.result.id)?.fm.summary,
    "How to roll back a deploy.",
    "Kontrolle: der Cache weiß nichts von der externen Änderung",
  );

  const second = await save({ ...INPUT, body: "Body v3.", overwrite: true });

  assert.equal(
    (second.audit.diff_before as Record<string, unknown>).summary,
    "extern geaendert",
    "das Vorbild muss die Datei beschreiben, die wirklich überschrieben wurde",
  );
});
