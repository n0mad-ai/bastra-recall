/**
 * #787: the on/off parser exists twice — in the daemon's `env.ts` and in
 * core's `env-switch.ts` — because neither side can import the other: core
 * must not depend on the daemon, and `env.ts` is part of the hook stub's
 * source closure, which `deno compile` builds without any workspace package.
 * These tests keep the two copies to the same answers and keep `env.ts` (and
 * the rest of the closure) free of package imports.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/env-switch-parity-787.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOffValue as coreOff, isOnValue as coreOn } from "@bastra-recall/core";
import { isOffValue, isOnValue } from "../src/env.js";
// @ts-expect-error — plain .mjs build script, no types
import { stubSourceFiles } from "../scripts/stub-source-digest.mjs";

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

test("no file in the hook stub's source closure imports a package", () => {
  // The stub is a `deno compile` binary built from these files alone; an
  // import of @bastra-recall/core in env.ts broke that build (TS2307).
  const files: string[] = stubSourceFiles();
  assert.ok(files.some((f) => f.endsWith("/src/env.ts")), "env.ts is part of the closure");
  for (const f of files) {
    const specifiers = [...readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const foreign = specifiers.filter((s) => !s.startsWith(".") && !s.startsWith("node:"));
    assert.deepEqual(foreign, [], `${f} imports ${foreign.join(", ")}`);
  }
});
