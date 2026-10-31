/** Release replay: exact assistant text at JSONL index 131 (2026-10-31).
 * Draft/translation prose is not delivered copy; explicit copy regions still count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStopRepair } from '../src/stop-repair.js';
import { loadSessionState, mutateSessionState } from '../src/session-state.js';
import { beginRulebookRound, recordRulebookCheck, roundCorrespondence } from '../src/rulebook-check.js';
import type { KernelCandidates } from '../src/rulebook-catalog.js';

const validator = { tool: 'validate_artifact', channel: 'discord-dm', limit: 2000, unit: 'utf16' } as const;
const catalog: KernelCandidates = { entries: [{ id: 'copy-rule', title: 'Copy rule', group: 'explicit', rulebook: 'on-demand', applies_when: 'Correspondence', body: 'Fixture', revision: 'r1', updated: null, stale_status: 'unknown', validator }], omitted: 0 };
async function sandbox(fn: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'repair-release118-'));
  const prior = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = root;
  try { await fn(); } finally {
    if (prior === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
}
async function seed(sid: string, kind: 'draft-for-review' | 'translate-only' | 'approved-copy', actor?: string) {
  await mutateSessionState(sid, s => {
    s.activeTask = { id: `${kind}@1`, kind, since: 1, generation: 0 };
    s.activeConventions = [{ id: 'copy-rule', revision: 'r1', setAt: 1, validator }];
  });
  assert.equal((await recordRulebookCheck(sid, { applicable: ['copy-rule'], ...(actor ? {agent_id: actor} : {}) }, catalog)).ok, true);
}
function stop(sid: string, content: string, actor?: string, client = 'claude-code') {
  return checkStopRepair({ session_id: sid, hook_event_name: 'Stop', bastra_client: client, ...(actor ? {agent_id: actor} : {}), transcript: [{role: 'assistant', content}] });
}

test('release118: exact index 131 translation plus German draft produces zero repairs on legacy and round paths', async () => {
  await sandbox(async () => {
    const text = await readFile(new URL('./fixtures/release118-draft-index131.txt', import.meta.url), 'utf8');
    assert.ok(text.length > 2000);
    for (const [sid, actor, client, kind] of [
      ['legacy', undefined, 'claude-code', 'draft-for-review'],
      ['worker', 'worker', 'claude-code', 'draft-for-review'],
      ['codex', undefined, 'codex', 'draft-for-review'],
      ['translation', undefined, 'claude-code', 'translate-only'],
    ] as const) {
      await seed(sid, kind, actor);
      for (let attempt = 0; attempt < 3; attempt++) assert.equal(await stop(sid, text, actor, client), null, sid);
      assert.equal((await loadSessionState(sid)).repairAttempts, undefined, sid);
    }
  });
});
test('release118: short prose and short fences in draft need no receipt; approved copy still does', async () => {
  await sandbox(async () => {
    for (const [i, text] of ['Kurzer deutscher Vorschlag.', '```\nKurzer Vorschlag.\n```'].entries()) {
      const sid = 'short-' + i; await seed(sid, 'draft-for-review');
      assert.equal(await stop(sid, text), null);
    }
    await seed('approved', 'approved-copy');
    assert.equal((await stop('approved', 'Final copy.'))?.action, 'request');
  });
});
test('release118: draft and translation still enforce oversized fences and unclosed fences on both paths', async () => {
  await sandbox(async () => {
    for (const kind of ['draft-for-review', 'translate-only'] as const) {
      for (const actor of [undefined, 'worker']) {
        for (const [i, text] of ['```\n' + 'x'.repeat(2001) + '\n```', '```\n' + 'x'.repeat(2001)].entries()) {
          const sid = `${kind}-${actor}-${i}`; await seed(sid, kind, actor);
          assert.equal((await stop(sid, text, actor))?.action, 'request', sid);
        }
      }
    }
  });
});

test('release118: repairing a draft fence never turns the surrounding translation into copy', async () => {
  await sandbox(async () => {
    const translation = await readFile(new URL('./fixtures/release118-draft-index131.txt', import.meta.url), 'utf8');
    for (const [actor, client] of [[undefined, 'claude-code'], ['worker', 'claude-code'], [undefined, 'codex']] as const) {
      const sid = 'followup-' + actor + client;
      await seed(sid, 'draft-for-review', actor);
      const initial = await stop(sid, '```\n' + 'x'.repeat(2001) + '\n```', actor, client);
      assert.equal(initial?.action, client === 'codex' ? 'observed' : 'request');
      const state = await loadSessionState(sid);
      assert.equal(roundCorrespondence(state, {bastra_client: client, agent_id: actor}).repairProse, false);
      assert.equal(await stop(sid, translation + '\n```\nKurzer Vorschlag.\n```', actor, client), null);
    }
  });
});
test('release118: no-task prose repair cannot be hidden by a model draft report; the next user round resets that origin', async () => {
  await sandbox(async () => {
    const sid = 'repair-origin';
    assert.equal((await recordRulebookCheck(sid, {applicable: ['copy-rule']}, catalog)).ok, true);
    assert.equal((await stop(sid, 'x'.repeat(2001)))?.action, 'request');
    assert.equal((await recordRulebookCheck(sid, {applicable: ['copy-rule'], task: 'draft-for-review'}, catalog)).ok, true);
    assert.equal((await stop(sid, 'x'.repeat(2001)))?.action, 'request');
    await beginRulebookRound({session_id: sid, bastra_client: 'claude-code'}, catalog);
    await recordRulebookCheck(sid, {applicable: ['copy-rule']}, catalog);
    assert.equal(await stop(sid, 'x'.repeat(2001)), null);
  });
});
