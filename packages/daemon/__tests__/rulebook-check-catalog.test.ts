/** #1374: rulebook_check answers from the catalog the session's index was built from. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMemory } from "@bastra-recall/core";
import { beginRulebookRound, rulebookCheckHandler } from "../src/rulebook-check.js";
import { cachedRulebookCatalog } from "../src/rulebook-catalog.js";
import { loadSessionState } from "../src/session-state.js";

const memory = (id: string, scope: string, extra = "rulebook: on-demand\napplies_when: Invented situation\nwrite_origin: user-directed\n") => parseMemory(`---\nid: ${id}\ntitle: Invented\nsummary: Invented summary\ntype: workflow\nscope: ${scope}\n${extra}tags: [fixture]\ntopic_path: [fixture]\nrecall_when: [fixture]\n---\nInvented body`, `/unreadable/${id}`, 0);
const memories = [memory("invented-project-rule", "invented-project"), memory("invented-global-rule", "all-projects"), memory("invented-plain-note", "all-projects", "write_origin: agent-session\n")];
const vault = { list: () => memories, get: (id: string) => memories.find(m => m.fm.id === id) };
const deps = { vault } as never;
let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "rulebook-check-catalog-")); process.env.BASTRA_HOOK_STATE_DIR = root; process.env.BASTRA_TELEMETRY = "off"; });
after(() => rm(root, { recursive: true, force: true }));

test("a project-scoped rule shown in the session's index is accepted although the MCP server runs elsewhere", async () => {
  const sid = "project-index", p = { session_id: sid, bastra_client: "claude-code" };
  const index = await cachedRulebookCatalog(vault, { project: "invented-project", active: [] });
  assert.ok(index.entries.some(e => e.id === "invented-project-rule"), "the index shows the project rule");
  await beginRulebookRound(p, index);
  // stdio: project comes from the server's own cwd, which is another directory.
  const result = await rulebookCheckHandler(deps, { applicable: ["invented-project-rule"], session_id: sid }, { project: "unrelated-server-dir" });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("one unknown ID keeps the valid declarations and names why it is unknown", async () => {
  const sid = "partial-unknown", p = { session_id: sid, bastra_client: "claude-code" };
  await beginRulebookRound(p, await cachedRulebookCatalog(vault, { project: null, active: [] }));
  const result = await rulebookCheckHandler(deps, { applicable: ["invented-global-rule", "invented-plain-note", "invented-project-rule"], session_id: sid }, { project: null }) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknown_ids, [
    { id: "invented-plain-note", cause: "not-in-rulebook" },
    { id: "invented-project-rule", cause: "other-project" },
  ]);
  const main = JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors.find((a: { key: string }) => a.key === "main");
  assert.equal(main.checked, true);
  assert.deepEqual(main.ids, ["invented-global-rule"]);
});
