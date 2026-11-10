import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import matter from "gray-matter";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler } from "../src/save-memory-handler.js";
import { editMemoryHandler } from "../src/edit-memory-handler.js";
import type { ToolDeps } from "../src/tool-deps.js";

const base = { title: "Invented fixture rule", summary: "Keep fixture decisions coherent", body: "Keep fixture artifacts complete.",
  topic_path: ["fixture"], tags: ["fixture-review"], scope: "all-projects", type: "lesson", recall_when: ["When changing invented fixture artifacts"] };
async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<ToolDeps> {
  const root = await mkdtemp(join(tmpdir(), "bastra-rule-text-review-"));
  const vault = new Vault(root); await vault.init(); const search = new SearchIndex(vault); search.start();
  t.after(async () => { search.stop(); await vault.stop(); await rm(root, { recursive: true, force: true }); });
  return { vault, search, telemetry: new Telemetry(), vaultPath: root };
}
function review(result: unknown): { status: string; fields: string[]; advice: string } | undefined {
  return (result as { rule_text_review?: { status: string; fields: string[]; advice: string } }).rule_text_review;
}

test("#1378: structural rule reviews cover creation and overwrite without diagnosing prose", async (t) => {
  const deps = await fixture(t);
  const cases = [
    "Release v9.8 is current. Update 2026-01-02: use the active milestone.",
    "Why: an invented incident on 2026-01-02. Example: `v9.8`.",
    "The owner explicitly limits this instruction to the invented migration.",
    "記録された判断を保持する。架空の例。",
  ];
  for (const [i, body] of cases.entries()) {
    const input = { ...base, id: `fixture-rule-${i}`, scope: `fixture-case-${i}`, body, write_origin: "user-directed", rulebook: "on-demand", applies_when: "When changing fixture artifacts" };
    const saved = await saveMemoryHandler(deps, input);
    assert.equal(review(saved)?.status, "not-assessed");
    assert.deepEqual(review(saved)?.fields, ["title", "summary", "body", "applies_when"]);
    assert.match(review(saved)?.advice ?? "", /complete resulting/);
    assert.match(review(saved)?.advice ?? "", /explicit owner time bounds/);
    assert.equal(deps.vault.get(input.id)!.body.trim(), body);
    const overwritten = await saveMemoryHandler(deps, { ...input, overwrite: true, body: "A coherent replacement." });
    assert.deepEqual(review(overwritten), review(saved));
  }
});

test("#1378: ordinary state notes get no rule review; agent proposals remain proposals", async (t) => {
  const deps = await fixture(t);
  const note = await saveMemoryHandler(deps, { ...base, id: "fixture-note", body: "v9.8 is the current release." });
  assert.equal(review(note), undefined);
  const proposal = await saveMemoryHandler(deps, { ...base, id: "fixture-proposal", scope: "fixture-proposal", rulebook: "always", applies_when: "When reviewing fixtures" });
  assert.equal(review(proposal)?.status, "not-assessed");
  assert.equal(deps.vault.get("fixture-proposal")!.fm.rulebook, undefined);
  assert.ok(deps.vault.get("fixture-proposal")!.fm.rulebook_proposed);
});

test("#1378: partial and metadata-only edits review the resulting rule, including a newly declared rule", async (t) => {
  const deps = await fixture(t);
  await saveMemoryHandler(deps, { ...base, id: "fixture-edited", write_origin: "user-directed" });
  assert.equal(review(await editMemoryHandler(deps, { id: "fixture-edited", append: "Initial state note." })), undefined);
  const declared = await editMemoryHandler(deps, { id: "fixture-edited", frontmatter: { rulebook: "on-demand", applies_when: "When editing fixture artifacts" } });
  assert.equal(review(declared)?.status, "not-assessed");
  for (const edit of [{ append: "Addendum: invented temporary state." }, { frontmatter: { summary: "A lasting fixture rule" } },
    { str_replace: { old_str: "Initial state note.", new_str: "Rewritten coherent explanation." } }]) {
    const result = await editMemoryHandler(deps, { id: "fixture-edited", ...edit });
    assert.deepEqual(review(result), review(declared));
  }
  assert.match(deps.vault.get("fixture-edited")!.body, /Rewritten coherent explanation/);
});


test("#1378: advice follows the committed declaration rather than a stale index or edit fragment", async (t) => {
  const deps = await fixture(t);
  await saveMemoryHandler(deps, { ...base, id: "fixture-stale", write_origin: "user-directed" });
  const mem = deps.vault.get("fixture-stale")!;
  const raw = matter(await readFile(mem.filePath, "utf8"));
  await writeFile(mem.filePath, matter.stringify(raw.content, { ...raw.data, rulebook: "always", applies_when: "When testing snapshots" }));
  assert.equal(mem.fm.rulebook, undefined);
  const edited = await editMemoryHandler(deps, { id: "fixture-stale", frontmatter: { summary: "Lasting fixture requirement" } });
  assert.equal(review(edited)?.status, "not-assessed");
  assert.equal(deps.vault.get("fixture-stale")!.fm.rule_text_review, undefined);
  const current = matter(await readFile(mem.filePath, "utf8"));
  delete current.data.rulebook;
  delete current.data.applies_when;
  await writeFile(mem.filePath, matter.stringify(current.content, current.data));
  assert.equal(deps.vault.get("fixture-stale")!.fm.rulebook, "always");
  const note = await editMemoryHandler(deps, { id: "fixture-stale", append: "An ordinary note continuation." });
  assert.equal(review(note), undefined);
});
