import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runStopLane} from '../src/stop-lane.js';
import {recordRulebookCheck,recordRulebookLoad,roundCorrespondence} from '../src/rulebook-check.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {validateArtifactHandler} from '../src/validate-artifact-handler.js';
import {callerSessionStore} from '../src/caller-session.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const discord={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const email={...discord,channel:'email',limit:10000};
const catalog:KernelCandidates={entries:[['dc',discord],['mail',email]].map(([id,validator])=>({id:id as string,title:'Invented rule',group:'explicit' as const,rulebook:'on-demand' as const,applies_when:'Invented replies',body:'Fixture',revision:'r1',updated:null,stale_status:'unknown' as const,validator:validator as typeof discord})),omitted:0};
let root:string;const prev=process.env.BASTRA_HOOK_STATE_DIR;
before(async()=>{root=await mkdtemp(join(tmpdir(),'p5-fix1-'));process.env.BASTRA_HOOK_STATE_DIR=root;});
after(async()=>{if(prev===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=prev;await rm(root,{recursive:true,force:true});});
const load=(sid:string,id:string,v:typeof discord|typeof email)=>recordRulebookLoad(sid,id,null,{revision:'r1',validator:v,rulebookMetadata:{rulebook:'on-demand',applies_when:'Invented reply'}});
const report=(sid:string,task:'draft-for-review'|'approved-copy')=>recordRulebookCheck(sid,{applicable:[],task},catalog);
// Explicit copy keeps these channel/source tests independent of draft prose.
const stop=async(sid:string,text:string)=>JSON.parse(await runStopLane({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:text.includes('```')?text:'```\n'+text+'\n```'}]},'http://127.0.0.1:1'));
const repair=(out:unknown)=>JSON.stringify(out).includes('<copy-repair');
const validate=(sid:string,text:string,v= email)=>callerSessionStore.run(sid,()=>validateArtifactHandler({text,channel:v.channel,limit:v.limit,unit:v.unit,normalize:'none'}));
test('P1: legacy persisted email channel remains measurable without deriving a new channel',async()=>{
 const sid='mail-flow';await load(sid,'dc',discord);await load(sid,'mail',email);
 await report(sid,'draft-for-review');
 await stop(sid,'Deutscher Entwurf zur Freigabe:\n```\nJa, ich komme.\n```');
 assert.equal((await loadSessionState(sid)).activeTask?.kind,'draft-for-review');
 await report(sid,'approved-copy');assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy');
 await mutateSessionState(sid,s=>{s.activeTask!.validatorChannel='email';s.userValidatorChannel='email';});
 const text='Hallo Max, '.repeat(300);assert.equal(text.length,3300);
 assert.equal((await validate(sid,text)).receipt_stored,true);
 assert.equal(repair(await stop(sid,text)),false);
});
test('P1: task report before full load still requires repair on the real Stop lane',async()=>{
 const sid='task-before-load';await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 await load(sid,'dc',discord);assert.equal(repair(await stop(sid,'x'.repeat(3200))),true);
});
test('model naming only a lax rule cannot narrow a previously loaded strict rule',async()=>{
 const sid='model-lax';await load(sid,'dc',discord);
 await recordRulebookCheck(sid,{applicable:['mail'],task:'draft-for-review'},catalog);
 const text='x'.repeat(3200);await validate(sid,text);
 assert.equal(repair(await stop(sid,text)),true);
});
test('trusted current same-ID revision replaces an old limit; MCP mutations are tested in fix2',async()=>{
 const sid='reload-lax';await load(sid,'dc',discord);
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 await load(sid,'dc',{...discord,limit:10000} as typeof email);
 assert.equal((await callerSessionStore.run(sid,()=>validateArtifactHandler({text:'x'.repeat(3200),channel:'discord-dm',limit:10000,normalize:'none'}))).receipt_stored,true);
 assert.equal(repair(await stop(sid,'x'.repeat(3200))),false);
});
test('without a user channel the conservative multichannel alarm exhausts after two requests',async()=>{
 const sid='unbound-mail';await load(sid,'dc',discord);await load(sid,'mail',email);
 await report(sid,'draft-for-review');
 await stop(sid,'Deutscher Entwurf zur Freigabe:\n```\nJa, ich komme.\n```');await report(sid,'approved-copy');
 assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy');
 assert.equal((await loadSessionState(sid)).userValidatorChannel,undefined);
 const text='Hallo Max, '.repeat(300);await validate(sid,text);
 const transcript:{role:string;content:string}[]=[];
 const results=[];for(let i=0;i<4;i++){
  transcript.push({role:'assistant',content:'```\n'+text+'\n```'});
  results.push(repair(JSON.parse(await runStopLane({session_id:sid,hook_event_name:'Stop',transcript},'http://127.0.0.1:1'))));
 }
 assert.deepEqual(results,[true,true,false,false]);
 assert.equal(roundCorrespondence(await loadSessionState(sid),{}).repairs,3);
});
test('explicit stage reports do not select a channel',async()=>{
 const sid='quoted-channel';await load(sid,'dc',discord);await load(sid,'mail',email);
 await report(sid,'draft-for-review');
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 await report(sid,'approved-copy');
 assert.equal((await loadSessionState(sid)).userValidatorChannel,undefined);
 await validate(sid,'x'.repeat(3200));assert.equal(repair(await stop(sid,'x'.repeat(3200))),true);
});
