/**
 * #1462 — the MCP tool catalogue is paid for in every session of every client
 * that lists the tools, before anything has been recalled. Measured for 1.2.0
 * with tasks on: 57 tools, 119 kB; the save_memory entry alone was 20.9 kB,
 * because the rulebook field descriptions were sent four times per tool.
 *
 * These are ceilings, not targets: a new tool or a longer text that crosses one
 * fails here; shorten the text rather than raising a ceiling to admit it.
 * Sizes are the serialized tool
 * entries as `tools/list` sends them. The legacy *_BYTES ceilings below use
 * JSON.stringify(...).length (UTF-16 code units), not UTF-8 bytes or tokens.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/tool-catalog-budget.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_TOOL_DEFS, filterToolDefsForSurface, servedToolDefs } from "../src/tool-defs.js";
import { taskTools } from "../src/task-transport.js";

interface Def {
  name: string;
  description: string;
}

const size = (defs: readonly unknown[]): number => defs.reduce<number>((n, d) => n + JSON.stringify(d).length, 0);
const TASK_NAMES = new Set<string>(taskTools.map((t) => t.name));
const defs = ALL_TOOL_DEFS as Def[];

/** Longest single description (save_memory: 2.9k after #1462, was 6.2k). */
const MAX_DESCRIPTION_CHARS = 3_000;
/** Largest single entry incl. schema (save_memory: 12.6k after #1462, was 20.9k). */
const MAX_TOOL_BYTES = 13_500;
/** Everything except the task tools, document write on (44.5k after #1462, was 59.7k). */
const MAX_CORE_CATALOGUE_BYTES = 47_000;
/** Task descriptions carry the shared credential/authorization contract at every tool. */
const MAX_TASK_DESCRIPTION_CHARS = 1_800;
/** The task tools, including unchanged schemas (61.5k before the shared-text reduction). */
const MAX_TASK_CATALOGUE_BYTES = 56_000;

test("#1462: no tool description exceeds its budget", () => {
  const over = defs
    .filter((d) => d.description.length > MAX_DESCRIPTION_CHARS)
    .map((d) => `${d.name}=${d.description.length}`);
  assert.deepEqual(over, [], `descriptions over ${MAX_DESCRIPTION_CHARS} characters`);
});

test("#1462: no single tool entry exceeds its budget", () => {
  const over = defs.filter((d) => size([d]) > MAX_TOOL_BYTES).map((d) => `${d.name}=${size([d])}`);
  assert.deepEqual(over, [], `tool entries over ${MAX_TOOL_BYTES} bytes`);
});

test("#1462: task descriptions stay inside their tighter budget", () => {
  const over = taskTools
    .filter((d) => d.description.length > MAX_TASK_DESCRIPTION_CHARS)
    .map((d) => `${d.name}=${d.description.length}`);
  assert.deepEqual(over, [], `task descriptions over ${MAX_TASK_DESCRIPTION_CHARS} characters`);
});

test("#1462: the catalogue stays inside its budget, with and without the task tools", () => {
  const core = defs.filter((d) => !TASK_NAMES.has(d.name));
  assert.ok(size(core) <= MAX_CORE_CATALOGUE_BYTES, `core catalogue ${size(core)} > ${MAX_CORE_CATALOGUE_BYTES}`);
  assert.ok(
    size(taskTools) <= MAX_TASK_CATALOGUE_BYTES,
    `task catalogue ${size(taskTools)} > ${MAX_TASK_CATALOGUE_BYTES}`
  );
});

test("#1462: the read-only surface a client may choose stays small", () => {
  // What a `search` client lists: recall, load, rules, documents, code.
  const search = filterToolDefsForSurface(servedToolDefs(false), "search");
  assert.ok(size(search) <= 15_000, `search surface ${size(search)} bytes`);
});

test("#1462: a field description inside rulebook_proposed is not sent a second time", () => {
  const save = defs.find((d) => d.name === "save_memory") as unknown as {
    inputSchema: { properties: Record<string, { description?: string; properties?: Record<string, unknown> }> };
  };
  const proposed = save.inputSchema.properties.rulebook_proposed.properties!;
  for (const field of ["rulebook", "applies_when", "rule_categories", "validator"]) {
    assert.equal(
      (proposed[field] as { description?: string }).description,
      undefined,
      `${field} repeats its description inside rulebook_proposed`
    );
    assert.ok(save.inputSchema.properties[field].description, `${field} keeps its description one level up`);
  }
});
