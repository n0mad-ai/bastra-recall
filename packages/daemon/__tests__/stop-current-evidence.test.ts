import {test} from 'node:test';
import {readAppRecord} from '../src/app-record-store.js';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runStopLane} from '../src/stop-lane.js';
import {beginRulebookRound,recordRulebookCheck,recordRulebookLoad,resetRulebookContext,requireActionRules} from '../src/rulebook-check.js';
import {runGateLane} from '../src/gate-lane.js';
import {evaluateHeuristics} from '../src/stop-heuristics.js';
import {normalizeTurns} from '../src/stop-transcript.js';
import {checkStopRepair} from '../src/stop-repair.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';

const validator={tool:'validate_artifact',channel:'fixture-copy',limit:2000,unit:'utf16'} as const;
const entry={id:'copy-rule',title:'Invented',group:'explicit' as const,revision:'r1',updated:null,stale_status:'unknown' as const,body:'Invented',rulebook:'on-demand' as const,applies_when:'Invented',validator};
const catalog:KernelCandidates={entries:[entry,{...entry,id:'correspondence-rule',validator:undefined,rule_categories:['correspondence']}],omitted:0};
const user=(text:string)=>({type:'user',message:{role:'user',content:text}});
const assistant=(text:string)=>({type:'assistant',message:{role:'assistant',content:text}});
const call=(name:string,input:Record<string,unknown>={})=>({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'tool-1',name,input}]}});
const result=(content:string,is_error=false)=>({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content,is_error}]}});
const codex=(payload:unknown)=>({type:'response_item',payload});
async function sandbox(fn:(sid:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'stop-evidence-1390-'));
 const values={BASTRA_HOOK_STATE_DIR:dir,BASTRA_TELEMETRY:'0',BASTRA_PENDING_SUGGESTIONS_PATH:join(dir,'pending.json')};
 const before=new Map(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 try{await fn('fixture');}finally{for(const[k,v]of before){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(dir,{recursive:true,force:true});}
}
const stop=async(sid:string,transcript:unknown[],agent_id?:string)=>JSON.parse(await runStopLane({session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop',transcript,...(agent_id?{agent_id}:{})},'http://127.0.0.1:1',{kernel:async()=>catalog}));
const correspondence=(out:unknown)=>JSON.stringify(out).includes('Correspondence declarations missing');
async function checked(sid:string,agent_id?:string){await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},catalog);await recordRulebookCheck(sid,{applicable:[],...(agent_id?{agent_id}:{})},catalog);}

test('#1390 ordinary status and coding rounds do not demand correspondence declarations',async()=>sandbox(async sid=>{
 await checked(sid);
 assert.equal(correspondence(await stop(sid,[user('Status'),call('Bash'),assistant('Updated the local pane.')])),false);
 assert.equal(correspondence(await stop(sid,[user('Code'),assistant('```ts\nconst n = 1;\n```')])),false,'an unapplied global validator cannot turn code into a message');
}));
test('#1390 real reported task, applied copy and external draft tools retain correspondence demand',async()=>sandbox(async sid=>{
 await checked(sid);await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 assert.equal(correspondence(await stop(sid,[user('Fixture'),assistant('A short draft')])),true);
 await checked('copy');await recordRulebookLoad('copy','copy-rule',null,{revision:'r1',validator});
 assert.equal(correspondence(await stop('copy',[user('Fixture'),assistant('```\nA short copy\n```')])),true);
 await checked('draft');assert.equal(correspondence(await stop('draft',[user('Fixture'),call('mcp__gmail__create_draft')])),true);
}));
test('#1390 old copy/tool evidence, notifications and internal agent messages do not create correspondence work',async()=>sandbox(async sid=>{
 await checked(sid);await recordRulebookLoad(sid,'copy-rule',null,{revision:'r1',validator});
 assert.equal(correspondence(await stop(sid,[user('Old'),call('mcp__gmail__create_draft'),assistant('```\nOld copy\n```'),user('New status'),call('mcp__collaboration__send_message'),assistant('Done')])),false);
}));
test('#1390 workers use their own evidence and do not inherit the main task',async()=>sandbox(async sid=>{
 await checked(sid,'worker');await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 assert.equal(correspondence(await stop(sid,[user('Status'),assistant('Done')],'worker')),false);
 assert.equal(correspondence(await stop(sid,[user('Fixture'),call('mcp__gmail__create_draft')],'worker')),true);
}));
test('#1390 productive save evaluation ignores words alone and old-round decisions',()=>{
 assert.deepEqual(evaluateHeuristics([{role:'user',content:'decided: we go with the queue'}]),[]);
 assert.deepEqual(evaluateHeuristics([{role:'assistant',content:'Which?\n1. A\n2. B'},{role:'user',content:'2'},{role:'assistant',content:'Chosen'},{role:'user',content:'Current status'}]),[]);
 assert.ok(evaluateHeuristics([{role:'assistant',content:'Which?\n1. A\n2. B'},{role:'user',content:'2'}]).some(s=>s.heuristic==='architecture-decision'));
});
test('#1390 a mention, unreachable or failed commit is not feature-completion evidence',()=>{
 const files='src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts';
 for(const turns of [
  [{role:'user',content:'git commit '+files}],
  [{role:'assistant',content:files,commands:["echo 'git commit -m example'"]}],
  [{role:'assistant',content:files,commands:['false && git commit -m never']}],
  [{role:'assistant',content:files,commands:['git commit -m failed']},{role:'tool',content:'failed',failed:true}],
  [{role:'assistant',content:files,commands:['git commit -m old']},{role:'tool',content:'[main abc1234] old'},{role:'user',content:'Current status'}],
 ])assert.equal(evaluateHeuristics(turns,{fileExists:()=>true}).some(s=>s.heuristic==='feature-completion'),false);
 assert.ok(evaluateHeuristics([{role:'user',content:'Work'},{role:'assistant',content:files,commands:['git commit -m done']},{role:'tool',content:'[main abc1234] done',failed:false}],{fileExists:()=>true}).some(s=>s.heuristic==='feature-completion'));
});
test('#1390 native Claude and direct Codex commit results prove current completion',()=>{
 const files='src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts';
 const cases=[
  [user('Work'),assistant(files),call('Bash',{command:'git commit -m done'}),result('[main abc1234] done')],
  [user('Work'),assistant(files),call('Bash',{command:'git commit -n -m done'}),result('[main abc1234] done')],
  [codex({type:'message',role:'user',content:'Work'}),codex({type:'message',role:'assistant',content:files}),codex({type:'function_call',call_id:'call-1',name:'exec_command',arguments:JSON.stringify({cmd:'git commit -m done'})}),codex({type:'function_call_output',call_id:'call-1',output:JSON.stringify({output:'[main abc1234] done',exit_code:0})})],
 ];
 for(const rows of cases)assert.ok(evaluateHeuristics(normalizeTurns(rows),{fileExists:()=>true}).some(s=>s.heuristic==='feature-completion'));
 const mixed=[user('Work'),assistant(files),{type:'assistant',message:{role:'assistant',content:[
  {type:'tool_use',id:'failed-commit',name:'Bash',input:{command:'git commit -m failed'}},
  {type:'tool_use',id:'echo',name:'Bash',input:{command:"echo '[main abc1234] fake'"}},
 ]}},{type:'user',message:{role:'user',content:[
  {type:'tool_result',tool_use_id:'failed-commit',is_error:true,content:'Commit failed'},
  {type:'tool_result',tool_use_id:'echo',is_error:false,content:'[main abc1234] fake'},
 ]}}];
 assert.equal(evaluateHeuristics(normalizeTurns(mixed),{fileExists:()=>true}).some(s=>s.heuristic==='feature-completion'),false,'each successful result must belong to the actual commit call');
 for(const source of ['// tools.exec_command({cmd:"git commit -m never"})','const text = "tools.exec_command({cmd: \'git commit -m never\'})";','if (false) await tools.exec_command({cmd:"git commit -m never"});']){
  const turns=normalizeTurns([user('Work'),assistant(files),codex({type:'custom_tool_call',call_id:'opaque',name:'exec',input:source}),codex({type:'custom_tool_call_output',call_id:'opaque',output:'[main abc1234] fabricated'})]);
  assert.equal(evaluateHeuristics(turns,{fileExists:()=>true}).some(s=>s.heuristic==='feature-completion'),false,'nested JS source is not a native execution record');
 }
});
test('#1390 a successful compound call cannot prove its conditional commit executed',()=>{
 const rows=[user('Work'),assistant('src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts'),
  call('Bash',{command:"false && git commit -m never; echo '[main abc1234] fake'"}),result('[main abc1234] fake')];
 assert.equal(evaluateHeuristics(normalizeTurns(rows),{fileExists:()=>true}).some(s=>s.heuristic==='feature-completion'),false);
});
test('#1390 native direct Codex draft and structured GitHub body writes are evidence, labels and JS mentions are not',async()=>sandbox(async sid=>{
 await checked(sid);
 assert.equal(correspondence(await stop(sid,[user('Fixture'),codex({type:'function_call',call_id:'draft',name:'mcp__gmail__create_draft',arguments:'{}'})])),true);
 await checked('labels');assert.equal(correspondence(await stop('labels',[user('Labels'),call('mcp__codex_apps__github_update_issue',{labels:['bug']})])),false);
 await checked('body');assert.equal(correspondence(await stop('body',[user('Body'),call('mcp__codex_apps__github_update_issue',{body:'A real issue update'})])),true);
 await checked('opaque');assert.equal(correspondence(await stop('opaque',[user('Status'),codex({type:'custom_tool_call',name:'exec',input:'const text="tools.mcp__gmail__create_draft({})";'})])),false);
}));
test('#1390 actual catch-all native subtool evidence is actor/round/context bound even with an opaque transcript',async()=>sandbox(async sid=>{
 const pre=async(id:string,agent_id?:string)=>runGateLane({session_id:id,agent_id,bastra_client:'codex',bastra_codex_version:'0.162.1',hook_event_name:'PreToolUse',tool_name:'mcp__codex_apps__gmail_create_draft',tool_input:{body:'A real draft'}},{kernel:async()=>catalog,reflexPool:()=>[]});
 const opaque=[user('Fixture'),codex({type:'custom_tool_call',name:'exec',input:'await tools.mcp__codex_apps__gmail_create_draft({body:"A real draft"});'})];
 await checked(sid);await pre(sid);
 assert.equal(correspondence(await stop(sid,opaque)),true,'native hook evidence covers actual nested calls, not JS source');
 await requireActionRules({session_id:sid,bastra_client:'claude-code'},[{id:'copy-rule',revision:'r1'}]);
 await checked(sid);assert.equal(correspondence(await stop(sid,[user('New round'),assistant('Done')])),false,'preserved pending actor fields must not preserve old correspondence evidence');
 await pre(sid);await resetRulebookContext(sid);await recordRulebookCheck(sid,{applicable:[]},catalog);
 assert.equal(correspondence(await stop(sid,[user('After reset'),assistant('Done')])),false);
 await checked('worker','worker');await pre('worker','worker');
 assert.equal(correspondence(await stop('worker',opaque,'worker')),true);
 await recordRulebookCheck('worker',{applicable:[]},catalog);
 assert.equal(correspondence(await stop('worker',[user('Main status'),assistant('Done')])),false,'worker operation cannot authorize main evidence');
}));
test('#1390 compact/meta rows do not hide current work and unknown client retains the main repair actor',async()=>sandbox(async sid=>{
 await checked(sid);await recordRulebookLoad(sid,'copy-rule',null,{revision:'r1',validator});
 const rows=[user('Fixture'),assistant('```\nA short copy\n```'),{...user('Summary'),isCompactSummary:true}];
 assert.equal(correspondence(await stop(sid,rows)),true);
 await recordRulebookCheck(sid,{applicable:['copy-rule'],not_applicable:[{id:'correspondence-rule',reason:'An independent fixture rule does not apply.'}]},catalog);
 assert.equal((await checkStopRepair({session_id:sid,hook_event_name:'Stop'},[{role:'user',content:'Fixture'},{role:'assistant',content:'```\n'+'x'.repeat(2200)+'\n```'}]))?.action,'request');
}));
test('#1390 drift requests only clusters containing a successfully written current memory',async()=>sandbox(async sid=>{
 const server=createServer((req,res)=>{req.resume();res.end(JSON.stringify({clusters:[{key:'old',kind:'tag',count:5,examples:['old-id']},{key:'current',kind:'tag',count:5,examples:['written-id']}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const run=(transcript:unknown[])=>runStopLane({session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop',transcript},base);
  assert.equal(await run([user('Status'),assistant('Done')]),'{}');
  assert.throws(()=>readAppRecord('pending-suggestions',process.env.BASTRA_PENDING_SUGGESTIONS_PATH!),{code:'ENOENT'});
  await run([user('Work'),call('mcp__bastra_recall__save_memory'),result(JSON.stringify({id:'written-id'})),assistant('Saved')]);
  const pending=readAppRecord('pending-suggestions',process.env.BASTRA_PENDING_SUGGESTIONS_PATH!);
  assert.match(pending,/written-id/);assert.doesNotMatch(pending,/old-id/);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));
test('#1390 native question answers require their successful matching result',()=>{
 const question={type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'ask',name:'AskUserQuestion',input:{}},{type:'tool_use',id:'read',name:'Read',input:{}}]}};
 const positive=[user('Fixture'),question,{type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'ask',is_error:false,content:'"Queue or polling?"="Queue"'}]}}];
 assert.ok(evaluateHeuristics(normalizeTurns(positive)).some(s=>s.heuristic==='architecture-decision'));
 const negative=[user('Fixture'),question,{type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'ask',is_error:true,content:'Canceled'},{type:'tool_result',tool_use_id:'read',is_error:false,content:'"unrelated"="data"'}]}}];
 assert.equal(evaluateHeuristics(normalizeTurns(negative)).some(s=>s.heuristic==='architecture-decision'),false);
});
