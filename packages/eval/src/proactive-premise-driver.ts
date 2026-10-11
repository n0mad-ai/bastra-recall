/** Actual temporary memory/evidence files, daemon source verification and owner reconsideration. */
import { readFileSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const PREMISE_CASES=['material-premise-change','unknown-source-controls','supersession'];
export async function runPremises(c:any,x:any):Promise<Record<string,boolean|number|string>> {
  const {http,input,root,vault,clockPath,taskPath,evidence,start,stopDaemon,feature,fixture:f}=x;
  const {memoryRevision}=await import(pathToFileURL(join(feature,'packages/core/dist/index.js')).href);
  const {taskValueHash}=await import(pathToFileURL(join(feature,'packages/daemon/dist/task-events.js')).href);
  let now=Date.parse('2026-10-24T12:00:00Z');const clock=(at:number)=>{now=at;writeFileSync(clockPath,String(at));};
  const snapshot=()=>JSON.parse(readFileSync(taskPath,'utf8'));
  const call=(name:string,body:any,persona='owner')=>http('POST',`/api/v1/task_${name}`,body,persona);
  const ok=(r:any,name:string)=>{if(r.status!==200)throw new Error(`premise fixture ${name}: ${r.status}/${r.data.code}`);return r.data;};
  const get=async(id:string)=>ok(await http('GET',`/api/v1/tasks/${id}`),'get');
  async function wait(id:string,predicate:(t:any)=>boolean){const end=Date.now()+5000;let t=await get(id);while(!predicate(t)&&Date.now()<end){await new Promise(r=>setTimeout(r,50));t=await get(id);}return t;}
  async function make(mode:string,level='notify') {
    clock(now+600000);await stopDaemon();const decisionId='decision-'+mode,assumptionId='assumption-'+mode;
    const raw=(id:string,type:string,body:string)=>`---\nid: ${id}\ntitle: Invented ${id}\nscope: measurement\ntype: ${type}\nsummary: Invented fixture\nsensitivity: private\n---\n${body}\n`;
    const decisionRaw=raw(decisionId,'decision','Choose A because maintenance is costly.'),assumptionRaw=raw(assumptionId,'reference','costly');
    const decisionPath=join(vault,decisionId+'.md');writeFileSync(decisionPath,decisionRaw,{mode:0o600});writeFileSync(join(vault,assumptionId+'.md'),assumptionRaw,{mode:0o600});
    const assumptionRevision=memoryRevision(assumptionRaw),decisionRevision=memoryRevision(decisionRaw);
    const producer='producer-'+mode,source='evidence-'+mode;
    const state=mode==='stale'?now-120000:now,value=mode==='unchanged'?'costly':'cheap',claimId=mode==='irrelevant'?'unrelated-claim':assumptionId,provenance=mode==='contested'?'contested':'attributable';
    const evidenceRaw=JSON.stringify({claim_id:claimId,claim_revision:assumptionRevision,value,state_updated_at:state,provenance});const evidencePath=join(root,source+'.json');writeFileSync(evidencePath,evidenceRaw,{mode:0o600});const evidenceRevision=taskValueHash(evidenceRaw);
    await start();const common={producer_actor:'fixture-owner',owner_domains:['personal'],sensitivity:'private',max_age_ms:60000,enabled:true};
    ok(await call('source_register',{...common,id:producer,kind:'event'}),'producer');ok(await call('source_register',{...common,id:source,kind:'file',producer_actor:'task-source-reader',root:realpathSync(root),path:source+'.json'}),'evidence source');
    const t=ok(await http('POST','/api/v1/tasks',{...input(mode),arm:true,action_level:level,schedule:{kind:'event',source_id:producer,predicate:'premise',expected:'costly',verifier_id:'versioned-value-v1'},decision:{id:decisionId,revision:decisionRevision,option:'A',reason:'Maintenance cost',assumption_id:assumptionId,assumption_revision:assumptionRevision,premise:'costly',alternatives:['B']},evidence:[{source_id:source,id:source,revision:evidenceRevision,hash:evidenceRevision,observed_at:now,state_updated_at:state,max_age_ms:60000,provenance:'attributable'}]}),'create');
    if(mode==='failed')unlinkSync(evidencePath);
    const event={source_id:producer,source_revision:0,dedup_key:'new-material',value:'Invented maintenance evidence',state_updated_at:state,claim:{claim_id:claimId,claim_revision:assumptionRevision,value,evidence_id:source,evidence_revision:evidenceRevision}};
    ok(await call('event',event),'event');const task=await wait(t.id,t=>Boolean(t.verification)||!t.armed);
    evidence.push({mode,decisionRaw,assumptionRaw,evidenceRaw,event,task});return {task,event,decisionPath,decisionRaw,decisionRevision};
  }
  if(c.id==='unknown-source-controls') {
    let falseCount=0,unknown=true;
    for(const mode of ['unchanged','irrelevant','stale','failed','contested']){const a=await make(mode);const t=await wait(a.task.id,t=>Boolean(t.verification));const s=snapshot();const occurrences=s.occurrences.filter((o:any)=>o.task_id===t.id);falseCount+=occurrences.length;const expected:Record<string,string[]>={unchanged:['verified'],irrelevant:['inconclusive'],stale:['stale'],failed:['unavailable'],contested:['inconclusive']};unknown&&=t.armed&&expected[mode].includes(t.verification?.outcome)&&readFileSync(a.decisionPath,'utf8')===a.decisionRaw;evidence.push({mode,verification:t.verification,occurrences});}
    return {false_reconsiderations:falseCount,unknown_not_false_all_subruns:unknown};
  }
  if(c.id==='material-premise-change') {
    let exact=true,reversals=0,persist=true;
    for(const choice of ['keep','change','snooze','stop']){const a=await make(choice);let task=await wait(a.task.id,t=>t.state==='due');const original=readFileSync(a.decisionPath,'utf8');reversals+=original!==a.decisionRaw?1:0;
      const eventRetry=await call('event',a.event);await new Promise(r=>setTimeout(r,100));const before=snapshot();const occurrences=before.occurrences.filter((o:any)=>o.task_id===task.id);const cards=ok(await call('due',{}),'due');const card=cards.cards.find((card:any)=>card.task_id===task.id);exact&&=eventRetry.status===200&&eventRetry.data.event_id===before.events.find((e:any)=>e.source_id===a.event.source_id).id&&occurrences.length===1&&card?.reconsideration?.old_premise==='costly'&&card?.reconsideration?.new_premise==='cheap'&&card?.reconsideration?.decision?.option==='A';
      if(occurrences.length!==1)throw new Error('material fixture lacks exactly one occurrence');task=await get(task.id);const body={id:task.id,expected_revision:task.expected_revision,occurrence_id:occurrences[0].id,choice,...(choice==='snooze'?{until:now+3600000}:{}),...(choice==='change'?{change:{idempotency_key:'owner-change',expected_memory_revision:a.decisionRevision,body:'Choose B after owner review.',option:'B',reason:'Changed maintenance evidence'}}:{})};
      const denied=await call('reconsider',body,'agent');const result=ok(await call('reconsider',body),'reconsider');persist&&=denied.status===403;const changed=readFileSync(a.decisionPath,'utf8');if(choice==='change'){const retry=ok(await call('reconsider',body),'change retry');persist&&=retry.revision===result.revision&&changed.includes('Choose B after owner review.')&&memoryRevision(changed)===result.revision;}else persist&&=changed===a.decisionRaw;
      await stopDaemon();await start();task=await get(task.id);persist&&=choice==='snooze'?task.state==='snoozed'&&task.snoozed_until===now+3600000:!task.armed&&(choice==='stop'?task.state==='cancelled':choice==='change'?task.decision_change?.status==='applied':task.history.some((h:any)=>h.operation==='decision-keep'&&h.decision_snapshot));evidence.push({choice,eventRetry,denied,result,task,changed});
    }
    return {reconsiderations_per_event:exact?1:0,automatic_decision_reversals:reversals,controls_persist_all_subruns:persist};
  }
  if(c.id==='supersession') {
    let rebound=0,spent=0,history=true;
    for(const mode of ['edit','cancel','supersede']){const a=await make('binding-'+mode,'prepare');let task=await wait(a.task.id,t=>t.state==='due');let prepared=await call('prepare',{id:task.id,expected_revision:task.expected_revision,target_id:'artifact',payload:'after\n'},'agent');if(prepared.data.code==='approval_stale'){task=await get(task.id);prepared=await call('prepare',{id:task.id,expected_revision:task.expected_revision,target_id:'artifact',payload:'after\n'},'agent');}const p=ok(prepared,'prepare').proposal;const proofs:string[]=[];
      for(const domain of ['personal','other']){const challenge=ok(await call('challenge',{proposal_id:p.id,domain}),'challenge');proofs.push(ok(await call('approval',{challenge_id:challenge.challenge.id,decision:'approve',signature:f.keys.signTaskApproval(f.key,f.actions.approvalBinding(challenge.proposal,challenge.challenge,'approve'))}),'approval').approval_id);}
      const before=snapshot().tasks.find((t:any)=>t.id===task.id).history;
      writeFileSync(a.decisionPath,mode==='edit'?a.decisionRaw+'External edit\n':a.decisionRaw.replace('summary:',(mode==='cancel'?'status: cancelled':'superseded_by: replacement')+'\nsummary:'));
      await stopDaemon();await start();await call('due',{});task=await wait(task.id,t=>!t.armed);const denied=await call('lease',{proposal_id:p.id},'agent');const s=snapshot();rebound+=task.armed||task.decision.revision!==a.decisionRevision||denied.status===200?1:0;spent+=s.consumed_approval_ids.filter((id:string)=>proofs.includes(id)).length;history&&=JSON.stringify(task.history.slice(0,before.length))===JSON.stringify(before)&&task.history.some((h:any)=>h.operation==='decision-disarmed'&&h.decision_snapshot);evidence.push({mode,task,denied,snapshot:s});
    }
    return {silent_rebindings:rebound,old_approvals_spent:spent,history_retained_all_subruns:history};
  }
  throw new Error('unimplemented premise scenario');
}
