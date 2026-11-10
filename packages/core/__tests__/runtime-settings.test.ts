import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRuntimeSettingsRecord } from "../src/runtime-settings.js";

test("#1418 only ENOENT permits legacy fallback; other filesystem errors are reported", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "runtime-settings-errors-"));
  const path = join(root, "recall.db");
  const stat = fs.statSync, write = process.stderr.write;
  let diagnostic = "";
  process.stderr.write = ((chunk: string) => { diagnostic += chunk; return true; }) as typeof write;
  try {
    for (const code of ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ELOOP"]) {
      Reflect.set(fs, "statSync", (input: unknown, ...args: unknown[]) => {
        if (input === path) throw Object.assign(new Error("fixture-secret-must-not-be-logged"), { code });
        return Reflect.apply(stat, fs, [input, ...args]);
      });
      syncBuiltinESMExports();
      diagnostic = "";
      assert.equal(readRuntimeSettingsRecord(join(root, "settings.json"), path), code === "ENOENT" ? undefined : null, code);
      if (code === "ENOENT") assert.equal(diagnostic, "");
      else assert.match(diagnostic, new RegExp(`settings.*${code}`));
      assert.doesNotMatch(diagnostic, /fixture-secret/);
    }
  } finally { Reflect.set(fs, "statSync", stat); process.stderr.write = write; syncBuiltinESMExports(); }
  assert.equal(fs.readdirSync(root).length, 0, "read failures never create a DB or legacy settings");
});

test("#1418 genuinely missing DB and missing DB parent remain passive legacy cases", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "runtime-settings-absent-"));
  for (const path of [join(root, "recall.db"), join(root, "missing", "recall.db")]) {
    assert.equal(readRuntimeSettingsRecord(join(root, "settings.json"), path), undefined);
  }
  assert.deepEqual(fs.readdirSync(root), []);
  if (process.platform !== "win32") {
    const regular = join(root, "regular-file"); fs.writeFileSync(regular, "fixture");
    assert.equal(readRuntimeSettingsRecord(join(root, "settings.json"), join(regular, "recall.db")), null,
      "a non-directory DB parent is an error, not absence");
  }
});
