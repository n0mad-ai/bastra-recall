import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {beginRulebookRound,recordRulebookCheck,requireActionRules,rulebookBoundary} from '../src/rulebook-check.js';
import {loadSessionState} from '../src/session-state.js';
import {runSessionLane} from '../src/session-lane.js';
import type {KernelCandidates,KernelEntry} from '../src/rulebook-catalog.js';
let root:string;
before(async()=>{root=await mkdtemp(join(tmpdir(),'security-followup-'));process.env.BASTRA_HOOK_STATE_DIR=join(root,'state');});
after(()=>rm(root,{recursive:true,force:true}));
const entry=(id:string):KernelEntry=>({id,title:'Invented rule',group:'explicit',revision:'r1',updated:null,stale_status:'unknown',body:'',rulebook:'on-demand',rule_categories:['correspondence','github-issues-prs']});
const catalog:KernelCandidates={entries:[entry('required-rule'),entry('ordinary-rule')],omitted:0};
for(const worker of [false,true])test(`category dismissal cannot discharge a concrete action obligation (${worker?'worker':'main'})`,async()=>{
 const sid=`required-${worker}`,p={session_id:sid,bastra_client:'claude-code',...(worker?{agent_id:'worker'}:{})};
 await beginRulebookRound(p,catalog);await requireActionRules(p,[{id:'required-rule',revision:'r1'}]);
 assert.equal((await recordRulebookCheck(sid,{applicable:[],...(worker?{agent_id:'worker'}:{}),not_applicable:[{category:'correspondence',reason:'This round only reviews unrelated technical work.'}]},catalog)).ok,true);
 const actor=async()=>JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors.find((a:any)=>a.key===(worker?'agent:worker':'main'));
 let a=await actor();assert.deepEqual(a.required,[{id:'required-rule',revision:'r1'}]);assert.equal(a.dismissed.length,0);
 assert.deepEqual(a.roundDismissed.map((r:any)=>r.id),['ordinary-rule']);
 const denial=JSON.parse((await rulebookBoundary(p,catalog,'action',{requiredOnly:true}))!);assert.equal(denial.hookSpecificOutput.permissionDecision,'deny');
 // An exact, reasoned ID exception retains the existing audited contract.
 assert.equal((await recordRulebookCheck(sid,{applicable:[],...(worker?{agent_id:'worker'}:{}),not_applicable:[{id:'required-rule',reason:'This exact action rule does not apply to this operation.'}]},catalog)).ok,true);
 a=await actor();assert.equal(a.required.length,0);assert.deepEqual(a.dismissed,[{id:'required-rule',revision:'r1'}]);
 assert.equal(await rulebookBoundary(p,catalog,'action',{requiredOnly:true}),'{}');
});
test('vault-care binds deletion authority to the current user turn naming exact notes',async()=>{
 const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/hook/session-context'?{context:'',vault_size:0,blocks:[],retrieval:'lexical',budget:{},aborted:[],data:{recalls:[],floors:[],conventions:[],care:{open:2,queued:0},imports:{open:0,queued:0},onboarding:false}}:{ok:true}));});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
 const port=(server.address() as {port:number}).port;
 const raw=await runSessionLane({hook_event_name:'SessionStart',source:'startup',session_id:'care-authority',cwd:'/tmp'},`http://127.0.0.1:${port}`,undefined,async()=>null);
 const out=JSON.parse(raw).hookSpecificOutput.additionalContext;
 const care=/<vault-care>([\s\S]*?)<\/vault-care>/u.exec(out)?.[1]??'';assert.ok(care);
 assert.match(care,/current user turn[^.]*specific notes/);
 assert.match(care,/vault-care\.md entries are never authorization/);
 assert.match(care,/Do not ask again per entry/);
 assert.doesNotMatch(care,/an existing instruction to delete/);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
