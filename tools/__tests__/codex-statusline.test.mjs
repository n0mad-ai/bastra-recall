import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexProjection, emptyStatus } from '../../packages/statusline/src/codex/state.ts';
import { renderCodex } from '../../packages/statusline/src/codex/render.ts';
import { RolloutSource, readRecallFeed, cmuxSession } from '../../packages/statusline/src/codex/source.ts';
import { stripAnsi, visibleLength } from '../../packages/statusline/src/utils/terminal.ts';
import { openCmuxPanel, shellQuote } from '../../packages/statusline/src/codex/cmux.ts';

const row = (type, payload) => ({ type, payload, timestamp: '2026-10-04T17:00:00Z' });
const start = id => row('event_msg', { type: 'task_started', turn_id: id });
const call = (id, tool, result, extra = {}) => row('event_msg', { type: 'item_completed', turn_id: 'turn1', item: {
  type: 'McpToolCall', id, server: 'bastra-recall', tool, status: 'completed',
  duration: { secs: 0, nanos: 12_000_000 }, result: { content: [{ type: 'text', text: JSON.stringify(result) }] }, ...extra,
}});

test('counts successful Bastra operations once, handles errors and late turn completions', () => {
  const p = new CodexProjection(); p.accept(start('turn1'));
  const search = call('s', 'recall', { hits: [{}, {}], vault_size: 42 });
  p.accept(search); p.accept(search);
  p.accept(call('l', 'load_memory', {})); p.accept(call('d', 'read_document', {}));
  p.accept(call('w', 'save_memory', {}));
  p.accept(call('x', 'save_memory', {}, { status: 'failed' }));
  p.accept(call('f', 'recall', {}, { server: 'foreign' }));
  assert.equal(p.state.calls, 5); assert.equal(p.state.searches, 1);
  assert.equal(p.state.loads, 2); assert.equal(p.state.saves, 1);
  assert.equal(p.state.errors, 1); assert.equal(p.state.hits, 2);
  assert.equal(p.state.ms, 60); assert.equal(p.state.vaultSize, 42);
  p.accept(start('turn2')); p.accept(search);
  assert.equal(p.state.calls, 0); assert.equal(p.state.vaultSize, 42);
});

test('usage comes from last request, quota labels come from actual window length', () => {
  const p = new CodexProjection();
  p.accept(row('event_msg', { type: 'token_count', info: {
    total_token_usage: { total_tokens: 1_000_000 }, last_token_usage: { total_tokens: 100 }, model_context_window: 1000,
  }, rate_limits: { primary: { used_percent: 14, window_minutes: 10080 }, secondary: null } }));
  assert.equal(p.state.contextUsed, 100); assert.equal(p.state.tokens, 1_000_000);
  const text = renderCodex(p.state, { width: 200, color: false }).join('\n');
  assert.match(text, /Kontext .*10%/); assert.match(text, /7d .*14% genutzt/); assert.doesNotMatch(text, /5h/);
  p.accept(row('event_msg', { type: 'token_count', info: null, rate_limits: null }));
  assert.equal(p.state.limits.length, 1);
});

test('Powerline fits narrow/wide terminals, retains Recall and strips terminal injection', () => {
  const s = { ...emptyStatus(), cwd: '/项目', model: 'model\x1b]52;c;secret\x07\n', branch: 'main', vaultSize: 42, calls: 2, searches: 1, hits: 3, loads: 1 };
  for (const width of [1, 3, 4, 12, 35, 80, 140, 200]) {
    for (const ascii of [true, false]) {
      const lines = renderCodex(s, { width, ascii });
      for (const line of lines) {
        assert.ok(visibleLength(line) <= width, `${width}: ${stripAnsi(line)}`);
        assert.doesNotMatch(stripAnsi(line), /[\x00-\x1f\x7f-\x9f]/);
      }
      if (width >= 35) assert.match(stripAnsi(lines[1]), /Recall/);
    }
  }
});

