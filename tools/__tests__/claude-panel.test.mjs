import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeSnapshot, publishNative, snapshotPath, ClaudeCalls, ClaudeLiveSource } from '../../packages/statusline/src/panel/claude-data.ts';
import { renderNeural, NEURAL_DEMO } from '../../packages/statusline/src/panel/neural.ts';
import { visibleLength } from '../../packages/statusline/src/utils/terminal.ts';
import { TerminalFrame } from '../../packages/statusline/src/panel/terminal-frame.ts';
import { resetCountdown } from '../../packages/statusline/src/panel/reset-time.ts';

const row = (type, content, extra = {}) => ({ type, sessionId: 's', timestamp: '2026-10-04T18:00:00Z', message: { content }, ...extra });
const call = (id, name) => row('assistant', [{ type: 'tool_use', id, name: 'mcp__bastra-recall__' + name }]);
const result = (id, content = {}, error = false) => row('user', [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(content), is_error: error }], { timestamp: '2026-10-04T18:00:00.120Z' });
const native = { session_id: 's', workspace: { project_dir: '/project/bastra' }, model: { display_name: 'Opus' },
  context_window: { used_percentage: 24, total_input_tokens: 50, total_output_tokens: 10, context_window_size: 100 },
  rate_limits: { seven_day: { used_percentage: 70 } } };

test('native values win; missing/null values stay unknown; invalid identity is refused', () => {
  assert.equal(nativeSnapshot(native).context, 24);
  assert.equal(nativeSnapshot(native).usage, 70);
  assert.equal(nativeSnapshot({ session_id: 's' }).context, null);
  assert.equal(nativeSnapshot({ ...native, rate_limits: { seven_day: { used_percentage: null } } }).usage, null);
  assert.equal(nativeSnapshot({ ...native, context_window: { ...native.context_window, used_percentage: undefined } }).context, 50);
  assert.throws(() => snapshotPath('../s')); assert.throws(() => nativeSnapshot({}));
});
test('Claude counts results once, isolates session/sidechain, resets on a new real prompt', () => {
  const c = new ClaudeCalls('s');
  const prompt = row('user', 'Hi', { promptId: 'p' }); c.accept(prompt);
  c.accept(call('a', 'recall')); c.accept(result('a', { hits: [{}, {}] })); c.accept(result('a', { hits: [{}] }));
  c.accept(call('b', 'load_memory')); c.accept(result('b'));
  c.accept(call('x', 'save_memory')); c.accept(result('x', {}, true));
  c.accept({ ...call('other', 'recall'), sessionId: 'other' });
  c.accept({ ...call('side', 'recall'), isSidechain: true });
  c.accept(prompt);
  assert.equal(c.searches, 1); assert.equal(c.hits, 2); assert.equal(c.loads, 1); assert.equal(c.saves, 0); assert.equal(c.errors, 1);
  assert.equal(c.ms, 360); assert.equal(c.pending.size, 0);
  c.accept(row('user', 'Next', { promptId: 'new', timestamp: '2026-10-04T18:01:00Z' }));
  c.accept(result('old')); assert.equal(c.loads, 0); assert.equal(c.ms, 0);
});
test('live source incrementally reads exact session; stale native values and unreadable transcript stay unknown', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-panel-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  await writeFile(file, [row('user', 'Hi', { promptId: 'p' }), call('a', 'load_memory'), result('a')].map(JSON.stringify).join('\n') + '\n');
  await publishNative({ ...native, transcript_path: file }, dir);
  const source = new ClaudeLiveSource('s', dir, dir);
  let d = await source.poll(); assert.equal(d.loads, 1); assert.equal(d.context, 24); assert.equal(d.latency, 120);
  d = await source.poll(); assert.equal(d.loads, 1);
  await appendFile(file, JSON.stringify(call('b', 'recall')) + '\n');
  d = await source.poll(); assert.equal(d.active, true);
  d = await source.poll(Date.now() + 11000); assert.equal(d.context, null); assert.equal(d.loads, null);
  await publishNative({ ...native, transcript_path: path.join(dir, 'absent') }, dir);
  d = await source.poll(); assert.equal(d.context, 24); assert.equal(d.loads, null);
});
test('classic/orbital are interchangeable and snapshots do not animate fake activity', () => {
  assert.match(renderNeural(NEURAL_DEMO, 130, 0, false, 'classic').join('\n'), /NEURAL CONSOLE/);
  assert.match(renderNeural(NEURAL_DEMO, 130, 0, false, 'orbital').join('\n'), /MEMORY CORE/);
  for (const design of ['classic', 'orbital']) {
    for (const w of [1, 20, 55, 56, 90, 130, 180]) {
      for (const line of renderNeural(NEURAL_DEMO, w, 2, true, design)) assert.ok(visibleLength(line) <= w);
    }
    const snapshot = { ...NEURAL_DEMO, mode: 'snapshot' };
    assert.deepEqual(renderNeural(snapshot, 130, 1, true, design), renderNeural(snapshot, 130, 20, true, design));
  }
});

