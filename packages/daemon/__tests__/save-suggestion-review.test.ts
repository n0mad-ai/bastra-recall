import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { identifySaveSuggestions, reviewSaveSuggestion, visibleSaveSuggestions } from '../src/save-suggestion-review.js';
const suggestion = {heuristic:'architecture-decision' as const,title:'decision',type:'decision' as const,body:'generic hint'};
test('explicit dismissal is exact, project-bound, durable and reversible; silence changes nothing', async () => {
 const dir=await mkdtemp(join(tmpdir(),'save-review-'));const old=process.env.BASTRA_DB_PATH;process.env.BASTRA_DB_PATH=join(dir,'recall.db');
 const oldPath=process.env.BASTRA_SAVE_SUGGESTIONS_PATH;process.env.BASTRA_SAVE_SUGGESTIONS_PATH=join(dir,'suggestions.json');
 try {
 const a=await identifySaveSuggestions('alpha',[suggestion],'full proposal A');
 const b=await identifySaveSuggestions('alpha',[suggestion],'full proposal B');
 const other=await identifySaveSuggestions('beta',[suggestion],'full proposal A');
 assert.notEqual(a[0].proposal_id,b[0].proposal_id);
 assert.equal((await visibleSaveSuggestions('alpha',a)).length,1);
 await assert.rejects(()=>reviewSaveSuggestion('alpha',{id:a[0].proposal_id,decision:'reject'}));
 await assert.rejects(()=>reviewSaveSuggestion('alpha',{id:a[0].proposal_id,decision:'reject',write_origin:'user-directed',evidence:' '}));
 await assert.rejects(()=>reviewSaveSuggestion('beta',{id:a[0].proposal_id,decision:'reject',write_origin:'user-directed',evidence:'User says no to this proposal'}));
 await reviewSaveSuggestion('alpha',{id:a[0].proposal_id,decision:'reject',write_origin:'user-directed',evidence:'User says no to this proposal'});
 assert.equal((await visibleSaveSuggestions('alpha',await identifySaveSuggestions('alpha',[suggestion],'full proposal A'))).length,0);
 assert.equal((await visibleSaveSuggestions('alpha',b)).length,1);
 assert.equal((await visibleSaveSuggestions('beta',other)).length,1);
 await reviewSaveSuggestion('alpha',{id:a[0].proposal_id,decision:'reset',write_origin:'user-directed'});
 assert.equal((await visibleSaveSuggestions('alpha',a)).length,1);
 } finally {if(old===undefined)delete process.env.BASTRA_DB_PATH;else process.env.BASTRA_DB_PATH=old;if(oldPath===undefined)delete process.env.BASTRA_SAVE_SUGGESTIONS_PATH;else process.env.BASTRA_SAVE_SUGGESTIONS_PATH=oldPath;await rm(dir,{recursive:true,force:true});}
});

import { evaluateHeuristics } from '../src/stop-heuristics.js';
import { runStopLane } from '../src/stop-lane.js';
import { filterPendingSaveSuggestions } from '../src/save-suggestion-review.js';
import { projectForFilter } from '../src/scope-filter.js';
import { takePendingRelay } from '../src/pending-suggestions.js';
import { cmdSaveSuggestions } from '../src/cli/save-suggestions-cmd.js';
import { parseArgs } from '../src/cli/commands.js';
import { dispatchApi } from '../src/http-api-routes.js';

