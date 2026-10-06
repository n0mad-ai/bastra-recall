import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeLiveSource, publishNative, cmuxWorking } from '../../packages/statusline/src/panel/claude-data.ts';
import { renderNeural } from '../../packages/statusline/src/panel/neural.ts';

test('Claude terminal hooks override stale running status and prompt depth', () => {
  for (const hookEventName of ['Stop', 'SessionEnd', 'SessionStart', 'Notification']) {
    assert.equal(cmuxWorking({ hookEventName, agentLifecycle: 'running', runtimeStatus: 'running', activePromptDepth: 1 }), false, hookEventName);
  }
  assert.equal(cmuxWorking({ hookEventName: 'UserPromptSubmit', agentLifecycle: 'running', activePromptDepth: 1 }), true);
});

test('Claude stops all themes at Stop despite pending transcript tools and a fresh feed, then resumes on the next prompt', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-panel-idle-'));
  t.mock.method(os, 'homedir', () => dir);
  await mkdir(path.join(dir, '.cmuxterm'));
  const registry = path.join(dir, '.cmuxterm', 'claude-hook-sessions.json');
  const setHook = hookEventName => writeFile(registry, JSON.stringify({ sessions: { ours: {
    sessionId: 'ours', hookEventName, agentLifecycle: 'running', runtimeStatus: 'running', activePromptDepth: 1,
  } } }));
  const file = path.join(dir, 'claude.jsonl'), now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const row = (type, content, at, extra = {}) => ({ type, sessionId: 'ours', timestamp: new Date(at).toISOString(), message: { content }, ...extra });
  await writeFile(file, [
    row('user', 'Hi', now - 1000, { promptId: 'p1' }),
    row('assistant', [{ type: 'tool_use', id: 'done', name: 'mcp__bastra-recall__recall' }], now - 500),
    row('user', [{ type: 'tool_result', tool_use_id: 'done', content: '{"hits":[{}]}' }], now - 100),
    row('assistant', [{ type: 'tool_use', id: 'pending-recall', name: 'mcp__bastra-recall__recall' }, { type: 'tool_use', id: 'pending-bash', name: 'Bash' }], now - 50),
  ].map(JSON.stringify).join('\n') + '\n');
  await publishNative({ session_id: 'ours', transcript_path: file, prompt_id: 'p1', cwd: dir }, dir);
  await writeFile(path.join(dir, '1.json'), JSON.stringify({ cc_session_id: 'ours', ts: now - 10, current_stage: 'vector' }));
  await setHook('UserPromptSubmit');
  const source = new ClaudeLiveSource('ours', dir, dir);
  const busy = await source.poll(now);
  assert.equal(busy.active, true); assert.equal(busy.agentActive, true); assert.equal(busy.recent, true);
  await setHook('Stop');
  const idle = await source.poll(now + 20);
  assert.equal(idle.active, false); assert.equal(idle.agentActive, false); assert.equal(idle.recent, false);
  assert.equal(idle.stage, 'Recall bereit'); assert.equal(idle.searches, 1); assert.equal(idle.hits, 1);
  for (const design of ['classic', 'orbital', 'ember']) {
    for (const compact of [false, true]) {
      for (const light of [false, true]) {
        assert.notDeepEqual(renderNeural(busy, 145, 1, true, design, { compact, light }), renderNeural(busy, 145, 12, true, design, { compact, light }), design + ' running');
        assert.deepEqual(renderNeural(idle, 145, 1, true, design, { compact, light }), renderNeural(idle, 145, 12, true, design, { compact, light }), design + ' idle');
      }
    }
  }
  await appendFile(file, JSON.stringify(row('user', 'Next', now + 50, { promptId: 'p2' })) + '\n');
  await setHook('UserPromptSubmit');
  const next = await source.poll(now + 60);
  assert.equal(next.agentActive, true); assert.equal(next.active, false); assert.equal(next.recent, false);
  assert.equal(next.searches, 0);
});
