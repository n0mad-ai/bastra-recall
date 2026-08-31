/**
 * Guards the skill split (#232): SKILL.md carries triggers and points at four
 * reference files, and the gated subsystems name their reference file inside
 * the gate signal itself.
 *
 * The failure this prevents is silent. A renamed or deleted reference leaves a
 * pointer that resolves to nothing, and a reference nobody points at is never
 * read — neither breaks a build, a type check, or any other test. So the
 * pointers get checked as data.
 *
 * Run: npx tsx --test packages/daemon/__tests__/skill-references.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatAdoptionCandidateBlock } from "../src/curator-run.js";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skill");
const REFERENCES = ["topology.md", "taxonomy.md", "intake.md", "commons.md"];

async function skillBody(): Promise<string> {
  return readFile(join(SKILL_DIR, "SKILL.md"), "utf8");
}

test("every reference file SKILL.md points at exists next to it", async () => {
  const body = await skillBody();
  const pointed = [...body.matchAll(/`([a-z-]+\.md)`/g)].map((m) => m[1]);
  const external = new Set(["docs/commons.md"]); // repo-relative, not skill payload
  for (const name of new Set(pointed)) {
    if (external.has(name) || name === "SKILL.md" || name === "CLAUDE.md") continue;
    assert.equal(existsSync(join(SKILL_DIR, name)), true, `SKILL.md points at ${name}, which does not exist`);
  }
});

test("every reference file is pointed at from somewhere — no orphans", async () => {
  const body = await skillBody();
  const adoption = formatAdoptionCandidateBlock({ id: "x", title: "T", count: 3 });
  const sessionHook = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "session-hook.ts"),
    "utf8",
  );
  const surfaces = `${body}\n${adoption}\n${sessionHook}`;
  for (const name of REFERENCES) {
    assert.ok(surfaces.includes(name), `${name} is shipped but nothing points at it`);
  }
});

test("the skill payload is exactly SKILL.md plus the reference files", async () => {
  const entries = await readdir(SKILL_DIR, { withFileTypes: true });
  const markdown = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
  assert.deepEqual(markdown, ["SKILL.md", ...REFERENCES].sort());
});

test("gated subsystems name their reference file inside the gate signal", async () => {
  // The read-hint has to ride ON the gate, not in the always-loaded core —
  // otherwise the core pays for instructions that fire on ~10% of turns.
  const adoption = formatAdoptionCandidateBlock({ id: "mem-1", title: "Ein Fund", count: 4 });
  assert.match(adoption, /intake\.md/);

  // #369: the block lives in the daemon-side lane now — session-hook.ts is a
  // thin client and carries no prompt text at all.
  const sessionLane = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "session-lane.ts"),
    "utf8",
  );
  const taxonomyBlock = sessionLane.slice(
    sessionLane.indexOf("<vault-taxonomy>"),
    sessionLane.indexOf("</vault-taxonomy>"),
  );
  assert.ok(taxonomyBlock.length > 0, "the vault-taxonomy block moved — update this test");
  assert.match(taxonomyBlock, /taxonomy\.md/);
});

test("the core stayed a trigger file — save signals in, mechanics out", async () => {
  const body = await skillBody();
  // Save triggers must NOT migrate into the tool description: an agent sees
  // that only once it already reached for the tool, which is too late for
  // proactive capture (#232, explicit risk note).
  for (const cue of ["schon wieder", "immer X", "merk dir das gut"]) {
    assert.ok(body.includes(cue), `save trigger cue "${cue}" left the core`);
  }
  // Mechanics that the tool descriptions already carry must not come back.
  assert.doesNotMatch(body, /Hard cap 400/, "summary length mechanics belong in the tool description");
  assert.doesNotMatch(body, /weight 5 while the summary/, "recall_when weighting belongs in the tool description");

  const lines = body.split("\n").length;
  assert.ok(lines <= 160, `SKILL.md grew back to ${lines} lines — mechanics go to the tool description (#232)`);
});
