import './tasks-opt-in.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintTaskCredential } from '../src/task-auth.js';
import { callTaskCrud, type TaskCrudOperation } from '../src/task-service.js';
import { readTaskStore, transactTaskStore } from '../src/task-store.js';
import { reconcileTaskTime } from '../src/task-events.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'task-agent-manage-'));
  const ctx = { path: join(root, 'tasks.json'), authPath: join(root, 'auth.json'), now: () => 1000 };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: 'agent', domains: ['personal'], role: 'agent' });
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: 'owner', domains: ['personal'], role: 'owner' });
  const call = (operation: TaskCrudOperation, input: unknown) => callTaskCrud(ctx, `Bearer ${agent.token}`, operation, input) as Promise<any>;
  const input = { idempotency_key: 'fixture', original_request: 'Evaluate', goal: 'Evaluate', resolution_condition: 'Evaluation complete', schedule: { kind: 'instant', at: 2000 }, timezone: 'Europe/Berlin', scope: { kind: 'project', name: 'my-project' }, origin: { kind: 'user-request', client: 'test', session: 'test', context: 'Please evaluate' } };
  return { ctx, call, input, owner };
}
test('commissioned prepare and execute tasks arm in the enrolled area without execution authority', async () => {
  const f = await fixture();
  for (const action_level of ['prepare', 'execute']) {
    const task = await f.call('task_create', { ...f.input, idempotency_key: action_level, action_level, owner_domains: ['unregistered-project'] });
    assert.equal(task.armed, true);
    assert.deepEqual(task.owner_domains, ['personal']);
    assert.equal(task.scope.name, 'my-project');
  }
  assert.equal((await readTaskStore(f.ctx.path)).controls.execution_stopped, true);
});
test('agent edits an armed owner task, changes level, snoozes beyond 24 hours and resolves it', async () => {
  const f = await fixture();
  let task: any = await callTaskCrud(f.ctx, `Bearer ${f.owner.token}`, 'task_create', { ...f.input, owner_domains: ['personal'], arm: true, action_level: 'prepare' });
  task = await f.call('task_edit', { id: task.id, expected_revision: task.expected_revision, patch: { action_level: 'execute', schedule: { kind: 'instant', at: 3000 } } });
  assert.equal(task.armed, true);
  assert.equal(task.generation, 1);
  task = await f.call('task_snooze', { id: task.id, expected_revision: task.expected_revision, until: 1000 + 7 * 86400000 });
  assert.equal(task.state, 'snoozed');
  task = await f.call('task_resolve', { id: task.id, expected_revision: task.expected_revision });
  assert.equal(task.state, 'resolved');
});
test('agent delete removes the selected task and its occurrences and rejects stale revisions', async () => {
  const f = await fixture();
  const task = await f.call('task_create', f.input);
  f.ctx.now = () => 3000;
  await reconcileTaskTime(f.ctx);
  let current = await f.call('task_get', { id: task.id });
  await assert.rejects(f.call('task_delete', { id: task.id, expected_revision: 'initial:999' }), { code: 'conflict' });
  const result = await f.call('task_delete', { id: task.id, expected_revision: current.expected_revision });
  assert.equal(result.deleted, true);
  const store = await readTaskStore(f.ctx.path);
  assert.equal(store.tasks.length, 0);
  assert.equal(store.occurrences.length, 0);
  await assert.rejects(f.call('task_get', { id: task.id }), { code: 'not_found' });
});
test('delete guard cannot prune unrelated state or spent approval identities', async () => {
  const f = await fixture();
  await f.call('task_create', f.input);
  await transactTaskStore(f.ctx.path, undefined, s => { s.consumed_approval_ids.push('spent'); });
  await assert.rejects(transactTaskStore(f.ctx.path, undefined, s => { s.tasks = []; s.consumed_approval_ids = []; }, 'delete'), { code: 'conflict' });
  assert.equal((await readTaskStore(f.ctx.path)).tasks.length, 1);
});
