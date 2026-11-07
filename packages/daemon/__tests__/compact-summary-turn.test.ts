import {test} from "node:test";
import assert from "node:assert/strict";
import {normalizeOwnerTurn, normalizeTurns, parseTranscriptFile} from "../src/stop-transcript.js";
import {optionPicks} from "../src/stop-lane-choice.js";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {checkStopRepair} from "../src/stop-repair.js";
import {mutateSessionState} from "../src/session-state.js";

const summary = "This session is being continued from a previous conversation. 2";

test("#1373 Claude compact summaries do not displace typed turns in the choice window", () => {
  const rows = [
    {type: "assistant", message: {role: "assistant", content: "Which?\n1. First\n2. Second"}},
    {type: "user", message: {role: "user", content: "2"}},
    {type: "user", isCompactSummary: true, message: {role: "user", content: summary}},
  ];
  const turns = parseTranscriptFile(rows.map(row => JSON.stringify(row)).join("\n"));
  assert.equal(turns[2].role, "system-injected");
  assert.deepEqual(turns.filter(turn => turn.role === "user").map(turn => turn.content), ["2"]);
  assert.deepEqual(optionPicks(turns, 1), ["2"]);
});

test("#1373 direct compact summaries do not hide assistant copy from Stop repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compact-summary-"));
  const old = {BASTRA_HOOK_STATE_DIR: process.env.BASTRA_HOOK_STATE_DIR, BASTRA_STOP_SAME_TURN: process.env.BASTRA_STOP_SAME_TURN};
  Object.assign(process.env, {BASTRA_HOOK_STATE_DIR: dir, BASTRA_STOP_SAME_TURN: "1"});
  try {
    await mutateSessionState("compact", state => {
      state.activeTask = {id: "copy", kind: "draft-for-review", generation: 0, since: 1};
      state.activeConventions = [{id: "copy-rule", revision: "r1", setAt: 1, validator: {tool: "validate_artifact", channel: "discord-dm", limit: 2000, unit: "utf16"}}];
    });
    assert.equal((await checkStopRepair({session_id: "compact", bastra_client: "claude-code"}, [
      {role: "user", content: "Please draft"},
      {role: "assistant", content: "```\n" + "x".repeat(2500) + "\n```"},
      {role: "user", content: summary, isCompactSummary: true},
      {role: "assistant", content: "Status"},
    ]))?.action, "request");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, {recursive: true, force: true});
  }
});

test("#1373 compact provenance is respected on every supported transcript shape", () => {
  for (const row of [
    {role: "user", content: summary, isCompactSummary: true},
    {message: {role: "user", content: summary, isCompactSummary: true}},
    {type: "response_item", isCompactSummary: true, payload: {type: "message", role: "user", content: summary}},
    {type: "response_item", payload: {type: "message", role: "user", content: summary, isCompactSummary: true}},
  ]) assert.equal(normalizeTurns([row])[0].role, "system-injected");
  assert.equal(normalizeOwnerTurn({role: "user", content: summary, isCompactSummary: true}).role, "system-injected");
  for (const isCompactSummary of [undefined, false]) {
    assert.equal(normalizeTurns([{role: "user", content: summary, isCompactSummary}])[0].role, "user", "the marker, not summary wording, determines provenance");
  }
});
