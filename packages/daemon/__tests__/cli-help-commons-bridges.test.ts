/**
 * `bastra commons --help` omitted `verify` and promised "nothing of yours is
 * sent anywhere", while `commons verify` pushes a branch and opens a public PR
 * carrying the recipe id, result, note, verifier id, OS, arch and Node version.
 * The bridges help still called the pool "language-partitioned" although
 * query expansion reads every folder when no language is set (#707); an
 * override limits query expansion, while new bridges use detected language.
 *
 * Run: npx tsx --test packages/daemon/__tests__/cli-help-commons-bridges.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { COMMAND_HELP, showHelp } from "../src/cli/help-text.js";

function captureShowHelp(command?: string): string {
  let out = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try { showHelp(command); } finally { process.stdout.write = original; }
  return out;
}

test("commons help lists verify and says what verify sends", () => {
  const help = COMMAND_HELP.commons;
  assert.match(help, /commons <enable\|update\|disable\|status>\n\s+bastra commons verify /);
  assert.match(help, /^ {2}verify /m);
  assert.match(help, /public/i);
  for (const field of ["recipe id", "result", "note", "OS", "architecture", "Node version"]) {
    assert.ok(help.includes(field), `commons help does not name what verify sends: ${field}`);
  }
  assert.doesNotMatch(help, /nothing of yours is sent anywhere/);
});

test("the top-level help lists commons verify", () => {
  assert.match(captureShowHelp(), /commons <enable\|update\|disable\|status\|verify>/);
});

test("bridges help no longer calls the pool language-partitioned", () => {
  assert.doesNotMatch(COMMAND_HELP.bridges, /language-partitioned/);
  assert.doesNotMatch(captureShowHelp(), /language-partitioned/);
  // The setting does change which bridges fire: with an override, expandQuery
  // consults only that folder.
  assert.match(COMMAND_HELP.bridges, /Without a language setting every\s+folder is searched; an override limits query expansion to one folder/);
  assert.match(COMMAND_HELP.bridges, /New\s+bridges are filed by the detected language of their source query/);
  assert.match(COMMAND_HELP.bridges, /language\s+Show or set the query-language override/);
  assert.doesNotMatch(COMMAND_HELP.bridges, /partition language|files new bridges there/);
});
