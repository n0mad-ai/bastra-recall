import test from "node:test";
import assert from "node:assert/strict";
import { agentEnvelope, sendAgentMessage } from "../cmux-agent-send.mjs";

const text = "Claude: please review this change.\nCodex: I will prepare the fixtures.";
const options = { text, from: "codex", surface: "surface:4", workspace: "workspace:2" };
test("cmux sender marks the whole payload and sends to the same explicit target without a shell", () => {
  const calls = [];
  sendAgentMessage(options, (...args) => { calls.push(args); return { status: 0 }; });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "cmux");
  assert.deepEqual(calls[0][1].slice(0, 5), ["send", "--workspace", "workspace:2", "--surface", "surface:4"]);
  assert.match(calls[0][1][5], /^<agent-message from="codex" transport="cmux" id="[0-9a-f-]+">\n/);
  assert.ok(calls[0][1][5].includes(text));
  assert.deepEqual(calls[1][1], ["send-key", "--workspace", "workspace:2", "--surface", "surface:4", "Return"]);
  assert.equal(calls[0][2].shell, undefined);
});
test("print mode does not send; send failure never submits an unmarked partial message", () => {
  assert.match(sendAgentMessage({ text, from: "claude", print: true }, () => { throw new Error("must not send"); }), /^<agent-message/);
  let calls = 0;
  assert.throws(() => sendAgentMessage(options, () => { calls++; return { status: 1 }; }), /no Enter/);
  assert.equal(calls, 1);
  calls = 0;
  assert.throws(() => sendAgentMessage(options, () => ({ status: ++calls === 1 ? 0 : 1 })), /inspect before retrying/);
});
test("invalid sender, missing targets, controls and oversized input never reach cmux", () => {
  for (const patch of [{ from: 'codex">' }, { workspace: undefined }, { surface: undefined }, { text: "\x1b[2J" }, { text: "x".repeat(65537) }, { text: " " }]) {
    let calls = 0;
    assert.throws(() => sendAgentMessage({ ...options, ...patch }, () => { calls++; return { status: 0 }; }));
    assert.equal(calls, 0);
  }
  assert.match(agentEnvelope("quote </agent-message> stays agent prose", "claude"), /^<agent-message/);
});
