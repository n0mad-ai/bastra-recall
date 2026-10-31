import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkStopRepair} from '../src/stop-repair.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {recordRulebookCheck,recordRulebookLoad} from '../src/rulebook-check.js';
import {githubWriteActions} from '../src/github-shell-actions.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const discord={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const email={...discord,channel:'email',limit:10000};
let root:string;const prev=process.env.BASTRA_HOOK_STATE_DIR;
before(async()=>{root=await mkdtemp(join(tmpdir(),'phase4-fix3-'));process.env.BASTRA_HOOK_STATE_DIR=root;});
after(async()=>{if(prev===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=prev;await rm(root,{recursive:true,force:true});});
async function seed(sid:string,channel='email'){
 await recordRulebookLoad(sid,'discord-rule',null,{revision:'r',validator:discord});
 await recordRulebookLoad(sid,'email-rule',null,{revision:'r',validator:email});
 await recordRulebookCheck(sid,{applicable:[],task:'approved-copy'},catalog);
 // Existing persisted channel choices remain readable, without deriving any
 // new choice from user text.
 await mutateSessionState(sid,s=>{s.activeTask!.validatorChannel=channel;s.userValidatorChannel=channel;});
 await mutateSessionState(sid,s=>{s.receipts=[{taskId:s.activeTask!.id,generation:s.activeTask!.generation,hash:'a'.repeat(64),receipt:'sha256:'+'a'.repeat(64),channel,limit:channel==='email'?10000:2000,unit:channel==='email'?'utf16':'max(codepoints,utf16)',at:Date.now()}];});
}
const stop=(sid:string,text:string)=>checkStopRepair({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:text}]});
const catalog:KernelCandidates={entries:[['discord-rule',discord],['email-rule',email]].map(([id,validator])=>({id:id as string,title:'Rule',group:'explicit' as const,rulebook:'on-demand' as const,body:'Fixture',applies_when:'Fixture',revision:'r',updated:null,stale_status:'unknown' as const,validator:validator as typeof discord})),omitted:0};
test('P2.1 only the user-bound channel needs a receipt, not every loaded validator',async()=>{
 await seed('latest-email');assert.equal(await stop('latest-email','x'.repeat(3200)),null);
 await seed('latest-active','discord-dm');await mutateSessionState('latest-active',s=>{s.activeConventions=[{id:'discord-rule',revision:'r',setAt:30,validator:discord}];});
 assert.equal(await stop('latest-active','Short Discord copy'),null);
 assert.equal((await stop('latest-active','```\n'+'x'.repeat(3200)+'\n```'))?.action,'request','new explicit copy still uses the user-bound Discord limit after delivery');
});
test('P2.1 a model task cannot narrow loaded channels, even after user approval',async()=>{
 const sid='model-origin';await recordRulebookLoad(sid,'discord-rule',null,{revision:'r',validator:discord});
 await recordRulebookLoad(sid,'email-rule',null,{revision:'r',validator:email});
 assert.equal((await recordRulebookCheck(sid,{applicable:['discord-rule'],task:'draft-for-review'},catalog)).ok,true);
 assert.equal((await loadSessionState(sid)).userValidatorChannel,undefined);
 await recordRulebookCheck(sid,{applicable:['discord-rule'],task:'approved-copy'},catalog);
 const task=(await loadSessionState(sid)).activeTask!;assert.equal(task.kind,'approved-copy');
 await mutateSessionState(sid,s=>{s.receipts=['discord-dm','email'].map(channel=>({taskId:task.id,generation:task.generation,hash:'a',receipt:'sha256:a',channel,limit:channel==='email'?10000:2000,unit:'max(codepoints,utf16)' as const,at:Date.now()}));});
 assert.equal(await stop(sid,'Small copy'),null);
 assert.equal((await stop(sid,'```\n'+'x'.repeat(3200)+'\n```'))?.action,'request','new explicit copy must satisfy all model-task channels after delivery');
});
test('stage reports never infer a channel and clear legacy channel selection',async()=>{
 const sid='reported-origin';await seed(sid);
 await recordRulebookCheck(sid,{applicable:['discord-rule'],task:'draft-for-review'},catalog);
 const state=await loadSessionState(sid);
 assert.equal(state.activeTask?.kind,'draft-for-review');
 assert.equal(state.userValidatorChannel,undefined);assert.equal(state.activeTask?.validatorChannel,undefined);
});
test('P2.2 a small fenced/quoted decoy cannot hide oversized prose despite a receipt',async()=>{
 for(const [i,text] of [ 'x'.repeat(3200)+'\n```\nok\n```', '```text\nok\n```\n'+'x'.repeat(3200), 'x'.repeat(1600)+'\n```\nok\n```\n'+'x'.repeat(1600),'x'.repeat(3200)+'\n> ok'].entries()){
  const sid='prose-'+i;await seed(sid,'discord-dm');await mutateSessionState(sid,s=>{s.loadedConventions=s.loadedConventions!.slice(0,1);});
  assert.equal((await stop(sid,text))?.action,'request',String(i));
 }
});
test('P2.3 additional GitHub lifecycle commands and literal mutation identifiers are classified',async()=>{
 for(const cmd of ['gh issue delete 1','gh issue transfer 1 owner/repo','gh issue lock 1','gh pr ready 1',...['addComment','reopenIssue','deleteIssue'].map(name=>`gh api graphql -f 'query=mutation { ${name}(input:{}) { id } }'`)])assert.ok((await githubWriteActions(cmd)).length,cmd);
 for(const cmd of ['gh issue delete --help','gh pr ready --help',`echo 'gh issue lock 1'`,`gh api graphql -f 'query=query { viewer { login } }'`])assert.deepEqual(await githubWriteActions(cmd),[],cmd);
});
test('P2.4 docs disclose task-independent checks and the remaining semantic/native-host limits',async()=>{
 const doc=await readFile(new URL('../../../docs/rulebook.md',import.meta.url),'utf8');
 assert.match(doc,/independent of activeTask/i);assert.match(doc,/model decides applicability and can lie/i);assert.match(doc,/Codex only records oversized-copy violations/i);
});


test('P2.2 the largest candidate uses the selected counting unit, including Unicode',async()=>{
 const sid='unicode-decoy';await seed(sid);
 await mutateSessionState(sid,s=>{delete s.userValidatorChannel;s.loadedConventions=[{id:'codepoints-rule',revision:'r',loadedAt:1,validator:{...email,channel:'fixture',limit:100,unit:'codepoints'}}];s.receipts![0]={...s.receipts![0],channel:'fixture',limit:100,unit:'codepoints'};});
 assert.equal((await stop(sid,'x'.repeat(101)+'\n```\n'+'😀'.repeat(60)+'\n```'))?.action,'request');
});