test('short calls between polls leave a visible afterglow without claiming to be running', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-pulse-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  const now = Date.now();
  const records = [row('user', 'Hi', { promptId: 'p', timestamp: new Date(now - 200).toISOString() }),
    { ...call('a', 'recall'), timestamp: new Date(now - 60).toISOString() },
    { ...result('a', { hits: [{}, {}] }), timestamp: new Date(now - 10).toISOString() }];
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  await publishNative({ ...native, transcript_path: file }, dir);
  const source = new ClaudeLiveSource('s', dir, dir);
  const d = await source.poll(now + 5);
  assert.equal(d.active, false); assert.equal(d.recent, true); assert.equal(d.searches, 1); assert.equal(d.hits, 2);
  assert.match(d.stage, /Zuletzt/);
  assert.notDeepEqual(renderNeural(d, 130, 1, false, 'orbital'), renderNeural(d, 130, 15, false, 'orbital'));
  assert.equal((await source.poll(now + 5100)).recent, false);
});

test('general Claude tools animate the activity signal without animating Recall as a live search', () => {
  const c = new ClaudeCalls('s');
  const b = call('b', 'recall'); b.message.content[0].name = 'Bash';
  c.accept(b); assert.equal(c.pendingTools.size, 1); assert.equal(c.pending.size, 0);
  c.accept(result('b')); assert.equal(c.pendingTools.size, 0); assert.equal(c.searches, 0);
  const d = { ...NEURAL_DEMO, mode: 'live', fresh: true, active: false, recent: false, agentActive: true };
  const a = renderNeural(d, 130, 1, false, 'orbital'), z = renderNeural(d, 130, 15, false, 'orbital');
  assert.deepEqual(a.slice(5, 10), z.slice(5, 10)); // core stays quiet
  assert.notEqual(a.at(-2), z.at(-2)); // activity signal moves
});

test('incremental painter skips idle frames, batches changes, never clears the screen or the last corner', () => {
  const p = new TerminalFrame();
  const first = p.paint(['top', 'bottom╯'], 7, 2);
  assert.match(first, /bottom╯/); assert.ok(first.endsWith('\x1b[?2026l'));
  assert.equal(p.paint(['top', 'bottom╯'], 7, 2), '');
  const changed = p.paint(['top', 'change╯'], 7, 2);
  assert.doesNotMatch(changed, /top/); assert.match(changed, /\x1b\[2;1Hchange╯/);
  assert.doesNotMatch(first + changed, /\x1b\[(?:2J|J|K)/);
  const shorter = p.paint(['top'], 7, 2);
  assert.match(shorter, /\x1b\[2;1H {7}/);
});

test('weekly reset uses native Unix seconds, counts down accurately and distinguishes absent/expired', () => {
  const now = 1791140000000;
  const reset = now / 1000 + 3 * 86400 + 18 * 3600;
  assert.equal(resetCountdown(reset, now), 'RESET IN 3d 18h');
  assert.equal(resetCountdown(now / 1000 + 65 * 60, now), 'RESET IN 1h 5m');
  assert.equal(resetCountdown(now / 1000 + 20, now), 'RESET IN 1m');
  assert.equal(resetCountdown(now / 1000, now), 'RESET FÄLLIG');
  assert.equal(resetCountdown(undefined, now), 'RESET —');
  assert.equal(resetCountdown(NaN, now), 'RESET —');
  assert.equal(nativeSnapshot({ ...native, rate_limits: { seven_day: { used_percentage: 70, resets_at: reset } } }).usageResetsAt, reset);
  for (const design of ['classic', 'orbital']) {
    assert.match(renderNeural({ ...NEURAL_DEMO, usageResetsAt: reset, now }, 140, 0, false, design).join('\n'), /RESET IN 3d 18h/);
  }
});

test('free context is exact native input tokens subtracted from reported total, not a rounded percent estimate', () => {
  const d = nativeSnapshot({ ...native, context_window: { used_percentage: 8, context_window_size: 1_000_000, total_input_tokens: 82821, total_output_tokens: 1234 } });
  assert.equal(d.contextFree, 917179); assert.equal(d.contextTotal, 1_000_000);
  assert.equal(nativeSnapshot({ session_id: 's' }).contextFree, null);
  assert.equal(nativeSnapshot({ session_id: 's', context_window: { context_window_size: 100, total_input_tokens: 200 } }).contextFree, 0);
  for (const design of ['classic', 'orbital']) {
    assert.match(renderNeural({ ...NEURAL_DEMO, contextFree: d.contextFree, contextTotal: d.contextTotal }, 150, 0, false, design).join('\n'), /917.179 FREI \/ 1.000.000/);
  }
});
