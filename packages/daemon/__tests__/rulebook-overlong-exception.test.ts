/** #1364: one over-long not_applicable ID is named, the call's valid declarations survive. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMemory } from "@bastra-recall/core";
import { beginRulebookRound, requireActionRules, rulebookCheckHandler } from "../src/rulebook-check.js";
import { cachedRulebookCatalog } from "../src/rulebook-catalog.js";
import { loadSessionState } from "../src/session-state.js";

const rule = parseMemory("---\nid: invented-action-rule\ntitle: Invented\nsummary: Invented summary\ntype: workflow\nscope: all-projects\nwrite_origin: user-directed\nrulebook: on-demand\napplies_when: Invented situation\ntags: [fixture]\ntopic_path: [fixture]\nrecall_when: [fixture]\n---\nInvented body", "/unreadable/invented-action-rule", 0);
const vault = { list: () => [rule], get: () => rule };
let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "rulebook-overlong-")); process.env.BASTRA_HOOK_STATE_DIR = root; process.env.BASTRA_TELEMETRY = "off"; });
after(() => rm(root, { recursive: true, force: true }));

test("an over-long not_applicable ID does not discard the valid exception in the same call", async () => {
  const sid = "overlong", p = { session_id: sid, bastra_client: "claude-code" };
  await beginRulebookRound(p, await cachedRulebookCatalog(vault, { project: null, active: [] }));
  await requireActionRules(p, [{ id: "invented-action-rule", revision: null }]);
  const long = "x".repeat(201);
  const result = await rulebookCheckHandler({ vault } as never, { applicable: [], session_id: sid, not_applicable: [
    { id: long, reason: "This invented ID is far too long to be real." },
    { id: "invented-action-rule", reason: "This exact action rule does not apply here." },
  ] }) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /longer than 200/);
  assert.deepEqual(result.invalid_ids, [long.slice(0, 200) + "…"]);
  const main = JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors.find((a: { key: string }) => a.key === "main");
  assert.equal(main.checked, true);
  assert.deepEqual(main.required, []);
  assert.deepEqual(main.dismissed.map((r: { id: string }) => r.id), ["invented-action-rule"]);
});
