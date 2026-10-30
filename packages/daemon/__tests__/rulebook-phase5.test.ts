import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runProbe} from './fixtures/rulebook-phase5/probe.js';

test('Phase 5: five-language production HTTP/lane replay, bounded autonomous recovery and explicit gaps', {timeout:120000}, async t=>{
  const result=await runProbe();
  for(const row of result.rows)await t.test(`${row.language}/${row.client}/${row.case}`,()=>assert.notEqual(row.status,'FAIL',row.detail));
  assert.equal(result.rules,125);
  assert.equal(result.rows.filter(r=>r.status==='GAP').length,20,'known semantic/omitted-task gaps must stay visible');
});
