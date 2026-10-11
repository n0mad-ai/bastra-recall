/** Published storage versions and actual daemon recovery; all paths are synthetic. */
import { readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { dirname,basename,join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function runMigration(x:any):Promise<Record<string,boolean|number|string>> {
 const {http,create,taskPath,root,start,stopDaemon,evidence,legacyRoot,storeApi}=x;
 const old=await import(pathToFileURL(join(legacyRoot,'packages/daemon/dist/task-store.js')).href);
 const schema=await import(pathToFileURL(join(legacyRoot,'packages/daemon/dist/task-schema.js')).href);
 const memory=join(root,'vault/neighbour.txt'),drafts=join(root,'drafts.json');writeFileSync(memory,'invented neighbour',{mode:0o600});const draftSentinel=JSON.stringify({version:1,rows:[],measurement:'invented draft sentinel'});writeFileSync(drafts,draftSentinel,{mode:0o600});
 const first=await http('GET','/api/v1/tasks');const t=await create('migration');const base=JSON.parse(readFileSync(taskPath,'utf8'));
 const pick=(value:any,shape:any)=>Object.fromEntries(Object.keys(shape).filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
 const legacy=pick(base,schema.taskStoreSchema.shape);legacy.schema_version=1;legacy.tasks=base.tasks.map((task:any)=>pick(task,schema.taskSchema.shape));
 old.decodeTaskStore(JSON.stringify(legacy)); // genuine v1 accepted by original published decoder
 let migrations=first.status===200&&first.data.tasks.length===0,loss=0;
 for(const version of [1,2]){
  await stopDaemon();const fixture={...legacy,schema_version:version};const bytes=JSON.stringify(fixture);writeFileSync(taskPath,bytes,{mode:0o600});await start();
  const get=await http('GET',`/api/v1/tasks/${t.id}`);const retained=get.status===200&&get.data.id===t.id&&get.data.goal===legacy.tasks[0].goal&&JSON.stringify(get.data.history)===JSON.stringify(legacy.tasks[0].history);
  const edit=await http('PATCH',`/api/v1/tasks/${t.id}`,{expected_revision:get.data.expected_revision,patch:{goal:`Migrated version ${version}`}});const migrated=JSON.parse(readFileSync(taskPath,'utf8'));
  migrations&&=retained&&edit.status===200&&migrated.schema_version===3&&migrated.tasks.length===1&&JSON.stringify(migrated.tasks[0].history.slice(0,legacy.tasks[0].history.length))===JSON.stringify(legacy.tasks[0].history);loss+=retained?0:1;evidence.push({version,accepted_legacy:fixture,get,edit,migrated});
 }
 await stopDaemon();const newBytes=readFileSync(taskPath,'utf8');let downgrade='';try{await old.readTaskStore(taskPath);}catch(error){downgrade=(error as any).code;}
 migrations&&=downgrade==='unsupported_version'&&readFileSync(taskPath,'utf8')===newBytes;evidence.push({downgrade_code:downgrade,new_store_preserved:readFileSync(taskPath,'utf8')===newBytes});
 let visible=true,originals=true;
 for(const mode of ['truncated','duplicate','future']){
  const valid=JSON.parse(readFileSync(taskPath,'utf8'));const raw=mode==='truncated'?'{"schema_version":3,':JSON.stringify(mode==='duplicate'?{...valid,tasks:[...valid.tasks,valid.tasks[0]]}:{...valid,schema_version:999});
  const backup=storeApi.decodeTaskStore(readFileSync(taskPath+'.backup','utf8'));writeFileSync(taskPath,raw,{mode:0o600});await start();
  const read=await http('GET','/api/v1/tasks');const denied=await http('PATCH',`/api/v1/tasks/${t.id}`,{expected_revision:`${valid.recovery_epoch}:${valid.tasks[0].revision}`,patch:{goal:'Blocked mutation '+mode}});
  visible&&=read.status===503&&denied.status===503&&read.data.code===(mode==='future'?'unsupported_version':'corrupt');originals&&=readFileSync(taskPath,'utf8')===raw;
  const recovered=await http('POST','/api/v1/task_recover',{});const after=JSON.parse(readFileSync(taskPath,'utf8'));
  originals&&=recovered.status===200&&recovered.data.quarantined===true&&readdirSync(dirname(taskPath)).filter(p=>p.startsWith(basename(taskPath)+'.corrupt-')).some(p=>readFileSync(join(dirname(taskPath),p),'utf8')===raw);
  loss+=after.tasks.length===backup.tasks.length&&after.tasks.every((task:any)=>backup.tasks.some((b:any)=>b.id===task.id&&b.goal===task.goal&&JSON.stringify(b.history)===JSON.stringify(task.history)))?0:1;
  migrations&&=recovered.status===200&&recovered.data.changes_may_be_missing===true&&after.controls.execution_stopped&&after.tasks.every((task:any)=>!task.armed)&&after.recovery_epoch!==backup.recovery_epoch;
  evidence.push({mode,read,denied,recovered,backup,after});await stopDaemon();
 }
 await start();
 const source={id:'legacy-comparison-source',kind:'event',producer_actor:'fixture-owner',owner_domains:['personal'],sensitivity:'private',max_age_ms:600000,enabled:true};
 const registered=await http('POST','/api/v1/tasks/sources',source);
 const baseline=await http('POST','/api/v1/tasks',{...x.input('legacy-comparison'),schedule:{kind:'event',source_id:source.id,predicate:'equals',expected:'invented legacy baseline'},arm:false});
 const event={source_id:source.id,source_revision:0,dedup_key:'legacy-event',value:'invented legacy baseline',state_updated_at:Date.now()};const accepted=await http('POST','/api/v1/tasks/events',event);
 await stopDaemon();const legacyComparison=JSON.parse(readFileSync(taskPath,'utf8'));const sha=x.sourceApi.taskValueHash(event.value);const legacyTask=legacyComparison.tasks.find((t:any)=>t.id===baseline.data.id),legacyEvent=legacyComparison.events.find((e:any)=>e.id===accepted.data.event_id),legacySource=legacyComparison.sources.find((s:any)=>s.id===source.id);
 if(!legacyTask||!legacyEvent||!legacySource)throw new Error('legacy comparison fixture absent');legacyTask.schedule.expected_hash=sha;legacyTask.last_material_hash=sha;legacyEvent.value_hash=sha;legacySource.last_value_hash=sha;writeFileSync(taskPath,JSON.stringify(legacyComparison),{mode:0o600});writeFileSync(taskPath+'.backup',JSON.stringify(legacyComparison),{mode:0o600});await start();
 const migratedComparison=JSON.parse(readFileSync(taskPath,'utf8')),migratedBackup=JSON.parse(readFileSync(taskPath+'.backup','utf8'));const keyed=(s:any)=>{const t=s.tasks.find((v:any)=>v.id===baseline.data.id),e=s.events.find((v:any)=>v.id===accepted.data.event_id),sourceRow=s.sources.find((v:any)=>v.id===source.id);return t&&e&&sourceRow&&/^hmac-v1:[a-f0-9]{64}$/.test(t.schedule.expected_hash)&&t.schedule.expected_hash===e.value_hash&&e.value_hash===t.last_material_hash&&e.value_hash===sourceRow.last_value_hash;};
 const retry=await http('POST','/api/v1/tasks/events',event);const comparisonDrift=await http('POST','/api/v1/tasks/events',{...event,value:'different legacy value'});const comparisonPass=registered.status===200&&baseline.status===200&&accepted.status===200&&keyed(migratedComparison)&&keyed(migratedBackup)&&retry.status===200&&retry.data.event_id===accepted.data.event_id&&comparisonDrift.status===409;
 migrations&&=comparisonPass;evidence.push({legacy_comparison_migration:true,registered,baseline,accepted,legacyComparison,migratedComparison,migratedBackup,retry,comparisonDrift});
 originals&&=readFileSync(memory,'utf8')==='invented neighbour'&&readFileSync(drafts,'utf8')===draftSentinel;
 return {silent_loss:loss,corruption_visible:visible,originals_preserved:originals,supported_migrations_pass:migrations};
}
