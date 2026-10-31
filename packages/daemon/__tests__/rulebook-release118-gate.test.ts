import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bookPendingMustLoad, clearShown, loadSessionState, mutateSessionState } from '../src/session-state.js';
import { beginRulebookRound, recordRulebookCheck, recordRulebookLoad, rulebookBoundary } from '../src/rulebook-check.js';
import { runGateLane } from '../src/gate-lane.js';
import type { KernelCandidates } from '../src/rulebook-catalog.js';

const validator = { tool: 'validate_artifact', channel: 'discord-dm', limit: 2000, unit: 'utf16' } as const;
const catalog: KernelCandidates = { entries: [{ id: 'copy-rule', revision: 'r1', title: 'Copy rule', body: 'Copy convention', group: 'explicit', updated: null, stale_status: 'unknown', rulebook: 'on-demand', validator }], omitted: 0 };
const payload = (session_id: string) => ({ session_id, bastra_client: 'claude-code' });
let root: string;
const previous = process.env.BASTRA_HOOK_STATE_DIR;
before(async () => { root = await mkdtemp(join(tmpdir(), 'release118-gate-')); process.env.BASTRA_HOOK_STATE_DIR = root; });
after(async () => { if (previous === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = previous; await rm(root, { recursive: true, force: true }); });
const loaded = (sid: string, agent?: string) => recordRulebookLoad(sid, 'copy-rule', agent, { revision: 'r1', validator });
async function hint(sid: string, revision: string | null = 'r1') {
  await mutateSessionState(sid, state => bookPendingMustLoad(state, ['copy-rule'], 'round:2', Date.now(), new Map([['copy-rule', revision]])));
}
async function denied(sid: string) {
  const out = JSON.parse(await runGateLane({ ...payload(sid), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo checked' } }, { reflexPool: () => [] }));
  return out.hookSpecificOutput?.permissionDecision === 'deny';
}
test('same full-loaded revision survives round advance and is not gated when shown again', async () => {
  const sid = 'loaded-next-round'; await loaded(sid);
  await beginRulebookRound(payload(sid), catalog);
  assert.equal((await recordRulebookCheck(sid, { applicable: ['copy-rule'] }, catalog)).ok, true);
  await hint(sid);
  assert.equal(await denied(sid), false);
});
test('changed/unknown revision, unloaded applicable ID and other actor loads still gate', async () => {
  for (const [sid, revision, load] of [['changed', 'r2', true], ['unknown', null, true], ['not-loaded', 'r1', false], ['worker-only', 'r1', false]] as const) {
    if (load) await loaded(sid);
    if (sid === 'worker-only') await loaded(sid, 'worker');
    await recordRulebookCheck(sid, { applicable: ['copy-rule'] }, catalog);
    await hint(sid, revision);
    assert.equal(await denied(sid), true, sid);
  }
});
test('compaction clears full-load evidence and the same revision gates again', async () => {
  const sid = 'compacted'; await loaded(sid); await clearShown(sid);
  await hint(sid); assert.equal(await denied(sid), true);
});
test('all explicit task stages are accepted while applicable action declarations remain valid', async () => {
  for (const task of ['none', 'approved-copy', 'translate-only', 'draft-for-review'] as const) {
    const sid = `reported-task-${task}`;
    await mutateSessionState(sid, s => { s.activeTask = { id: sid, kind: 'translate-only', since: 1, generation: 0 }; });
    const result = await recordRulebookCheck(sid, { applicable: ['copy-rule'], task }, catalog);
    assert.equal(result.ok,true);
    assert.equal((await loadSessionState(sid)).activeTask?.kind,task);
    assert.equal(await rulebookBoundary(payload(sid), catalog, 'action'), '{}', task);
  }
});
test('worker forbidden task report preserves its own check without inheriting main evidence', async () => {
  const sid = 'worker-task';
  assert.equal((await recordRulebookCheck(sid, { applicable: ['copy-rule'], agent_id: 'worker', task: 'draft-for-review' }, catalog)).ok, false);
  assert.equal(await rulebookBoundary({ ...payload(sid), agent_id: 'worker' }, catalog, 'action'), '{}');
  assert.notEqual(await rulebookBoundary(payload(sid), catalog, 'action'), '{}');
  assert.equal((await loadSessionState(sid)).activeTask, undefined);
});
test('explicit task end retains valid current-round non-applicable explanations', async () => {
  const sid = 'invalid-task-dismissal';
  assert.equal((await recordRulebookCheck(sid, { applicable: [], task: 'none', not_applicable: [{ id: 'copy-rule', reason: 'This is internal code work without correspondence.' }] }, catalog)).ok,true);
  assert.equal(await rulebookBoundary(payload(sid), catalog, 'stop'), '{}');
  assert.match(await beginRulebookRound(payload(sid), catalog), /copy-rule/);
});

test('a new explicit review report removes prose receipt duties but retains structural validator protection', async () => {
  const sid = 'approved-downgrade';
  await mutateSessionState(sid, s => {
    s.activeTask = { id: 'approved-copy@1', kind: 'approved-copy', approvalSource: 'user-turn', since: 1, generation: 0 };
    s.activeConventions = [{ id: 'copy-rule', revision: 'r1', validator, setAt: 1 }];
  });
  const result = await recordRulebookCheck(sid, {applicable: ['copy-rule'], task: 'draft-for-review'}, catalog);
  assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review');
  assert.equal(result.ok,true);
  assert.equal(await rulebookBoundary(payload(sid), catalog, 'action'), '{}', 'valid declarations still count');
  const { checkStopRepair } = await import('../src/stop-repair.js');
  assert.equal(await checkStopRepair({...payload(sid),hook_event_name:'Stop',transcript:[{role:'assistant',content:'Short review text without a receipt.'}]}),null);
  assert.equal((await checkStopRepair({...payload(sid),hook_event_name:'Stop',transcript:[{role:'assistant',content:'```\n'+'x'.repeat(2500)+'\n```'}]}))?.action,'request');
});
