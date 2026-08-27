import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MEMORY_TOOL_DEFS } from "../src/tool-defs-memory.js";


const here = dirname(fileURLToPath(import.meta.url));


test("recall tool is gated by a missing durable fact and one call per turn", () => {
  const recall = MEMORY_TOOL_DEFS.find((tool) => tool.name === "recall");
  assert.ok(recall);
  assert.match(recall.description, /specific missing durable fact/i);
  assert.match(recall.description, /at most ONE recall call per user turn/);
  assert.match(recall.description, /Do NOT call at session start by default/);
  assert.doesNotMatch(recall.description, /At session start \(once\): query/);
  assert.doesNotMatch(recall.description, /Before writing\/editing a file/);
});


test("server and shipped skill do not restore recall-first prompting", async () => {
  const [forwarder, sessionContext, skill] = await Promise.all([
    readFile(resolve(here, "../src/mcp-forwarder.ts"), "utf8"),
    readFile(resolve(here, "../src/session-context.ts"), "utf8"),
    readFile(resolve(here, "../../skill/SKILL.md"), "utf8"),
  ]);
  assert.doesNotMatch(forwarder, /without being asked: \(1\)/);
  assert.doesNotMatch(forwarder, /before acting on a task, call `recall`/);
  assert.doesNotMatch(sessionContext, /Keep using recall before acting/);
  assert.doesNotMatch(skill, /Reflex order — RECALL first/);
  assert.match(skill, /One user turn gets at most \*\*one\*\* recall call/i);
});
