import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeAttempts, validateAttempt, judgeFixture, repairOnce, applyAssessments} from '../probes/convention-e2e/measurement.mjs';

const row=(id,first,repaired=null)=>({attempt_id:id,cluster_id:id,host:{name:'fixture',version:'0'},model:{requested:'fixture',confirmed:null},rule:{id:'invented',revision:'sha256:abc'},task:{kind:'arithmetic',generation:1},context_generation:'context-1',first,repaired});
const output=(status,text='fixture')=>({status,sha256:'a'.repeat(64),text});
test('#1090: blocked and unverified attempts stay in both fixed denominators; repairs do not rewrite first visibility',()=>{
 const rows=[row('ok',output('passed')),row('repaired',output('failed'),output('passed')),row('blocked',{status:'blocked',reason:'fixture failure'}),row('unknown',{status:'unverified',reason:'no final evidence'})];
 assert.deepEqual(summarizeAttempts(rows),{attempts:4,first_correct:1,eventual_correct:2,repaired_correct:1,first_failed:1,first_blocked:1,first_unverified:1,eventual_failed:0,eventual_blocked:1,eventual_unverified:1,initial_correct_fraction:0.25,eventual_correct_fraction:0.5});
 assert.equal(rows[1].first.status,'failed');
});
test('#1090: no successful judgement without actual output bytes and revision/task/host attribution',()=>{
 assert.throws(()=>validateAttempt(row('bad',{status:'passed'})),/output/);
 assert.throws(()=>validateAttempt({...row('bad',output('passed')),rule:{id:'invented',revision:null}}),/revision/);
 assert.throws(()=>validateAttempt({...row('bad',output('passed')),task:{kind:'arithmetic'}}),/generation/);
 assert.throws(()=>summarizeAttempts([row('dup',output('passed')),row('dup',output('passed'))]),/duplicate/);
});
test('#1090: fixture oracle measures actual final output, not an earlier receipt or model self-report',()=>{
 assert.equal(judgeFixture('arithmetic','{"answer":7,"label":"blue"}','blue').status,'passed');
 assert.equal(judgeFixture('arithmetic','{"answer":7,"label":"blue"}','orange').status,'failed');
 assert.equal(judgeFixture('arithmetic','I followed every rule.','blue').status,'failed');
 assert.equal(judgeFixture('translate-only','Anything plausible','blue').status,'unverified');
});

test('#1090: pre-registered cases missing after interruption remain unknown in the fixed denominator',()=>{
 const summary=summarizeAttempts([row('one',output('passed'))],['one','two','three']);
 assert.equal(summary.attempts,3);assert.equal(summary.first_unverified,2);assert.equal(summary.initial_correct_fraction,1/3);
 assert.throws(()=>summarizeAttempts([row('unexpected',output('passed'))],['one']),/unplanned/);
});

test('#1090: exactly one repair preserves first bytes and task generation; blocked and unverified are not repaired by guess',async()=>{
 const bad=row('repair',output('failed','first incorrect output'));let calls=0;
 await repairOnce(bad,async()=>{calls++;return output('passed','repaired output');});
 await repairOnce(bad,async()=>{calls++;return output('passed','unwanted second repair');});
 assert.equal(calls,1);assert.equal(bad.first.text,'first incorrect output');assert.equal(bad.first.status,'failed');assert.equal(bad.task.generation,1);
 assert.equal(bad.repaired.text,'repaired output');
 for(const status of ['blocked','unverified','passed']){
  const attempt=row(status,status==='passed'?output(status):{status,reason:'fixture'});
  await repairOnce(attempt,async()=>{throw Error('unexpected generation');});
  assert.equal(attempt.repaired,null);assert.ok(attempt.repair_not_attempted_reason);
 }
});

test('#1090: independent semantic assessments bind actual bytes, rule revision and generation',()=>{
 const actual=row('semantic',output('unverified','actual bytes'));
 const decision={attempt_id:'semantic',output_sha256:actual.first.sha256,rule_revision:actual.rule.revision,task_generation:1,status:'passed',reason:'All predeclared fixture requirements hold.'};
 const assessment={reviewer:'independent fixture reviewer',rubric_sha256:'rubric',decisions:[decision]};
 const applied=applyAssessments([actual],assessment,'rubric');
 assert.equal(applied[0].first.status,'passed');assert.equal(actual.first.status,'unverified');assert.equal(applied[0].first.text,actual.first.text);
 for(const field of ['output_sha256','rule_revision','task_generation'])assert.throws(()=>applyAssessments([actual],{...assessment,decisions:[{...decision,[field]:'stale'}]},'rubric'),/stale/);
 assert.throws(()=>applyAssessments([actual],assessment,'different-rubric'),/rubric/);
});