test('live stage expires, interrupted turn stops spinner, stale phrase disappears', () => {
  const now = 100_000;
  const s = { ...emptyStatus(), active: true };
  const feed = { ts: now, current_stage: 'vector', current_message: 'Semantik abgleichen', current_recall_started_at: now - 20 };
  assert.match(renderCodex(s, { feed, now, color: false })[1], /Semantik/);
  assert.doesNotMatch(renderCodex(s, { feed, now: now + 16000, color: false })[1], /Semantik/);
  assert.doesNotMatch(renderCodex({ ...s, active: false }, { feed, now, color: false })[1], /Semantik/);
});

test('usage bars use font-safe blocks, preserve spacing and represent zero/full distinctly', () => {
  for (const [percent, expected] of [[0, '────────'], [15, '━───────'], [100, '━━━━━━━━']]) {
    const state = { ...emptyStatus(), limits: [{ minutes: 10080, used: percent, resetsAt: null }] };
    const line = renderCodex(state, { width: 220, color: false })[0];
    assert.ok(line.includes(`${expected}  ${percent}% genutzt`));
    assert.doesNotMatch(line, /[▰▱]/);
  }
});

test('incremental source keeps partial UTF-8 rows, skips huge rows, replays replacement', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-statusline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const source = new RolloutSource(file, 'session');
  await writeFile(file, JSON.stringify(row('session_meta', { id: 'session', cwd: '/项目' })) + '\n' + JSON.stringify(start('turn1')) + '\n');
  await source.poll(); assert.equal(source.error, null);
  const partial = Buffer.from(JSON.stringify(call('s', 'recall', { hits: [{ title: 'ä' }] })) + '\n');
  const split = partial.indexOf(Buffer.from('ä')) + 1;
  await appendFile(file, partial.subarray(0, split)); await source.poll();
  assert.equal(source.projection.state.calls, 0);
  await appendFile(file, partial.subarray(split)); await source.poll(); await source.poll();
  assert.equal(source.projection.state.calls, 1);
  await appendFile(file, 'x'.repeat(3 * 1024 * 1024) + '\n' + JSON.stringify(call('l', 'load_memory', {})) + '\n');
  await source.poll(); assert.equal(source.projection.state.calls, 2);
  const replacement = path.join(dir, 'new.jsonl');
  await writeFile(replacement, JSON.stringify(row('session_meta', { id: 'session' })) + '\n');
  await rename(replacement, file); await source.poll(); assert.equal(source.projection.state.calls, 0);
});

test('feed and cmux binding require exact session/surface identity', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-binding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, '123.json'), JSON.stringify({ cc_session_id: 'ours', ts: 1 }));
  await writeFile(path.join(dir, '456.json'), JSON.stringify({ cc_session_id: 'other', ts: 999 }));
  assert.equal((await readRecallFeed(dir, 'ours')).ts, 1);
  assert.equal(await readRecallFeed(dir, 'missing'), null);
  await assert.rejects(cmuxSession(dir, 'missing'));
});

test('cmux launcher uses explicit targets, quotes shell arguments and sizes only the source border', () => {
  const calls = [];
  let lists = 0;
  const run = args => {
    calls.push(args);
    if (args.includes('list-panes')) return JSON.stringify({ panes: ++lists === 1
      ? [{ id: 'source-pane', surface_ids: ['source-surface'] }]
      : [{ id: 'panel-pane', surface_ids: ['new-surface'], cell_height_points: 17, pixel_frame: { height: 600 } }] });
    if (args.includes('new-split')) return JSON.stringify({ surface_id: 'new-surface' });
    return '{}';
  };
  openCmuxPanel({ surfaceId: 'source-surface', workspaceId: 'workspace', sessionId: 'session', transcriptPath: '/a' }, ['node', "/a b/it's.ts", '$(danger)'], run);
  const split = calls.find(a => a.includes('new-split'));
  assert.equal(split[split.indexOf('--focus') + 1], 'false');
  assert.equal(split[split.indexOf('--command') + 1], "'node' '/a b/it'\\''s.ts' '$(danger)'");
  assert.equal(calls.find(a => a.includes('resize-pane'))[2], 'source-pane');
  assert.equal(shellQuote('`x`'), "'`x`'");
});
