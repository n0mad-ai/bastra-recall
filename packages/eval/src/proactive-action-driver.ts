/** Independent HTTP/action effect probes; all keys, proofs and targets are invented. */
import { readFileSync, writeFileSync, mkdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const ACTION_CASES=['reference-containment-revocation','owners-fencing','prepare-forgery-drift','kill-recovery'];
export async function actionFixture(feature:string,root:string,authPath:string,tokens:Record<string,string|undefined>,auth:any) {
  const keys=await import(pathToFileURL(join(feature,'packages/daemon/dist/task-approval-keys.js')).href);
  const actions=await import(pathToFileURL(join(feature,'packages/daemon/dist/task-actions.js')).href);
  const envelope=keys.newOwnerKey('invented measurement passphrase');const key=keys.unlockOwnerKey(envelope,'invented measurement passphrase');
  const targetRoot=join(realpathSync(root),'artifacts');mkdirSync(targetRoot,{mode:0o700});writeFileSync(join(targetRoot,'artifact.txt'),'before\n',{mode:0o600});
  const sentinel=join(realpathSync(root),'outside-artifact.txt');writeFileSync(sentinel,'outside\n',{mode:0o600});symlinkSync(sentinel,join(targetRoot,'escape.txt'));
  const registry={schema_version:1,revision:1,protected_boundary:true,keys:['personal','other'].map((domain,i)=>({id:`synthetic-key-${i}`,domain,public_key:envelope.public_key,fingerprint:keys.bytesHash(envelope.public_key)})),targets:[{id:'artifact',root:targetRoot,path:'artifact.txt',owner_domains:['personal','other'],sensitivity:'private',adapter:'local-artifact-v1'},{id:'escape',root:targetRoot,path:'escape.txt',owner_domains:['personal','other'],sensitivity:'private',adapter:'local-artifact-v1'},{id:'parent-escape',root:targetRoot,path:'../outside-artifact.txt',owner_domains:['personal','other'],sensitivity:'private',adapter:'local-artifact-v1'}]};
  writeFileSync(join(root,'data/task-approval-keys.json'),JSON.stringify(registry),{mode:0o600});
  tokens.owner=(await auth.mintTaskCredential(authPath,{actor_id:'fixture-owner',domains:['personal','other'],role:'owner'})).token;
  tokens.agent=(await auth.mintTaskCredential(authPath,{actor_id:'fixture-agent',domains:['personal','other'],role:'agent'})).token;
  return {keys,actions,key,target:join(targetRoot,'artifact.txt'),sentinel,registry};
}
export async function runActions(c:any,x:any): Promise<Record<string,boolean|number|string>> {
  const {http,input,fixture:f,clockPath,taskPath,evidence,start,stopDaemon}=x;
  let now=Date.parse('2026-10-24T12:00:00Z');const clock=(at:number)=>{now=at;writeFileSync(clockPath,String(at));evidence.push({frozen_clock:at});};
  const snapshot=()=>JSON.parse(readFileSync(taskPath,'utf8'));const bytes=()=>readFileSync(f.target,'utf8');
  const call=(name:string,body:any,persona='agent')=>http('POST',`/api/v1/task_${name}`,body,persona);
  const requireOk=(r:any,label:string)=>{if(r.status!==200)throw new Error(`action fixture ${label}: ${r.status}/${r.data.code}`);return r.data;};
  const controls=(body:any)=>call('controls',body,'owner');
  const current=async(id:string)=>requireOk(await http('GET',`/api/v1/tasks/${id}`),'current');
  async function make(key:string,event=false) {
    clock(now+600000);writeFileSync(f.target,'before\n');
    const sourceId=`producer-${key}`;
    if(event)requireOk(await http('POST','/api/v1/tasks/sources',{id:sourceId,kind:'event',producer_actor:'fixture-owner',owner_domains:['personal','other'],sensitivity:'private',max_age_ms:600000,enabled:true}),'source');
    const t=requireOk(await http('POST','/api/v1/tasks',{...input(key),arm:true,owner_domains:['personal','other'],action_level:'execute',schedule:event?{kind:'event',source_id:sourceId,predicate:'equals',expected:'A'}:{kind:'instant',at:now-1}}),'create');
    if(event)requireOk(await http('POST','/api/v1/tasks/events',{source_id:sourceId,source_revision:0,dedup_key:'baseline',value:'A',state_updated_at:now}),'event');
    let task=await current(t.id);const deadline=Date.now()+5000;while(task.state!=='due'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,50));task=await current(t.id);}if(task.state!=='due')throw new Error('action fixture did not become due automatically');const prepared=requireOk(await call('prepare',{id:task.id,expected_revision:task.expected_revision,target_id:'artifact',payload:'after\n'}),'prepare');
    if(bytes()!=='before\n'||prepared.executes!==false)throw new Error('prepare mutated target');
    return {task,prepared,sourceId};
  }
  async function approve(proposalId:string,domains=['personal','other']) {
    const proofs=[];
    for(const domain of domains){const challenge=requireOk(await call('challenge',{proposal_id:proposalId,domain},'owner'),'challenge');const signature=f.keys.signTaskApproval(f.key,f.actions.approvalBinding(challenge.proposal,challenge.challenge,'approve'));proofs.push(requireOk(await call('approval',{challenge_id:challenge.challenge.id,decision:'approve',signature},'owner'),'approval'));}
    return proofs;
  }
  async function lease(p:any){return requireOk(await call('lease',{proposal_id:p.id}),'lease');}
  const execute=(p:any,l:any,key:string,patch={})=>call('execute',{proposal_id:p.id,lease_id:l.lease.id,holder_token:l.holder_token,fence:l.lease.fence,idempotency_key:key,...patch});
  async function ready(key:string,event=false){requireOk(await controls({execution_stopped:false,adapter:{id:'local-artifact-v1',enabled:true}}),'controls');const a:any=await make(key,event);a.proofs=await approve(a.prepared.proposal.id);a.lease=await lease(a.prepared.proposal);return a;}
  async function rollback(result:any){const r=requireOk(await call('rollback_prepare',{receipt_id:result.receipt.id}),'rollback prepare');const denied=await call('lease',{proposal_id:r.proposal.id});if(denied.status===200)throw new Error('rollback reused old approval');await approve(r.proposal.id);const l=await lease(r.proposal);requireOk(await execute(r.proposal,l,'rollback-'+result.receipt.id),'rollback');return bytes()==='before\n';}
  if(c.id==='reference-containment-revocation') {
    const a=await ready('revoked');
    const task=await current(a.task.id);const escaped=[];for(const target_id of ['escape','parent-escape','unknown'])escaped.push(await call('prepare',{id:task.id,expected_revision:task.expected_revision,target_id,payload:'escaped\n'}));
    requireOk(await call('revoke_approval',{approval_id:a.proofs[0].approval_id},'owner'),'revoke');const denied=await execute(a.prepared.proposal,a.lease,'revoked');
    const revokedEffect=bytes()!=='before\n';const valid=await ready('valid');const result=requireOk(await execute(valid.prepared.proposal,valid.lease,'valid'),'execute');const after=snapshot();const stamp=statSync(f.target).mtimeMs;const retry=await execute(valid.prepared.proposal,valid.lease,'valid');
    const one=bytes()==='after\n'&&after.intents.filter((i:any)=>i.proposal_id===valid.prepared.proposal.id).length===1&&after.receipts.filter((r:any)=>r.proposal_id===valid.prepared.proposal.id).length===1&&retry.status===200&&statSync(f.target).mtimeMs===stamp;
    const restored=await rollback(result);evidence.push({escaped,denied,after,synthetic_signatures_only:true});
    return {escaped_writes:escaped.some(r=>r.status===200)||readFileSync(f.sentinel,'utf8')!=='outside\n'?1:0,revoked_effects:revokedEffect||denied.status===200?1:0,valid_effects:one?1:0,rollback_restores_hash:restored};
  }
  if(c.id==='owners-fencing') {
    requireOk(await controls({execution_stopped:false,adapter:{id:'local-artifact-v1',enabled:true}}),'controls');const a=await make('partial');await approve(a.prepared.proposal.id,['personal']);const partial=await call('lease',{proposal_id:a.prepared.proposal.id});const unchanged=bytes()==='before\n';
    await approve(a.prepared.proposal.id,['other']);const old=await lease(a.prepared.proposal);clock(now+31000);const expired=await execute(a.prepared.proposal,old,'expired');const fresh=await lease(a.prepared.proposal);const fenced=await execute(a.prepared.proposal,old,'fenced');
    evidence.push({partial,expired,fenced,old_lease:old.lease,new_lease:fresh.lease});
    return {partial_approval_effects:partial.status===200||!unchanged?1:0,expired_lease_effects:expired.status===200||fenced.status===200||fresh.lease.fence<=old.lease.fence||bytes()!=='before\n'?1:0};
  }
  if(c.id==='prepare-forgery-drift') {
    let effects=0,exact=true;
    for(const mode of ['forgery','old','expired','revoked','payload','source','target']){
      const a=await ready(mode,mode==='source');const p=a.prepared.proposal;
      let denied:any;
      if(mode==='forgery')denied=await call('execute',{proposal_id:p.id,lease_id:a.lease.lease.id,holder_token:a.lease.holder_token,fence:a.lease.lease.fence,idempotency_key:mode,source:'user',approved:true});
      if(mode==='old'){const t=await current(a.task.id);requireOk(await call('edit',{id:t.id,expected_revision:t.expected_revision,patch:{goal:'Changed exact goal'}},'owner'),'edit');denied=await execute(p,a.lease,mode);}
      if(mode==='expired'){clock(now+301000);denied=await execute(p,a.lease,mode);}
      if(mode==='revoked'){requireOk(await call('revoke_approval',{approval_id:a.proofs[0].approval_id},'owner'),'revoke');denied=await execute(p,a.lease,mode);}
      if(mode==='payload')denied=await execute(p,a.lease,mode,{payload:'forged effect\n'});
      if(mode==='source'){requireOk(await controls({source:{id:a.sourceId,enabled:false}}),'source disable');denied=await execute(p,a.lease,mode);}
      if(mode==='target'){writeFileSync(f.target,'external edit\n');denied=await execute(p,a.lease,mode);}
      const expected=mode==='target'?'external edit\n':'before\n';effects+=bytes()!==expected?1:0;exact&&=denied.status!==200&&!snapshot().intents.some((i:any)=>i.proposal_id===p.id)&&!snapshot().consumed_approval_ids.some((id:string)=>a.proofs.some((proof:any)=>proof.approval_id===id));evidence.push({mode,denied,target:bytes(),snapshot:snapshot()});
    }
    return {unauthorised_effects:effects,exact_review_required_all_subruns:exact};
  }
  if(c.id==='kill-recovery') {
    let effects=0,history=true,available=true;
    for(const mode of ['stop','adapter']){const a=await ready(mode);const before=snapshot().tasks.find((t:any)=>t.id===a.task.id).history;requireOk(await controls(mode==='stop'?{execution_stopped:true}:{adapter:{id:'local-artifact-v1',enabled:false}}),'kill');const denied=await execute(a.prepared.proposal,a.lease,mode);effects+=denied.status===200||bytes()!=='before\n'?1:0;
      const read=await current(a.task.id);const review=await call('review',{id:read.id,expected_revision:read.expected_revision},'owner');const due=requireOk(await http('POST','/api/v1/tasks',{...input('notify-'+mode),arm:true,schedule:{kind:'instant',at:now-1},owner_domains:['personal','other']}),'notify create');await stopDaemon();await start();const cards=await call('due',{},'owner');const s=snapshot();history&&=JSON.stringify(s.tasks.find((t:any)=>t.id===a.task.id).history.slice(0,before.length))===JSON.stringify(before);available&&=read.id===a.task.id&&review.status===200&&cards.status===200&&cards.data.cards.some((card:any)=>card.task_id===due.id);evidence.push({mode,denied,review,cards,snapshot:s});}
    return {stopped_effects:effects,history_retained_all_subruns:history,read_review_notify_available:available};
  }
  throw new Error('unimplemented action scenario');
}
