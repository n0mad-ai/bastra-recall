import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexProjection } from '../../packages/statusline/src/codex/state.ts';
import { CodexLiveSource } from '../../packages/statusline/src/panel/codex-data.ts';
import { renderNeural } from '../../packages/statusline/src/panel/neural.ts';

const row = (payload, at = 100000) => ({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload });
const message = (turn, phase) => row({ type: 'item_completed', turn_id: turn, item: { type: 'AgentMessage', id: 'answer-' + turn, phase, text: 'Done' } });

test('Codex final answer ends activity without waiting for task_complete; commentary does not', () => {
  const p = new CodexProjection();
  p.accept(row({ type: 'task_started', turn_id: 'current' }));
  p.accept(message('current', 'commentary')); assert.equal(p.state.active, true);
  p.accept(message('older', 'final_answer')); assert.equal(p.state.active, true);
  p.accept(message('current', 'final_answer')); assert.equal(p.state.active, false);
  p.accept(row({ type: 'task_started', turn_id: 'next' })); assert.equal(p.state.active, true);
});

test('late terminal events from an older Codex turn cannot stop the current activity', () => {
  for (const type of ['task_complete', 'task_interrupted', 'turn_completed']) {
    const p = new CodexProjection();
    p.accept(row({ type: 'task_started', turn_id: 'current' }));
    p.accept(row({ type, turn_id: 'older' })); assert.equal(p.state.active, true, type);
    p.accept(row({ type, turn_id: 'current' })); assert.equal(p.state.active, false, type);
  }
});

test('Codex activity stops immediately at final answer despite fresh Recall feed and recent tool', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-panel-idle-'));
  const file = path.join(dir, 'rollout.jsonl');
  const start = 100000;
  const tool = row({ type: 'item_completed', turn_id: 't1', item: {
    type: 'McpToolCall', id: 'recall-1', server: 'bastra-recall', tool: 'recall', status: 'completed',
    result: { content: [{ type: 'text', text: '{"hits":[{}]}' }] },
  } }, start + 10);
  await writeFile(file, [
    { type: 'session_meta', payload: { id: 'ours', cwd: dir } },
    row({ type: 'task_started', turn_id: 't1' }, start), tool,
  ].map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(dir, '1.json'), JSON.stringify({ cc_session_id: 'ours', ts: start + 10, current_stage: 'vector', turn_id: start }));
  const source = new CodexLiveSource('ours', file, dir);
  const busy = await source.poll(start + 20);
  assert.equal(busy.agentActive, true); assert.equal(busy.active, true); assert.equal(busy.recent, true);
  await appendFile(file, JSON.stringify(message('t1', 'final_answer')) + '\n');
  const idle = await source.poll(start + 30);
  assert.equal(idle.agentActive, false); assert.equal(idle.active, false); assert.equal(idle.recent, false);
  assert.equal(idle.stage, 'Recall bereit'); assert.equal(idle.searches, 1); assert.equal(idle.hits, 1);
  for (const design of ['classic', 'orbital', 'ember']) {
    for (const compact of [false, true]) {
      for (const light of [false, true]) {
        assert.notDeepEqual(renderNeural(busy, 145, 1, true, design, { compact, light }), renderNeural(busy, 145, 12, true, design, { compact, light }), design + ' running');
        assert.deepEqual(renderNeural(idle, 145, 1, true, design, { compact, light }), renderNeural(idle, 145, 12, true, design, { compact, light }), design + ' idle');
      }
    }
  }
  await appendFile(file, JSON.stringify(row({ type: 'task_started', turn_id: 't2' }, start + 40)) + '\n');
  const next = await source.poll(start + 50);
  assert.equal(next.agentActive, true); assert.equal(next.searches, 0);
  assert.equal(next.active, false); assert.equal(next.recent, false);
});
