import test from "node:test";
import assert from "node:assert/strict";
import { agentEnvelope, sendAgentMessage } from "../cmux-agent-send.mjs";

const text = "Claude: please review this change.\nCodex: I will prepare the fixtures.";
const options = { text, from: "codex", surface: "11111111-1111-4111-8111-111111111111", workspace: "22222222-2222-4222-8222-222222222222" };
test("cmux sender marks the whole payload and sends to the same explicit target without a shell", () => {
  const calls = [];
  sendAgentMessage(options, (...args) => { calls.push(args); return { status: 0 }; });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "cmux");
  assert.deepEqual(calls[0][1].slice(0,2),['rpc','surface.send_text']);
  const payload=JSON.parse(calls[0][1][2]);assert.equal(payload.workspace_id,options.workspace);assert.equal(payload.surface_id,options.surface);
  assert.match(payload.text,/^<agent-message from="codex" transport="cmux" id="[0-9a-f-]+">/);
  assert.equal(JSON.parse(payload.text.replace(/^<agent-message[^>]*>/,'').replace(/<\/agent-message>$/,'')),text);
  assert.deepEqual(calls[1][1].slice(0,2),['rpc','surface.send_key']);
  assert.deepEqual(JSON.parse(calls[1][1][2]),{workspace_id:options.workspace,surface_id:options.surface,key:'enter'});
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
test('sender rejects ambiguous control text and uses raw JSON RPC plus canonical enter',()=>{
 for(const text of ['hello\tworld','hello\u009bworld','hello\u2028world','hello\u202eworld'])assert.throws(()=>agentEnvelope(text,'codex'));
 const calls=[];sendAgentMessage(options,(...args)=>{calls.push(args);return{status:0};});assert.equal(calls[0][1][1],'surface.send_text');assert.equal(JSON.parse(calls[1][1][2]).key,'enter');assert.ok(!JSON.parse(calls[0][1][2]).text.includes('\n'));
});

test('explicit refs are resolved read-only to terminal UUIDs before raw RPC',()=>{
 const calls=[];sendAgentMessage({...options,workspace:'workspace:2',surface:'surface:4'},(cmd,args)=>{calls.push(args);return{status:0,stdout:JSON.stringify({caller:{workspace_id:options.workspace,surface_id:options.surface,surface_type:'terminal'}})};});
 assert.equal(calls.length,3);assert.ok(calls[0].includes('identify'));assert.deepEqual(JSON.parse(calls[1][2]).surface_id,options.surface);
});
