/**
 * #546 — the stub's source closure must hold every module `deno compile`
 * bundles, or editing one leaves the freshness digest (and so `bastra doctor`)
 * green over a stale binary.
 *
 * build-stub compiles with --sloppy-imports. The closure parser knew only
 * `from "…"` and `import("…")` and resolved specifiers literally, so a module
 * reached by a bare `import "./side"`, by an extensionless specifier, or by a
 * directory (its index) went into the binary but not into the digest.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stub-source-digest-closure.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

// @ts-expect-error — plain .mjs script, no declarations (#542).
import { stubSourceFiles } from "../scripts/stub-source-digest.mjs";

function closureOf(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "bastra-stub-closure-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const abs = join(root, name);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    }
    const found: string[] = stubSourceFiles({ entry: join(root, "entry.ts"), root });
    return found.map((f) => relative(root, f).split(sep).join("/")).sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the closure follows a bare side-effect import", () => {
  assert.deepEqual(
    closureOf({ "entry.ts": 'import "./side.js";\n', "side.ts": "export {};\n" }),
    ["entry.ts", "side.ts"],
  );
});

test("the closure resolves an extensionless specifier like --sloppy-imports", () => {
  assert.deepEqual(
    closureOf({ "entry.ts": 'import { x } from "./lib";\n', "lib.ts": "export const x = 1;\n" }),
    ["entry.ts", "lib.ts"],
  );
});

test("the closure resolves a directory specifier to its index", () => {
  assert.deepEqual(
    closureOf({ "entry.ts": 'import { y } from "./util";\n', "util/index.ts": "export const y = 2;\n" }),
    ["entry.ts", "util/index.ts"],
  );
});

test("a .js specifier still maps to its .ts source", () => {
  assert.deepEqual(
    closureOf({ "entry.ts": 'import { z } from "./mod.js";\n', "mod.ts": "export const z = 3;\n" }),
    ["entry.ts", "mod.ts"],
  );
});
