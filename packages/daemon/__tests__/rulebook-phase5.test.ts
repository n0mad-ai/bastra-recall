import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runProbe} from './fixtures/rulebook-phase5/probe.js';

test('Phase 5: five-language production HTTP/lane replay, bounded autonomous recovery and explicit correspondence decisions', {timeout:120000}, async t=>{
  const result=await runProbe();
  for(const row of result.rows)await t.test(`${row.language}/${row.client}/${row.case}`,()=>assert.notEqual(row.status,'FAIL',row.detail));
  assert.equal(result.rules,125);
  assert.equal(result.costs.honestRounds,50);assert.equal(result.costs.checks,50);assert.equal(result.costs.stopBlocks,0);assert.equal(result.costs.repairs,0);assert.equal(result.costs.ignoredHarmlessBlocks,40);
  t.diagnostic(JSON.stringify({correspondence_costs:result.costs}));
  assert.equal(result.rows.filter(r=>r.status==='GAP').length,0,'structural declaration and omitted-task cases must pass; semantic truth is not certified');
});
