import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {checkStopRepair} from '../src/stop-repair.js';
import {beginRulebookRound,recordRulebookCheck} from '../src/rulebook-check.js';
import {mutateSessionState} from '../src/session-state.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';

const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[{id:'copy-rule',title:'Copy',group:'explicit',rulebook:'on-demand',applies_when:'Copy',body:'Copy',revision:'r1',updated:null,stale_status:'unknown',validator}],omitted:0};
const turns=[{role:'assistant',content:'```\n'+'x'.repeat(2500)+'\n```'}];
async function sandbox(fn:()=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'repair-unmarked-actor-'));
 const values={BASTRA_HOOK_STATE_DIR:dir,BASTRA_TELEMETRY:'0',BASTRA_STOP_SAME_TURN:'1'};
 const old=new Map(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 try{await fn();}finally{for(const[k,v]of old){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(dir,{recursive:true,force:true});}
}

test('unmarked Stop sees the main MCP dismissal of an inherited task rule',async()=>sandbox(async()=>{
 const sid='unmarked-dismissal';
 await mutateSessionState(sid,s=>{s.activeTask={id:'draft@1',kind:'draft-for-review',since:1,generation:0};s.activeConventions=[{id:'copy-rule',revision:'r1',setAt:1,validator}];});
 await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},catalog);
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[{id:'copy-rule',reason:'This round is an internal coding report.'}]},catalog)).ok,true);
 assert.equal(await checkStopRepair({session_id:sid,hook_event_name:'Stop'},turns),null);
}));

test('unmarked Stop retains main rules explicitly applied through MCP',async()=>sandbox(async()=>{
 const sid='unmarked-applied';
 await recordRulebookCheck(sid,{applicable:['copy-rule']},catalog);
 assert.equal((await checkStopRepair({session_id:sid,hook_event_name:'Stop'},turns))?.action,'request');
}));

for(const agentId of ['worker','main'])test('unmarked explicit agent '+agentId+' neither inherits main rules nor main dismissals',async()=>sandbox(async()=>{
 const sid='unmarked-worker-'+agentId;
 await recordRulebookCheck(sid,{applicable:['copy-rule']},catalog);
 const payload={session_id:sid,hook_event_name:'Stop',agent_id:agentId};
 assert.equal(await checkStopRepair(payload,turns),null);
 await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},catalog);
 await recordRulebookCheck(sid,{applicable:[],not_applicable:[{id:'copy-rule',reason:'Main is producing a coding report.'}]},catalog);
 await recordRulebookCheck(sid,{applicable:['copy-rule'],agent_id:agentId},catalog);
 assert.equal((await checkStopRepair(payload,turns))?.action,'request');
}));
