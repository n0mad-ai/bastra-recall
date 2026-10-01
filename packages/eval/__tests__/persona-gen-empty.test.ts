import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * persona-gen against a vault with no eligible memory must fail, not print
 * "wrote <file>" for a file it never wrote. Neither may a run in which every
 * generation failed. No Ollama is needed: the empty vault never reaches the
 * model, and the failing run points at a port nothing listens on.
 */
const SCRIPT = resolve(import.meta.dirname, "..", "src", "persona-gen.ts");

test("persona-gen exits non-zero and writes nothing when no memory is eligible", () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-persona-gen-"));
  try {
    const outPath = join(dir, "personas.json");
    const res = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--out", outPath], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, BASTRA_VAULT_PATH: join(dir, "vault"), BASTRA_OLLAMA_URL: "http://127.0.0.1:1" },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    assert.notEqual(res.status, 0, `an empty run must not exit 0; output:\n${out}`);
    assert.equal(existsSync(outPath), false);
    assert.match(out, /0 eligible memories/);
    assert.doesNotMatch(out, /wrote .*personas\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persona-gen exits non-zero and keeps the old file when every generation fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-persona-gen-"));
  try {
    const vault = join(dir, "vault", "memories");
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      join(vault, "m1.md"),
      [
        "---",
        "id: m1",
        'title: "Mount check"',
        "type: lesson",
        'summary: "what to do when the vault mount is gone"',
        "topic_path: [ops]",
        "tags: [mount]",
        "scope: all-projects",
        "recall_when:",
        "  - when the vault mount is gone",
        "created: 2026-01-01T00:00:00.000Z",
        "updated: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    const outPath = join(dir, "personas.json");
    writeFileSync(outPath, '{"previous":"run"}');
    const res = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--out", outPath, "--voices", "junior"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, BASTRA_VAULT_PATH: join(dir, "vault"), BASTRA_OLLAMA_URL: "http://127.0.0.1:1" },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    assert.match(out, /sampling 1 /, `the memory must be eligible; output:\n${out}`);
    assert.notEqual(res.status, 0, `a run with no persona must not exit 0; output:\n${out}`);
    assert.doesNotMatch(out, /wrote .*personas\.json/);
    assert.equal(readFileSync(outPath, "utf8"), '{"previous":"run"}', "the previous file is not overwritten by an empty one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