async function isolated(work:()=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'save-review-integration-'));
 const env={BASTRA_DB_PATH:join(dir,'recall.db'),BASTRA_SAVE_SUGGESTIONS_PATH:join(dir,'suggestions.json'),BASTRA_PENDING_SUGGESTIONS_PATH:join(dir,'pending.json'),BASTRA_HOOK_STATE_DIR:join(dir,'sessions'),BASTRA_LOG_PATH:join(dir,'logs')};
 const before=new Map(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 try{await work();}finally{for(const[k,v]of before)if(v===undefined)delete process.env[k];else process.env[k]=v;await rm(dir,{recursive:true,force:true});}
}
const choice=(question='Which storage?\n1. SQLite\n2. JSON')=>[{role:'assistant',content:question},{role:'user',content:'2'},{role:'assistant',content:'done'}];
test('source identities survive neutral tool additions and distinguish full question contents',()=>{
 const a=evaluateHeuristics(choice())[0];
 assert.equal(a.proposal_evidence,evaluateHeuristics([...choice(),{role:'tool',content:'neutral'}])[0].proposal_evidence);
 const prefix='Which option '+ 'x'.repeat(200);
 assert.notEqual(evaluateHeuristics(choice(prefix+'?\n1. A\n2. B'))[0].proposal_evidence,evaluateHeuristics(choice(prefix+'?\n1. C\n2. D'))[0].proposal_evidence);
 const native=(options:string[],id='call-a')=>[{role:'assistant',content:'',calls:[{id,name:'AskUserQuestion',input:{question:'Same question',options}}]},{role:'tool',content:'',results:[{id,content:'"Same question"="yes"'}]}];
 assert.equal(evaluateHeuristics(native(['A','B']))[0].proposal_evidence,evaluateHeuristics(native(['A','B'],'call-b'))[0].proposal_evidence);
 assert.notEqual(evaluateHeuristics(native(['A','B']))[0].proposal_evidence,evaluateHeuristics(native(['C','D']))[0].proposal_evidence);
});
test('same-turn and pending re-enqueue honor exact explicit rejection and project-bound reset',()=>isolated(async()=>{
 const cwd=process.cwd(),project=projectForFilter(cwd);assert.ok(project);
 const payload={hook_event_name:'Stop',cwd,transcript:choice()};
 const first=await runStopLane({...payload,session_id:'real-review-a'},'http://127.0.0.1:1');
 const id=/proposal_id:([a-f0-9]{64})/.exec(first)?.[1];assert.ok(id);
 const ctx={toolDeps:{} as any,documentWriteEnabled:false,project};
 const decision={id,decision:'reject',write_origin:'user-directed',evidence:'Please do not suggest saving this decision again'};
 const response=await dispatchApi('review_save_suggestion',decision,ctx);assert.equal((response as any).state,'suppressed');
 assert.equal(await runStopLane({...payload,session_id:'real-review-b'},'http://127.0.0.1:1'),'{}');
 assert.equal(await runStopLane({...payload,session_id:'real-review-c',bastra_client:'codex'},'http://127.0.0.1:1'),'{}');
 await reviewSaveSuggestion(project,{id,decision:'reset',write_origin:'user-directed'});
 await runStopLane({...payload,session_id:'real-review-d',bastra_client:'codex'},'http://127.0.0.1:1');
 const relay=await takePendingRelay();assert.equal(relay.recency.length,1);
 await reviewSaveSuggestion(project,decision);
 assert.equal((await filterPendingSaveSuggestions(project,relay.recency[0].blocks)).trim(),'');
 assert.equal(await filterPendingSaveSuggestions('another-project',relay.recency[0].blocks),relay.recency[0].blocks);
 await assert.rejects(()=>reviewSaveSuggestion('another-project',decision));
}));
test('CLI requires explicit origin/evidence and supports reviewable dry runs',async t=>{
 let out='';t.mock.method(process.stdout,'write',(v:unknown)=>{out+=String(v);return true;});t.mock.method(process.stderr,'write',()=>true);
 const id='a'.repeat(64);
 assert.equal(await cmdSaveSuggestions(parseArgs(['suggestions','reject',id,'user-directed'])),1);
 assert.equal(await cmdSaveSuggestions(parseArgs(['suggestions','reject',id,'user-directed','No, do not save it','--dry-run'])),0);
 assert.equal(JSON.parse(out).tool,'review_save_suggestion');
});

test('real CLI accepts suggestions dry-run before dispatch',()=>isolated(async()=>{
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',resolve('packages/daemon/src/cli.ts'),'suggestions','reject','a'.repeat(64),'user-directed','No, do not save this proposal','--dry-run'],{env:{...process.env,BASTRA_TELEMETRY:'off'},timeout:10000});
 assert.equal(JSON.parse(stdout).dry_run,true);
}));
