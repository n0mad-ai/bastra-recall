import test from "node:test";
import assert from "node:assert/strict";
import { isSystemInjectedTurn, ownerPromptText } from "../src/system-turn.js";
import { normalizeTurns } from "../src/stop-transcript.js";
import { harvestCandidates } from "../src/session-harvest.js";
import { captureTypedDrafts } from "../src/draft-capture.js";
import { listDrafts } from "../src/draft-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const human = "Please keep the staging database separate from production in every deployment.";
const tags = ["local-command-stdout", "bash-input", "bash-stdout", "command-message"];
for (const tag of tags) {
  test(`${tag}: output stays excluded in Claude, Codex and prompt; suffix and quoted tags survive`, () => {
    const wrapped = `<${tag}>${human}</${tag}>`;
    assert.equal(isSystemInjectedTurn(" \n" + wrapped), true);
    assert.equal(ownerPromptText(wrapped), null);
    assert.equal(ownerPromptText(wrapped + "\n" + human), human);
    for (const shape of [
      (content: string) => ({ message: { role: "user", content } }),
      (content: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: content }] } }),
    ]) {
      const excluded = normalizeTurns([shape(wrapped), shape(wrapped)]);
      assert.ok(excluded.every(t => t.role === "system-injected"));
      assert.deepEqual(harvestCandidates(excluded), []);
      const suffix = normalizeTurns([shape(wrapped + "\n" + human)])[0];
      assert.equal(suffix.role, "user");
      assert.equal(suffix.content, human);
      for (const quote of [`Explain <${tag}> output`, `\`<${tag}>\` is a tag name`]) {
        assert.equal(ownerPromptText(quote), quote);
        assert.equal(normalizeTurns([shape(quote)])[0].role, "user");
      }
    }
    for (const broken of [`<${tag}>unclosed`, `<${tag}><${tag}>nested</${tag}>${human}`, `<${tag.toUpperCase()}>output</${tag.toUpperCase()}>${human}`]) {
      assert.equal(ownerPromptText(broken), null);
      assert.equal(normalizeTurns([{ role: "user", content: broken }])[0].role, "system-injected");
    }
  });
}

test("multiple complete wrappers and a reminder recover only the trailing human prompt", () => {
  const text = "<local-command-stdout>x</local-command-stdout>\n<bash-stdout>y</bash-stdout>\n<system-reminder>hook</system-reminder>\n" + human;
  assert.equal(ownerPromptText(text), human);
  assert.equal(normalizeTurns([{ role: "user", content: text }])[0].content, human);
});

test("direct harvest and capture recover attributed tool suffixes without losing metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrapper-suffix-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  const now = Date.now();
  try {
    const turns = [
      { role: "assistant", content: "How should staging be configured?", commands: ["deploy fixture.invalid"] },
      { role: "user", content: `<bash-stdout source="tool">untrusted output</bash-stdout>\n${human}`, cwd: "/fixture/staging", at: now },
    ];
    const candidates = harvestCandidates(turns);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].quote, human);
    assert.equal(candidates[0].turn, 1);
    await captureTypedDrafts(turns, { session_id: "suffix" }, now, candidates);
    const rows = await listDrafts(now);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quote, human);
    assert.equal(rows[0].evidence[0].ts, now);
    assert.ok(rows[0].situation.before.includes("deploy fixture.invalid"));
    assert.ok(!JSON.stringify(rows).includes("untrusted output"));
  } finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH; else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw wrapper turns never enter the broad draft store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrapper-drafts-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  const now = Date.now();
  try {
    await captureTypedDrafts(tags.map(tag => ({ role: "user", content: `<${tag}>${human}</${tag}>` })), { session_id: "tools" }, now, []);
    assert.deepEqual(await listDrafts(now), []);
  } finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH; else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
