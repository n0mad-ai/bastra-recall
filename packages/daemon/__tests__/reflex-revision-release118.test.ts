/** Real HTTP reflex -> prompt -> gate, using byte revisions already in the index. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Vault, saveMemory } from '@bastra-recall/core';
import { serve } from './fixtures/rulebook-phase5/probe.js';
import { runPromptLane } from '../src/prompt-lane.js';
import { runGateLane } from '../src/gate-lane.js';
import { loadSessionState } from '../src/session-state.js';

test('real reflex source revision suppresses a loaded same-revision gate, but changed bytes gate without source-file reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reflex-revision-'));
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({BASTRA_HOOK_STATE_DIR: join(root, 'state'), BASTRA_REFLEX: 'on', BASTRA_PROMPT_HOOK_MODE: 'all'})) {
    prior.set(key, process.env[key]); process.env[key] = value;
  }
  const vault = new Vault(join(root, 'vault')); await vault.init();
  const memory = await saveMemory(vault.root, {id: 'reflex-revision-rule', title: 'Invented reflex rule', summary: 'Invented reflex rule for the revision replay.', body: 'Original rule body.', type: 'workflow', scope: 'all-projects', topic_path: ['fixture'], tags: ['fixture'], recall_when: ['release118-reflex'], recall_mode: 'reflex', rulebook: 'on-demand', applies_when: 'Invented fixture output', write_origin: 'user-directed'});
  await vault.reindexFile(memory.file_path);
  const live = await serve(vault);
  const ids = ['reflex-same', 'reflex-changed'];
  const payload = (sid: string) => ({session_id: sid, bastra_client: 'claude-code', cwd: root});
  try {
    const firstRevision = vault.get('reflex-revision-rule')!.revision;
    assert.equal(typeof firstRevision, 'string');
    for (const sid of ids) await live.post('/api/v1/load_memory', {id: 'reflex-revision-rule', session_id: sid}, sid);
    for (const [i, sid] of ids.entries()) {
      if (i) {
        await writeFile(memory.file_path, (await readFile(memory.file_path, 'utf8')).replace('Original rule body.', 'Updated rule body.'));
        await vault.reindexFile(memory.file_path);
        assert.notEqual(vault.get('reflex-revision-rule')!.revision, firstRevision);
      }
      const original = fs.readFile; let sourceReads = 0;
      t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === memory.file_path) { sourceReads++; throw new Error('Hook must use the indexed source'); }
        return original(...args);
      }); syncBuiltinESMExports();
      try {
        const wire = await live.post('/hook/reflex', {context: 'release118-reflex', ...payload(sid)});
        assert.equal(wire.hits[0]?.revision, vault.get('reflex-revision-rule')!.revision, 'revision is carried by the real reflex endpoint');
        const out = await runPromptLane({...payload(sid), hook_event_name: 'UserPromptSubmit', prompt: 'release118-reflex'}, null, live.url, undefined, () => []);
        assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /trigger="reflex"/);
        const pending = (await loadSessionState(sid)).pendingMustLoad?.map(e => e.id) ?? [];
        assert.deepEqual(pending, i ? ['reflex-revision-rule'] : []);
        const gate = JSON.parse(await runGateLane({...payload(sid), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'echo checked'}}, {reflexPool: () => []}));
        assert.equal(gate.hookSpecificOutput?.permissionDecision === 'deny', Boolean(i));
        assert.equal(sourceReads, 0);
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    }
  } finally {
    await live.close(); await vault.stop();
    for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, {recursive: true, force: true});
  }
});
