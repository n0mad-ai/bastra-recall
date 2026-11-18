import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PRETTIER = join(ROOT, "node_modules/prettier/bin/prettier.cjs");

test("#1616 format scope ignores local eval scratch while checking sources and tests", () => {
  const fixture = mkdtempSync(join(tmpdir(), "bastra-format-scope-"));
  try {
    writeFileSync(join(fixture, ".prettierignore"), readFileSync(join(ROOT, ".prettierignore")));
    for (const [file, code] of [
      ["scratch/local.json", '{"local":true}'],
      [".scratch/local.json", '{"local":true}'],
      ["src/example.ts", "export const value={a:1}"],
      ["__tests__/example.test.ts", "export const value={a:1}"],
    ]) {
      const relative = `packages/eval/${file}`;
      const target = join(fixture, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, code);
      const result = spawnSync(process.execPath, [PRETTIER, "--check", relative], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.equal(result.error, undefined, relative);
      const scratch = file.startsWith("scratch/") || file.startsWith(".scratch/");
      assert.equal(result.status, scratch ? 0 : 1, `${relative}: ${result.stdout}\n${result.stderr}`);
      if (!scratch) assert.match(result.stderr, /Code style issues/);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
