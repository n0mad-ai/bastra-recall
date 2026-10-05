import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseGitStatus, PanelGitReader } from '../../packages/statusline/src/panel/git-status.ts';
import { gitLabel, timingLabel, sessionLabel } from '../../packages/statusline/src/panel/details.ts';
import { ClaudeLiveSource, publishNative } from '../../packages/statusline/src/panel/claude-data.ts';
import { CodexLiveSource } from '../../packages/statusline/src/panel/codex-data.ts';

test('Git porcelain handles staged, modified, rename source, new files and conflicts separately', () => {
  const g = parseGitStatus('# branch.oid abcdef012345\0# branch.head main\0# branch.ab +2 -3\0' +
    '1 M. N... a b c d e staged\0' + '1 .M N... a b c d e changed\0' +
    '2 R. N... a b c d e R100 renamed\0? misleading original name\0? new file\0u UU N... a b c conflict\0');
  assert.equal(g.staged, 2); assert.equal(g.changed, 1); assert.equal(g.untracked, 1); assert.equal(g.conflicts, 1);
  assert.equal(g.ahead, 2); assert.equal(g.behind, 3); assert.equal(g.branch, 'main');
  assert.match(gitLabel({ git: g }), /@abcdef0/); assert.match(gitLabel({ git: g }), /1 Konflikte/);
});
test('Git failure is unknown, never a clean tree or a guessed ahead/behind', async () => {
  const g = await new PanelGitReader().read('/no-such-repository');
  assert.equal(g.known, false); assert.equal(gitLabel({ git: g }), 'Git —');
  const noUpstream = parseGitStatus('# branch.head feature\0');
  assert.equal(noUpstream.ahead, null); assert.doesNotMatch(gitLabel({ git: noUpstream }), /↑0/);
});
test('tiny costs are not false zeroes and absent client metrics are omitted', () => {
  assert.match(sessionLabel({ costUsd: 0.004 }), /<\$0.01/);
  assert.match(sessionLabel({ costUsd: 0 }), /\$0.00/);
  assert.equal(sessionLabel({}), '');
});
test('same-turn forwarder time matches the old footer while client overhead remains separate', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'panel-timing-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const at = Date.now(), transcript = path.join(dir, 'claude.jsonl');
  const row = (type, content, ts, extra = {}) => ({ type, sessionId: 's', timestamp: new Date(ts).toISOString(), message: { content }, ...extra });
  await writeFile(transcript, [row('user', 'Hi', at - 1000, { promptId: 'p' }),
    row('assistant', [{ type: 'tool_use', id: 'a', name: 'mcp__bastra-recall__recall' }], at - 500),
    row('user', [{ type: 'tool_result', tool_use_id: 'a', content: '{"hits":[{}]}' }], at - 298)].map(JSON.stringify).join('\n') + '\n');
  await publishNative({ session_id: 's', prompt_id: 'p', transcript_path: transcript }, dir);
  const feed = { cc_session_id: 's', turn_id: at - 1000, ts: at - 298, recall_count: 1, total_ms: 146 };
  await writeFile(path.join(dir, '1.json'), JSON.stringify(feed));
  const source = new ClaudeLiveSource('s', dir, dir);
  let d = await source.poll(Date.now()); assert.equal(d.latency, 146); assert.equal(d.clientLatency, 202);
  assert.equal(d.timingSource, 'forwarder'); assert.equal(timingLabel(d), 'Recall 146 ms · Client 202 ms');
  await writeFile(path.join(dir, '1.json'), JSON.stringify({ ...feed, turn_id: at - 50000 }));
  d = await source.poll(Date.now()); assert.equal(d.timingSource, 'client'); assert.equal(d.latency, 202);
  await writeFile(path.join(dir, '1.json'), JSON.stringify({ ...feed, recall_count: 2 }));
  d = await source.poll(Date.now()); assert.equal(d.timingSource, 'client');
});
test('Codex adapter maps its own context/quota and never substitutes Claude values', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-neural-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'codex.jsonl'), now = Date.now();
  const row = (type, payload) => ({ type, payload, timestamp: new Date(now - 1000).toISOString() });
  await writeFile(file, [row('session_meta', { id: 'codex-s', cwd: dir, timestamp: new Date(now - 60000).toISOString() }),
    row('turn_context', { model: 'gpt-test', effort: 'high' }),
    row('event_msg', { type: 'task_started', turn_id: 'turn1' }),
    row('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 120 }, total_token_usage: { total_tokens: 99999 }, model_context_window: 1000 },
      rate_limits: { primary: { used_percent: 18, window_minutes: 10080, resets_at: now / 1000 + 300 }, secondary: { used_percent: 42, window_minutes: 300 } } }),
    row('event_msg', { type: 'item_completed', turn_id: 'turn1', item: { type: 'McpToolCall', server: 'bastra-recall', tool: 'recall', id: 'a', status: 'completed', duration: { secs: 0, nanos: 202000000 }, result: { content: [{ type: 'text', text: '{"hits":[{},{}]}' }] } } }),
  ].map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(dir, '1.json'), JSON.stringify({ cc_session_id: 'codex-s', turn_id: now - 1000, ts: now - 100, recall_count: 1, total_ms: 146 }));
  const source = new CodexLiveSource('codex-s', file, dir);
  const d = await source.poll(now);
  assert.equal(d.client, 'codex'); assert.equal(d.model, 'gpt-test'); assert.equal(d.context, 12);
  assert.equal(d.contextFree, 880); assert.equal(d.usage, 18); assert.equal(d.tokens, 99999);
  assert.equal(d.searches, 1); assert.equal(d.hits, 2); assert.equal(d.latency, 146); assert.equal(d.clientLatency, 202);
  assert.equal((await source.poll(now)).searches, 1);
  const other = new CodexLiveSource('wrong-session', file, dir);
  assert.equal((await other.poll(now)).fresh, false); assert.equal((await other.poll(now)).fresh, false);
});
