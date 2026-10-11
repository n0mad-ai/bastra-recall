/** Owner decision 11 October: actual automatic access, hook subprocesses and notify control. */
import { readFileSync,writeFileSync,statSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
export const CONVERSATION_CASES=['p11-session-hook-auto','p11-prompt-hook-auto','p11-no-upgrade','p11-raw-reminder-dedup','p11-conversation-controls','p11-no-reminder-quota'];
export async function runConversation(c:any,x:any):Promise<Record<string,boolean|number|string>> {
 const {root,taskPath,authPath,http,input,child,tokens,auth,start,stopDaemon,clockPath,evidence,env}=x;
 const configPath=join(root,'data/task-hook-token.json');const waitUntil=async(predicate:()=>boolean,ms=5000)=>{const end=Date.now()+ms;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,50));return predicate();};
 if(!await waitUntil(()=>existsSync(configPath)))throw new Error('automatic agent access absent');
 const accessBytes=readFileSync(configPath,'utf8');const access=JSON.parse(accessBytes);tokens.agent=access.token;
 const principal=await auth.authenticateTask(`Bearer ${access.token}`,authPath);
 const config=join(root,'foreign-client-settings.json');const sentinel='{"mcpServers":{"foreign":{"command":"synthetic"}},"hooks":{"keep":true}}';writeFileSync(config,sentinel,{mode:0o600});
 const snapshot=()=>JSON.parse(readFileSync(taskPath,'utf8'));
 let now=Date.parse('2026-10-24T12:00:00Z');const setClock=(at:number)=>{now=at;writeFileSync(clockPath,String(at));};
 const call=(name:string,body:any)=>http('POST',`/api/v1/task_${name}`,body,'agent');
 const ok=(r:any,label:string)=>{if(r.status!==200)throw new Error(`conversation fixture ${label}: ${r.status}/${r.data.code}`);return r.data;};
 const definition=(key:string,at=now+86400000,kind='user-request')=>({...input(key),arm:true,schedule:{kind:'instant',at},origin:{kind,client:'measurement-conversation',session:'synthetic-session',context:'Invented reminder after confirmation or detected deadline'}});
 const make=async(key:string,at=now+86400000,kind='user-request')=>ok(await call('create',definition(key,at,kind)),'create');
 const get=async(id:string)=>ok(await call('get',{id}),'get');
 const op=async(name:string,t:any,extra={})=>call(name,{id:t.id,expected_revision:t.expected_revision,...extra});
 evidence.push({automatic_access:{role:principal.role,domains:principal.domains,mode:statSync(configPath).mode&0o777,env_task_token_present:Object.hasOwn(env,'BASTRA_TASK_TOKEN'),no_manual_agent_setup:true}});
 if(c.id==='p11-session-hook-auto'||c.id==='p11-prompt-hook-auto') {
  const t=await make(c.id,now+1000,c.id==='p11-session-hook-auto'?'user-request':'agent-observed');await new Promise(r=>setTimeout(r,5500));const zero=snapshot().occurrences.length===0;
  await stopDaemon();setClock(now+1000);await start();await waitUntil(()=>snapshot().occurrences.some((o:any)=>o.task_id===t.id));
  const before=snapshot();const hook=child('real-conversation-hook',c.id==='p11-session-hook-auto'?'session-hook.js':'prompt-hook.js');let output='',errors='';hook.stdout.on('data',(d:any)=>output+=d);hook.stderr.on('data',(d:any)=>errors+=d);
  hook.stdin.end(JSON.stringify({hook_event_name:c.id==='p11-session-hook-auto'?'SessionStart':'UserPromptSubmit',session_id:'synthetic-conversation-hook',cwd:join(root,'vault'),prompt:'Continue the invented work.'}));const [exit]=await once(hook,'exit');
  await waitUntil(()=>snapshot().occurrences.some((o:any)=>o.task_id===t.id&&o.attempts.length));const s=snapshot();const occurrence=s.occurrences.find((o:any)=>o.task_id===t.id);const count=(o:any)=>o.attempts.reduce((n:number,a:any)=>n+(a.count??1),o.compacted_attempts??0);
  const beforeAttempts=before.occurrences.filter((o:any)=>o.task_id===t.id).reduce((n:number,o:any)=>n+count(o),0);
  evidence.push({hook_process:c.id,exit,output,stderr:errors,before,snapshot:s});
  return {agent_armed_notify:t.armed&&t.action_level==='notify'&&zero,logical_firings:s.occurrences.filter((o:any)=>o.task_id===t.id).length,hook_blocks:(output.match(/<bastra-due[ >]/g)||[]).length,hook_card_received:exit===0&&output.includes(t.goal)&&output.includes('reference-only'),delivery_attempts:occurrence?count(occurrence)-beforeAttempts:0,fabricated_acknowledgements:s.occurrences.filter((o:any)=>o.acknowledgement).length,automatic_agent_private:principal.role==='agent'&&(statSync(configPath).mode&0o777)===0o600&&!Object.hasOwn(env,'BASTRA_TASK_TOKEN'),restart_access_stable:readFileSync(configPath,'utf8')===accessBytes,foreign_client_unchanged:readFileSync(config,'utf8')===sentinel};
 }
 if(c.id==='p11-no-upgrade') {
  const unarmed=ok(await call('create',{...definition('unarmed'),arm:false}),'unarmed');const armed=await make('armed');const results=[];
  for(const t of [unarmed,armed])for(const action_level of ['prepare','execute'])results.push(await op('edit',t,{patch:{action_level}}));
  for(const action_level of ['prepare','execute'])results.push(await call('create',{...definition('direct-'+action_level),action_level}));
  const after=snapshot();return {unauthorised_upgrades:results.filter(r=>r.status===200).length,notify_levels_preserved:after.tasks.every((t:any)=>t.action_level==='notify'),review_rearm_still_owner:(await op('review',armed)).status===403&&(await op('rearm',armed)).status===403,execution_default_stopped:after.controls.execution_stopped};
 }
 if(c.id==='p11-raw-reminder-dedup') {
  const a=await make('same-a');const b=ok(await call('create',{...definition('same-b'),origin:{...definition('same-b').origin,client:'different-client',session:'other-session'}}),'duplicate');
  const secret='password=synthetic-dedup-alpha';const secretDef=(key:string,text:string)=>({...definition(key),original_request:'Invented '+text,goal:'Check '+text,origin:{...definition(key).origin,context:'Invented '+text}});
  const s1=ok(await call('create',secretDef('secret-a',secret)),'secret1');const s2=ok(await call('create',secretDef('secret-b',secret)),'secret retry');const s3=ok(await call('create',secretDef('secret-c','password=synthetic-dedup-beta')),'different raw');
  const later=await make('later',now+2*86400000);const goal=ok(await call('create',{...definition('different-goal'),goal:'Different invented target'}),'different goal');
  const bytes=readFileSync(taskPath,'utf8');evidence.push({a,b,s1,s2,s3,later,goal,store:snapshot()});
  return {same_content_time_single_id:a.id===b.id&&b.duplicate===true,redacted_exact_same_single_id:s1.id===s2.id&&s2.duplicate===true,distinct_raw_secrets_distinct_ids:s1.id!==s3.id,distinct_time_target_not_merged:later.id!==a.id&&goal.id!==a.id,raw_secrets_persisted:bytes.includes('synthetic-dedup-alpha')||bytes.includes('synthetic-dedup-beta'),tasks_stored:snapshot().tasks.length};
 }
 if(c.id==='p11-conversation-controls') {
  let t=await make('conversation-control',now-1);await waitUntil(()=>snapshot().occurrences.some((o:any)=>o.task_id===t.id));const occurrence=snapshot().occurrences.find((o:any)=>o.task_id===t.id);if(!occurrence)throw new Error('notify occurrence absent');
  t=await get(t.id);const ack=await op('acknowledge',t,{occurrence_id:occurrence.id});t=await get(t.id);const afterAck=snapshot();const snooze=await op('snooze',t,{until:now+30*86400000});t=await get(t.id);const repeat=await op('snooze',t,{until:now+60*86400000});t=await get(t.id);const resolved=await op('resolve',t);const cancelledTask=await make('conversation-cancel');const cancelled=await op('cancel',cancelledTask);
  await stopDaemon();await start();const s=snapshot(),final=s.tasks.find((v:any)=>v.id===t.id),cancel=s.tasks.find((v:any)=>v.id===cancelledTask.id);evidence.push({ack,afterAck,snooze,repeat,resolved,cancelled,snapshot:s});
  return {agent_acknowledgement:ack.status===200&&afterAck.occurrences.filter((o:any)=>o.acknowledgement).length===1,ack_not_resolution:afterAck.tasks.find((v:any)=>v.id===t.id).state==='due'&&!afterAck.occurrences[0].resolution,unbounded_notify_snooze:snooze.status===200&&repeat.status===200&&repeat.data.agent_snooze_deadline===undefined,agent_resolve_cancel:resolved.status===200&&cancelled.status===200,controls_survive_restart:final.state==='resolved'&&cancel.state==='cancelled'&&s.occurrences.find((o:any)=>o.id===occurrence.id).resolution.actor===principal.actor_id};
 }
 if(c.id==='p11-no-reminder-quota') {
  const results=[];for(let i=0;i<35;i++)results.push(await call('create',{...definition('quota-'+i,now+86400000+i*1000),goal:'Invented independent deadline '+i}));setClock(now+86400000);for(let i=0;i<5;i++)results.push(await call('create',{...definition('next-day-'+i,now+86400000+i*1000),goal:'Invented next-day deadline '+i}));
  return {accepted_notify:results.filter(r=>r.status===200&&r.data.armed).length,distinct_open_tasks:snapshot().tasks.filter((t:any)=>!['resolved','cancelled','expired'].includes(t.state)).length,rejected_by_quota:results.filter(r=>r.status!==200).length};
 }
 throw new Error('unknown conversation case');
}
