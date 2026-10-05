import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { renderNeural, NEURAL_DEMO, toggleHit } from '../../packages/statusline/src/panel/neural.ts';
import { visibleLength } from '../../packages/statusline/src/utils/terminal.ts';
import { withCodexPanelHook, installCodexPanelHook } from '../../packages/statusline/src/panel/install-codex-hook.ts';
import { ensureTarget } from '../../packages/statusline/src/panel/ensure-target.ts';
import { CodexProjection } from '../../packages/statusline/src/codex/state.ts';
import { ClaudeCalls } from '../../packages/statusline/src/panel/claude-data.ts';

const data = { ...NEURAL_DEMO, mode: 'live', client: 'codex', fresh: true, contextFree: 800000, contextTotal: 1e6,
  usage5h: 12, usage5hResetsAt: 1791150000, usageResetsAt: 1791400000, now: 1791140000000, apiDurationMs: 60000,
  loadedTitles: ['Erste Erinnerung', 'Zweite Erinnerung'], agentActive: false, active: false, recent: false };

test('found candidates include successful document searches in both clients, once and only in the current turn', () => {
  const codex = new CodexProjection(), claude = new ClaudeCalls('s');
  const event = payload => ({ type: 'event_msg', payload });
  codex.accept(event({ type: 'task_started', turn_id: 't' }));
  for (const [id, tool, hits, failed] of [['a', 'recall', 2, false], ['b', 'find_document', 3, false], ['c', 'find_document', 9, true]]) {
    const content = JSON.stringify({ hits: Array.from({ length: hits }, () => ({})) });
    const result = event({ type: 'item_completed', turn_id: 't', item: { type: 'McpToolCall', server: 'bastra-recall', tool, id, result: { content: [{ type: 'text', text: content }], isError: failed } } });
    codex.accept(result); codex.accept(result);
    claude.accept({ type: 'assistant', sessionId: 's', message: { content: [{ type: 'tool_use', id, name: `mcp__bastra-recall__${tool}` }] } });
    const row = { type: 'user', sessionId: 's', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: failed }] } };
    claude.accept(row); claude.accept(row);
  }
  for (const counts of [codex.state, claude]) { assert.equal(counts.searches, 2); assert.equal(counts.hits, 5); assert.equal(counts.errors, 1); }
  codex.accept(event({ type: 'task_started', turn_id: 'new' }));
  claude.accept({ type: 'user', sessionId: 's', promptId: 'new', timestamp: '2026-10-05T12:00:00Z', message: { content: 'Next' } });
  assert.equal(codex.state.hits, 0); assert.equal(claude.hits, 0);
});

test('every design carries limits, API and loaded titles, with compact/light controls and exact columns', () => {
  for (const design of ['classic', 'orbital', 'ember']) {
    const full = renderNeural(data, 160, 0, false, design, { compact: false });
    const text = full.join('\n');
    assert.match(text, /5 Std.*12 %/); assert.match(text, /API.*(?:60 s|1m)/);
    assert.match(text, /Erste Erinnerung/); assert.match(text, /Zweite Erinnerung/);
    assert.match(text, /◐ {3}▾/);
    const small = renderNeural(data, 160, 0, false, design, { compact: true });
    assert.equal(small.length, 6); assert.match(small[0], /◐ {3}▴/); assert.match(small.join('\n'), /7 Tage/);
    const light = renderNeural(data, 160, 0, true, design, { compact: false, light: true, paper: [30, 30, 30] });
    assert.match(light[0], /48;2;247;242;233m/);
    const dark = renderNeural(data, 160, 0, true, design, { compact: false, paper: [30, 30, 30] });
    assert.match(dark[0], /48;2;30;30;30m/);
    for (const width of [1, 20, 55, 56, 89, 90, 145, 240]) {
      for (const compact of [false, true]) for (const light of [false, true]) {
        const rows = renderNeural({ ...data, loadedTitles: ['記憶'.repeat(100) + '\x1b]52;secret\x07'] }, width, 3, true, design, { compact, light });
        for (const line of rows) assert.equal(visibleLength(line), width, `${design}/${width}/${compact}/${light}`);
      }
    }
    assert.deepEqual(renderNeural(data, 160, 1, true, design), renderNeural(data, 160, 20, true, design));
  }
  assert.equal(toggleHit(160, 156, 1), 'view'); assert.equal(toggleHit(160, 152, 0), 'skin');
});

test('the new hook preserves existing hooks and does not manufacture trust; repeated install is idempotent', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'panel-hook-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const original = { description: 'ours', hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'existing' }] }], Stop: [{ hooks: [{ command: 'stop' }] }] } };
  const args = ['node', '/path with spaces/panel.mjs', '--ensure', '--client', 'codex'];
  const updated = withCodexPanelHook(original, args);
  assert.deepEqual(updated.hooks.SessionStart[0], original.hooks.SessionStart[0]); assert.deepEqual(updated.hooks.Stop, original.hooks.Stop);
  assert.match(updated.hooks.SessionStart[1].hooks[0].command, /'\/path with spaces\/panel.mjs'/);
  assert.doesNotMatch(JSON.stringify(updated), /trusted_hash|bypass/);
  assert.deepEqual(withCodexPanelHook(updated, args), updated);
  await writeFile(path.join(dir, 'hooks.json'), JSON.stringify(original));
  assert.equal(await installCodexPanelHook(dir, args), true); assert.equal(await installCodexPanelHook(dir, args), false);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'hooks.json'))).hooks.SessionStart.length, 2);
});

test('ensure can resolve a shared-daemon hook without surface env, but never chooses a different session', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'panel-target-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, '.cmuxterm'));
  await writeFile(path.join(dir, '.cmuxterm/codex-hook-sessions.json'), JSON.stringify({ sessions: { s: { sessionId: 's', surfaceId: 'surface', workspaceId: 'workspace' } } }));
  assert.deepEqual(await ensureTarget({}, { session_id: 's' }, dir, 'codex'), { surface: 'surface', workspace: 'workspace' });
  assert.equal(await ensureTarget({}, { session_id: 'other' }, dir, 'codex'), null);
  assert.deepEqual(await ensureTarget({ CMUX_SURFACE_ID: 'env-s', CMUX_WORKSPACE_ID: 'env-w' }, null, dir, 'claude'), { surface: 'env-s', workspace: 'env-w' });
});

test('Codex titles come only from successful tool results, are bounded/deduplicated and reset per turn', () => {
  const p = new CodexProjection();
  const event = payload => ({ type: 'event_msg', payload });
  p.accept(event({ type: 'task_started', turn_id: 't' }));
  const call = (id, result) => event({ type: 'item_completed', turn_id: 't', item: { type: 'McpToolCall', server: 'bastra-recall', tool: 'load_memory', id, arguments: { title: 'Do not read me' }, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  p.accept(call('a', { frontmatter: { title: 'Echte Erinnerung' } })); p.accept(call('a', { title: 'Duplicate' }));
  p.accept(call('b', { id: 'fallback-id' })); p.accept(call('c', { error: 'missing', title: 'Not loaded' }));
  assert.deepEqual(p.state.loadedTitles, ['Echte Erinnerung', 'fallback-id']); assert.equal(p.state.loads, 2);
  p.accept(event({ type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 70 } } }));
  assert.equal(p.state.inputTokens, 100); assert.equal(p.state.cachedInputTokens, 70);
  p.accept(event({ type: 'task_started', turn_id: 'new' })); assert.deepEqual(p.state.loadedTitles, []);
});
