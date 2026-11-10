/**
 * #1376: the Stop hook must not send a save suggestion when a save or edit
 * after the suggestion's evidence already did what it asks.
 *
 * Run: node --import tsx --import ../../scripts/test-env.mjs --test __tests__/stop-no-save-eval-after-save.test.ts
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { correctionReminderSuggestions, dropSuggestionsAfterSave, type SaveSuggestion } from "../src/stop-heuristics.js";
import { runStopLane, type ClaudeStopPayload, type TranscriptTurn } from "../src/stop-lane.js";

const suggestion = (heuristic: string): SaveSuggestion =>
  ({ heuristic, title: "t", type: "decision", body: "b" }) as SaveSuggestion;
const DECISION = suggestion("architecture-decision");
const FEATURE = suggestion("feature-completion");
const FRUSTRATION = suggestion("frustration-density");
const CORRECTION = suggestion("correction-without-save");

const user = (content: string): TranscriptTurn => ({ role: "user", content });
const assistant = (content: string, tools?: string[], commands?: string[]): TranscriptTurn =>
  ({ role: "assistant", content, ...(tools ? { tools } : {}), ...(commands ? { commands } : {}) });
const tool = (content: string): TranscriptTurn => ({ role: "tool", content });
const saved = (name='save_memory'): TranscriptTurn[] => [{role:'assistant',content:'',calls:[{id:'save-fixture',name}]},{role:'tool',content:'',results:[{id:'save-fixture',content:JSON.stringify({id:'fixture',file_path:'/fixture'})}]}];
const notification = (): TranscriptTurn => ({ role: "system-injected", content: "<task-notification>done</task-notification>" });

describe("#1376: dropSuggestionsAfterSave", () => {
  it('keeps work after failed, held, unreturned or unlinked native save calls',()=>{
    const base=[user('2'),{role:'assistant',content:'',calls:[{id:'native',name:'save_memory'}]}];
    for(const results of [[],[{id:'native',failed:true,content:'failed'}],[{id:'other',content:JSON.stringify({id:'fixture',file_path:'/fixture'})}],[{id:'native',content:JSON.stringify({id:'fixture',hold:true})}]]){
      assert.deepEqual(dropSuggestionsAfterSave([...base,{role:'tool',content:'',results}],[DECISION]),[DECISION]);
    }
  });
  it("keeps every suggestion when no save tool ran after the latest user turn", () => {
    const turns = [user("we decided on option B"), assistant("ok", ["Read"])];
    const all = [DECISION, FEATURE, FRUSTRATION, CORRECTION];
    assert.deepEqual(dropSuggestionsAfterSave(turns, all), all);
  });

  for (const name of ["save_memory", "mcp__bastra-recall__save_memory", "edit_memory", "mcp__bastra-recall__edit_memory"]) {
    it(`drops user-turn suggestions when ${name} ran after the latest user turn`, () => {
      const turns = [user("we decided on option B"), ...saved(name)];
      assert.deepEqual(dropSuggestionsAfterSave(turns, [DECISION, FRUSTRATION, CORRECTION]), []);
    });
  }

  it("keeps the suggestion when the save belongs to an earlier round", () => {
    const turns = [user("a"), ...saved(), user("we decided on option B"), assistant("ok")];
    assert.deepEqual(dropSuggestionsAfterSave(turns, [DECISION]), [DECISION]);
  });

  it("ignores a prose mention of save_memory", () => {
    const turns = [user("we decided on option B"), assistant("I will call save_memory next")];
    assert.deepEqual(dropSuggestionsAfterSave(turns, [DECISION]), [DECISION]);
  });

  it("a task notification does not end the round", () => {
    const turns = [user("ship it"), assistant("", [], ["git commit -m x"]), ...saved(), notification(), assistant("done")];
    assert.deepEqual(dropSuggestionsAfterSave(turns, [FEATURE]), []);
  });

  it("feature-completion: a save after the commit drops it, a commit after the save keeps it", () => {
    const commitThenSave = [user("go"), assistant("", [], ["git commit -m a"]), tool("[main abc1234] a"), ...saved()];
    assert.deepEqual(dropSuggestionsAfterSave(commitThenSave, [FEATURE]), []);
    const saveThenCommit = [user("go"), ...saved(), assistant("", [], ["git commit -m b"])];
    assert.deepEqual(dropSuggestionsAfterSave(saveThenCommit, [FEATURE]), [FEATURE]);
    const saveThenCommitOutput = [user("go"), ...saved(), tool("[main abc1234] b")];
    assert.deepEqual(dropSuggestionsAfterSave(saveThenCommitOutput, [FEATURE]), [FEATURE]);
  });

  it("architecture-decision: an AskUserQuestion answer after the save keeps it", () => {
    const turns = [user("go"), ...saved(), assistant("", ["AskUserQuestion"]), tool('"Queue or polling?"="Queue"')];
    assert.deepEqual(dropSuggestionsAfterSave(turns, [DECISION]), [DECISION]);
  });
  it('an answer arriving after a completed save remains new evidence',()=>{
    const turns=[user('go'),{role:'assistant',content:'',tools:['AskUserQuestion'],calls:[{id:'ask-late',name:'AskUserQuestion'}]},...saved(),{role:'tool',content:'',results:[{id:'ask-late',content:'{"choice":"B"}'}]}];
    assert.deepEqual(dropSuggestionsAfterSave(turns,[DECISION]),[DECISION]);
  });

  it("drops only the suggestions whose evidence the save came after", () => {
    const turns = [user("decided: the queue"), ...saved(), assistant("", [], ["git commit -m c"])];
    assert.deepEqual(dropSuggestionsAfterSave(turns, [DECISION, FEATURE]), [FEATURE]);
  });
});

describe("#1376: the correction reminder counts edit_memory as a save", () => {
  const correction: TranscriptTurn[] = [
    user("Please keep the answer short and simple"), assistant("Here is a lengthy answer"),
    user("Please keep the answer short and simple!"), assistant("Here is another lengthy answer"),
    user("Please keep the answer short and simple!!"),
  ];
  it("reminds without a save, stays quiet after edit_memory", () => {
    assert.deepEqual(correctionReminderSuggestions(correction, []).map((s) => s.heuristic), ["correction-without-save"]);
    assert.deepEqual(correctionReminderSuggestions([...correction, ...saved("mcp__bastra-recall__edit_memory")], []), []);
  });
});

// ── call site: runStopLane ──────────────────────────────────────────────────

const OFFER = {role:"assistant",content:"Which architecture?\n1. Polling\n2. Queue"};
const DECIDED = { role: "user", content: "2" };
const SAVE_ROW = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__bastra-recall__save_memory", input: { title: "queue over polling" } }] },
};
const SAVE_RESULT = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({id:"fixture",file_path:"/fixture"}) }] } };

async function withSandbox<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1376-"));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"),
    BASTRA_HOOK_STATE_DIR: join(dir, "state"),
    HOME: dir,
    USERPROFILE: dir,
  };
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn(dir);
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const stop = (transcript: unknown[], extra: Partial<ClaudeStopPayload> = {}) =>
  runStopLane({ hook_event_name: "Stop", cwd: process.cwd(), transcript:[OFFER,...transcript], ...extra } as ClaudeStopPayload, "http://127.0.0.1:1");

async function deliveries(dir: string): Promise<unknown[]> {
  const logDir = join(dir, "logs");
  const rows: Record<string, unknown>[] = [];
  for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-"))) {
    for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) if (l.trim()) rows.push(JSON.parse(l));
  }
  return rows.filter((r) => r.kind === "save_eval_call").map((r) => r.delivery);
}

describe("#1376: runStopLane", () => {
  it("sends nothing when the decision was saved in the same round", async () => {
    await withSandbox(async (dir) => {
      assert.equal(await stop([DECIDED, SAVE_ROW, SAVE_RESULT, { role: "assistant", content: JSON.stringify({id:"fixture",file_path:"/fixture"}) }], { session_id: "cc-1376-a" }), "{}");
      assert.deepEqual(await deliveries(dir), ["already-saved"]);
    });
  });

  it("does not send the saved decision on the next round either", async () => {
    await withSandbox(async (dir) => {
      const round1 = [DECIDED, SAVE_ROW, SAVE_RESULT, { role: "assistant", content: JSON.stringify({id:"fixture",file_path:"/fixture"}) }];
      assert.equal(await stop(round1, { session_id: "cc-1376-b" }), "{}");
      const round2 = [...round1, { role: "user", content: "thanks, now rename the file" }, { role: "assistant", content: "renamed" }];
      assert.equal(await stop(round2, { session_id: "cc-1376-b" }), "{}", "the decision cue is still in the window");
      assert.deepEqual(await deliveries(dir), ["already-saved", undefined]);
    });
  });

  it("still sends the suggestion when the round had no save", async () => {
    await withSandbox(async () => {
      assert.notEqual(await stop([DECIDED, { role: "assistant", content: "noted" }], { session_id: "cc-1376-c" }), "{}");
    });
  });

  it("does not park a covered suggestion in the pending relay", async () => {
    await withSandbox(async (dir) => {
      assert.equal(await stop([DECIDED, SAVE_ROW, SAVE_RESULT], { session_id: "codex-1376", bastra_client: "codex" }), "{}");
      assert.equal(existsSync(join(dir, "pending.json")), false);
    });
  });
});
