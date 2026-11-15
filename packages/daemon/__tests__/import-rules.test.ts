/**
 * Tests für den Rules-Import (#209):
 *   - extractRulesCandidates — nur Listen-Zeilen, Prosa/Headings/Code-Fences
 *     bleiben draußen
 *   - findRulesFiles — Projekt-Dateien + .cursor/rules/ + globales
 *     ~/.claude/CLAUDE.md
 *
 * Runner: `tsx --test __tests__/import-rules.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRulesFiles, extractRulesCandidates } from "../src/import-rules.js";

test("extractRulesCandidates: list lines only — prose, headings and fenced code stay out", () => {
  const md = [
    "# Global rules", // heading → out
    "",
    "This paragraph explains the philosophy behind the rules in long prose form.", // prose → out
    "- Always answer in German, using the informal Du-Form",
    "  - Nested: keep replies terse and technical", // nested bullet → in
    "1. Never run git push without an explicit instruction",
    "```bash",
    "- this bullet lives inside a code fence and is an example", // fenced → out
    "```",
    "* Prefer surgical edits over speculative refactors",
    "- ok", // too short after cleaning → out
  ].join("\n");
  const r = extractRulesCandidates(md);
  assert.equal(r.emptyReason, null);
  assert.deepEqual(r.candidates, [
    "Always answer in German, using the informal Du-Form",
    "Nested: keep replies terse and technical",
    "Never run git push without an explicit instruction",
    "Prefer surgical edits over speculative refactors",
  ]);
});

// #314: a file that yields nothing names WHY — file vs. parser is answerable
// from the output alone.
test("extractRulesCandidates: empty yields name their reason", () => {
  assert.equal(extractRulesCandidates("").emptyReason, "empty file");
  assert.equal(extractRulesCandidates("   \n\n").emptyReason, "empty file");

  // the #314 repro: plain prose lines, no bullets — e.g. a hand-written .mdc
  const prose = extractRulesCandidates("Immer erst lesen, dann ändern.\nKeine spekulativen Abstraktionen.");
  assert.deepEqual(prose.candidates, []);
  assert.match(prose.emptyReason ?? "", /no list lines/);

  // list lines exist but nothing survives the cleaning pipeline
  const short = extractRulesCandidates("- ok\n- ja");
  assert.match(short.emptyReason ?? "", /none survived cleaning/);
});

test("findRulesFiles: picks up project files, .cursor/rules/ contents and the global CLAUDE.md", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bastra-rules-cwd-"));
  const home = await mkdtemp(join(tmpdir(), "bastra-rules-home-"));
  try {
    await writeFile(join(cwd, "CLAUDE.md"), "- rule", "utf8");
    await writeFile(join(cwd, "AGENTS.md"), "- rule", "utf8");
    await mkdir(join(cwd, ".cursor", "rules"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "rules", "b.mdc"), "- rule", "utf8");
    await writeFile(join(cwd, ".cursor", "rules", "a.mdc"), "- rule", "utf8");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "- rule", "utf8");

    const files = await findRulesFiles(cwd, home);
    assert.deepEqual(
      files.map((f) => f.label),
      ["CLAUDE.md", "AGENTS.md", ".cursor/rules/a.mdc", ".cursor/rules/b.mdc", "~/.claude/CLAUDE.md"]
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("findRulesFiles: empty when nothing exists", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bastra-rules-empty-"));
  const home = await mkdtemp(join(tmpdir(), "bastra-rules-emptyhome-"));
  try {
    assert.deepEqual(await findRulesFiles(cwd, home), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
