/**
 * #787: the on/off parser exists twice — in the daemon's `env.ts` and in
 * core's `env-switch.ts` — because neither side can import the other: core
 * must not depend on the daemon, and `env.ts` is part of the hook stub's
 * source closure, which `deno compile` builds without any workspace package.
 * These tests keep the two copies to the same answers and keep `env.ts` (and
 * the rest of the closure) npm-free. Explicit import-map entries may resolve
 * shared helpers to local source, whose dependencies must remain npm-free too.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/env-switch-parity-787.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { isOffValue as coreOff, isOnValue as coreOn } from "@bastra-recall/core";
import { isOffValue, isOnValue } from "../src/env.js";
// @ts-expect-error — plain .mjs build script, no types
import { stubSourceFiles, PACKAGE_ROOT } from "../scripts/stub-source-digest.mjs";

const OFF = ["0", "false", "off", "no"];
const ON = ["1", "true", "on", "yes"];
const NEITHER = ["", " ", "2", "-1", "00", "y", "n", "t", "f", "ja", "nein", "enabled", "disabled", "none", "null", "undefined", "host", "shadow", "live", "of", "onn", "o n"];

test("core and daemon read every candidate value the same way", () => {
  const candidates: Array<string | undefined | null> = [undefined, null];
  for (const w of [...OFF, ...ON, ...NEITHER]) candidates.push(w, w.toUpperCase(), ` ${w}\t`, `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`);
  for (const c of candidates) {
    assert.equal(coreOff(c), isOffValue(c), `off: ${JSON.stringify(c)}`);
    assert.equal(coreOn(c), isOnValue(c), `on: ${JSON.stringify(c)}`);
  }
});

test("both copies accept exactly the four off words and the four on words", () => {
  for (const [name, off, on] of [["daemon", isOffValue, isOnValue], ["core", coreOff, coreOn]] as const) {
    for (const w of OFF) assert.deepEqual([off(w), on(w)], [true, false], `${name} ${w}`);
    for (const w of ON) assert.deepEqual([off(w), on(w)], [false, true], `${name} ${w}`);
    for (const w of NEITHER) assert.deepEqual([off(w), on(w)], [false, false], `${name} ${JSON.stringify(w)}`);
  }
});

/** A bare specifier is safe for --no-npm only when the actual import map
 * resolves it to an existing relative source file. Walk that source's local
 * dependencies too; a mapped entry must not hide an unmapped package import. */
function assertNpmFree(files: string[], mapFile: string): void {
  const imports: Record<string, unknown> = JSON.parse(readFileSync(mapFile, "utf8")).imports ?? {};
  const seen = new Set<string>();
  const localFile = (base: string): string => {
    const candidates = [base.replace(/\.js$/, ".ts"), base,
      ...[".ts", ".tsx", ".js", ".mjs"].map(ext => base + ext),
      ...[".ts", ".tsx", ".js", ".mjs"].map(ext => join(base, "index" + ext))];
    const found = candidates.find(path => { try { return statSync(path).isFile(); } catch { return false; } });
    assert.ok(found, `local import does not resolve: ${base}`);
    return found;
  };
  function visit(file: string, followLocal = false): void {
    const key = `${file}:${followLocal}`;
    if (seen.has(key)) return;
    seen.add(key);
    const specifiers = [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(m => m[1]);
    for (const spec of specifiers) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        // The initial source closure deliberately excludes the generated stamp
        // and statusline bundle; only mapped source needs this extra traversal.
        if (followLocal) visit(localFile(resolve(dirname(file), spec)), true);
        continue;
      }
      const target = Object.hasOwn(imports, spec) ? imports[spec] : undefined;
      assert.ok(typeof target === "string" && /^\.\.?\//.test(target),
        `${file} imports ${spec} without an explicit local import-map target`);
      visit(localFile(resolve(dirname(mapFile), target)), true);
    }
  }
  for (const file of files) visit(file);
}

test("hook stub source imports resolve without npm, including mapped local source dependencies", () => {
  const files: string[] = stubSourceFiles();
  assert.ok(files.some(f => f.endsWith("/src/env.ts")), "env.ts is part of the closure");
  assertNpmFree(files, join(PACKAGE_ROOT, "stub", "import-map.json"));
});

test("npm-free guard rejects missing, remote and transitive package dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "bastra-npm-free-"));
  const entry = join(root, "entry.ts"), map = join(root, "import-map.json");
  try {
    mkdirSync(join(root, "shared"));
    writeFileSync(entry, 'export { value } from "@shared/helper";');
    writeFileSync(map, JSON.stringify({ imports: {} }));
    assert.throws(() => assertNpmFree([entry], map), /explicit local import-map target/);
    for (const target of ["npm:helper", "https://example.org/helper.ts", "./absent.ts"]) {
      writeFileSync(map, JSON.stringify({ imports: { "@shared/helper": target } }));
      assert.throws(() => assertNpmFree([entry], map), /import-map target|does not resolve/);
    }
    writeFileSync(map, JSON.stringify({ imports: { "@shared/helper": "./shared/helper.ts" } }));
    writeFileSync(join(root, "shared/helper.ts"), 'export { value } from "./nested.js";');
    writeFileSync(join(root, "shared/nested.ts"), 'import "unmapped-package";');
    assert.throws(() => assertNpmFree([entry], map), /unmapped-package/);
    writeFileSync(join(root, "shared/nested.ts"), 'import "node:path"; export const value = 1;');
    assert.doesNotThrow(() => assertNpmFree([entry], map));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
