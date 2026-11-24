// UI v2 agent window (#1445): "save as memory" — the title and area
// proposals, the preview's edit → saving → saved/failed states and the
// mapping of the route's refusals, as pure logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

/** vm values come from another realm: compare their JSON shape. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const NAMES =
  "SAVE_TYPES, suggestTitle, scopeChoices, suggestScope, hasPrivateSource, draftInit, draftStep, draftView, saveFailure, postSave";

async function load(fetch?: typeof globalThis.fetch) {
  const source = await readFile(new URL("../webui/app/js/agent-save.js", import.meta.url), "utf8");
  return runInNewContext(source.replace(/^import .*;$/gm, "").replace(/^export /gm, "") + `\n({${NAMES}})`, {
    addStrings() {},
    en: {},
    de: {},
    Map,
    fetch,
  });
}

test("title proposal: deterministic, from a heading, the question or the answer", async () => {
  const { suggestTitle } = await load();
  assert.equal(suggestTitle("what did I decide about backups?", "Nightly at 2am."), "What did I decide about backups");
  assert.equal(suggestTitle("was gilt für Backups？", "x"), "Was gilt für Backups", "any trailing punctuation goes");
  assert.equal(suggestTitle("ignored", "## Backup plan\n\nNightly."), "Backup plan", "an opening heading wins");
  assert.equal(suggestTitle("", "- **Nightly** backups at 2am"), "Nightly backups at 2am");
  assert.equal(suggestTitle("  \n", ""), "");
  const long = suggestTitle("word ".repeat(40), "");
  assert.ok(long.length <= 80, long);
  assert.ok(!long.endsWith(" ") && !long.endsWith("…"), "cut at a word, no ellipsis");
  assert.equal(suggestTitle("q", "a"), suggestTitle("q", "a"), "same input, same title");
  assert.equal(suggestTitle("über den Umzug", ""), "Über den Umzug", "first letter upper case, any script");
});

const NODES = [
  { id: "a", kind: "memory", scope: "work" },
  { id: "b", kind: "memory", scope: "home" },
  { id: "c", kind: "memory", scope: "home", sensitivity: "private" },
  { id: "d", kind: "memory", scope: "home" },
  { id: "g", kind: "ghost", scope: "ghosts" },
];

test("area proposal: where the sources live, else the most used area", async () => {
  const { scopeChoices, suggestScope } = await load();
  assert.deepEqual(plain(scopeChoices(NODES)), ["home", "work"], "most used first, no ghosts");
  assert.equal(suggestScope(["a"], NODES), "work");
  assert.equal(suggestScope(["a", "b", "c"], NODES), "home");
  assert.equal(suggestScope([], NODES), "home");
  assert.equal(suggestScope(["missing"], NODES), "home");
  assert.equal(suggestScope([], null), "");
});

test("private hint: shown when a source is private", async () => {
  const { hasPrivateSource } = await load();
  assert.equal(hasPrivateSource(["a", "c"], NODES), true);
  assert.equal(hasPrivateSource(["a", "b"], NODES), false);
  assert.equal(hasPrivateSource(["a"], undefined), false);
});

const DRAFT = { title: "Backups", type: "reference", scope: "home", body: "Nightly." };

test("agent save sends the answer's conversation when one was stored (#1496)", async () => {
  const bodies: unknown[] = [];
  const { postSave } = await load(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "backups" });
  });
  const conversationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await postSave(DRAFT, ["a"], conversationId);
  await postSave(DRAFT, ["a"]);
  assert.deepEqual(bodies, [
    { ...DRAFT, sources: ["a"], conversation_id: conversationId },
    { ...DRAFT, sources: ["a"] },
  ]);
});

test("preview: edit → saving → saved; nothing moves while saving", async () => {
  const { draftInit, draftStep, draftView } = await load();
  let s = draftInit({ ...DRAFT });
  assert.deepEqual(plain(draftView(s)), { working: false, done: false, canSave: true, error: null, existing: [] });

  s = draftStep(s, { type: "save" });
  assert.equal(draftView(s).working, true);
  assert.equal(draftView(s).canSave, false, "no second request while saving");
  assert.equal(draftStep(s, { type: "save" }), s, "a second click changes nothing");
  assert.equal(draftStep(s, { type: "input", field: "title", value: "x" }), s, "fields are frozen");

  s = draftStep(s, { type: "saved", memory: { id: "backups", title: "Backups" } });
  assert.equal(draftView(s).done, true);
  assert.equal(draftStep(s, { type: "save" }), s, "a saved preview cannot save again");
});

test("preview: incomplete drafts cannot be saved; a failure keeps every input", async () => {
  const { draftInit, draftStep, draftView } = await load();
  for (const field of ["title", "scope", "body"]) {
    const s = draftStep(draftInit({ ...DRAFT }), { type: "input", field, value: "  " });
    assert.equal(draftView(s).canSave, false, field);
    assert.equal(draftStep(s, { type: "save" }), s, `${field} empty: save does nothing`);
  }
  let s = draftStep(draftInit({ ...DRAFT }), { type: "input", field: "title", value: "Backup plan" });
  s = draftStep(s, { type: "save" });
  s = draftStep(s, { type: "failed", error: "agent.save.held", existing: [{ id: "x", title: "X" }] });
  assert.equal(s.draft.title, "Backup plan", "the edited input stays");
  assert.equal(s.draft.body, "Nightly.");
  assert.equal(draftView(s).error, "agent.save.held");
  assert.deepEqual(draftView(s).existing, [{ id: "x", title: "X" }]);
  assert.equal(draftView(s).canSave, true, "can try again");
  s = draftStep(s, { type: "input", field: "title", value: "Backup plan 2026" });
  assert.equal(draftView(s).error, null, "editing clears the message");
});

test("refusals of the route become clear messages naming the existing memory", async () => {
  const { saveFailure } = await load();
  const exists = saveFailure(409, { code: "exists", existing: [{ id: "m1", title: "Mine" }, { nope: 1 }] });
  assert.equal(exists.error, "agent.save.exists");
  assert.deepEqual(plain(exists.existing), [{ id: "m1", title: "Mine" }]);
  assert.equal(saveFailure(409, { code: "held", existing: [{ id: "m2" }] }).existing[0].title, "m2");
  assert.equal(saveFailure(409, { code: "held" }).error, "agent.save.held");
  assert.equal(saveFailure(400, { error: "title required" }).error, "agent.save.invalid");
  assert.equal(saveFailure(404, { error: "ui disabled" }).error, "agent.save.off");
  assert.equal(saveFailure(404, {}).error, "agent.save.failed", "an unknown route is no switched-off UI");
  assert.equal(saveFailure(413, {}).error, "agent.save.tooLarge");
  assert.equal(saveFailure(0, {}).error, "agent.save.offline");
  assert.equal(saveFailure(500, null).error, "agent.save.failed");
  assert.equal(saveFailure(409, { code: "other" }).error, "agent.save.failed");
});

test("types offered: the daemon's authored set", async () => {
  const { SAVE_TYPES } = await load();
  const { UI_SAVE_TYPES } = await import("../src/webui-save-memory.js");
  assert.deepEqual(plain(SAVE_TYPES), [...UI_SAVE_TYPES]);
});
