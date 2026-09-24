/**
 * `npm pack --json` changed shape in npm 12: an object keyed by package name,
 * where npm ≤ 11 printed an array. Only one shape runs on any given machine,
 * so both are pinned here on fixtures.
 *
 * Run: node --test tools/__tests__/npm-pack-json.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { packEntry } from "../../scripts/npm-pack-json.mjs";

const daemon = { name: "@bastra-recall/daemon", integrity: "sha512-D==", files: [{ path: "skill/SKILL.md" }] };
const core = { name: "@bastra-recall/core", integrity: "sha512-C==", files: [] };

test("packEntry reads the npm ≤ 11 array and the npm 12 object, picking the package by name", () => {
  assert.deepEqual(packEntry(JSON.stringify([daemon]), daemon.name), daemon);
  assert.deepEqual(packEntry(JSON.stringify({ [daemon.name]: daemon }), daemon.name), daemon);
  // A workspace pack lists several packages; the entry is chosen by name, not position.
  assert.deepEqual(packEntry(JSON.stringify([core, daemon]), daemon.name), daemon);
  assert.deepEqual(packEntry(JSON.stringify({ [core.name]: core, [daemon.name]: daemon }), daemon.name), daemon);
});

test("packEntry skips lifecycle output printed before the JSON", () => {
  const out = `\n> ${daemon.name}@1.0.0 prepack\n> node scripts/prepare.mjs\n\n${JSON.stringify({ [daemon.name]: daemon }, null, 2)}\n`;
  assert.deepEqual(packEntry(out, daemon.name), daemon);
});

test("packEntry throws when the package is not there, instead of returning undefined digests", () => {
  assert.throws(() => packEntry(JSON.stringify([core]), daemon.name), /no entry for @bastra-recall\/daemon/);
  assert.throws(() => packEntry(JSON.stringify(daemon), daemon.name), /no entry/); // a bare entry object
  assert.throws(() => packEntry("null", daemon.name), /no entry/);
});
