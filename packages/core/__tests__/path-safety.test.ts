/**
 * Path-Traversal-Guards: id und scope werden zu Pfad-Komponenten
 * (`<id>.md`, `memories/projects/<scope>/`, `.bastra/trash/<id>.md`).
 * Crafted Input (`../../x`) darf weder beim Save noch beim Soft-Delete
 * aus dem Vault klettern.
 *
 * Runner: `tsx --test __tests__/path-safety.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathSafeComponent } from "../src/schema.js";
import { saveMemory } from "../src/save.js";
import { SaveMemoryInput } from "../src/save-schema.js";
import { trashPathFor } from "../src/audit-log.js";

const VALID_INPUT = {
  title: "Path safety probe",
  type: "lesson",
  summary: "probe",
  body: "probe body",
  topic_path: ["test"],
  tags: ["test"],
  scope: "test-scope",
  recall_when: ["never"],
};

// ── isPathSafeComponent ──────────────────────────────────────────────
test("isPathSafeComponent: rejects separators, dotdot, NUL, leading dot", () => {
  assert.equal(isPathSafeComponent("normal-id-123"), true);
  assert.equal(isPathSafeComponent("under_score"), true);
  assert.equal(isPathSafeComponent("../evil"), false);
  assert.equal(isPathSafeComponent("a/b"), false);
  assert.equal(isPathSafeComponent("a\\b"), false);
  assert.equal(isPathSafeComponent("a..b"), false);
  assert.equal(isPathSafeComponent(".hidden"), false);
  assert.equal(isPathSafeComponent("a\0b"), false);
});

// ── SaveMemoryInput: Zod-Schicht ─────────────────────────────────────
test("SaveMemoryInput: rejects traversal in id and scope", () => {
  assert.equal(SaveMemoryInput.safeParse(VALID_INPUT).success, true);
  assert.equal(
    SaveMemoryInput.safeParse({ ...VALID_INPUT, id: "../../evil" }).success,
    false,
  );
  assert.equal(
    SaveMemoryInput.safeParse({ ...VALID_INPUT, scope: "../../../tmp" }).success,
    false,
  );
});

// ── saveMemory: Containment-Guard (auch ohne Zod-Parse) ──────────────
test("saveMemory: refuses to write outside the vault even when the schema is bypassed", async () => {
  const vault = await mkdtemp(join(tmpdir(), "bastra-path-safety-"));
  try {
    // Genug `..`-Stufen, um aus `memories/projects/<scope>/` (3 Ebenen) über
    // den Vault-Root hinaus zu klettern.
    await assert.rejects(
      saveMemory(vault, {
        ...VALID_INPUT,
        id: "../../../../evil",
      } as unknown as SaveMemoryInput),
      /outside the vault/,
    );
    // Nichts wurde angelegt — auch nicht eine Ebene über dem Vault.
    await assert.rejects(access(join(vault, "..", "evil.md")));
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

// ── trashPathFor: Soft-Delete-Pfad ───────────────────────────────────
test("trashPathFor: stays inside the trash folder, throws on traversal ids", () => {
  const dest = trashPathFor("/vault", "good-id");
  assert.equal(dest, join("/vault", ".bastra", "trash", "good-id.md"));
  assert.throws(() => trashPathFor("/vault", "../../etc/cron"), /trash folder/);
});
