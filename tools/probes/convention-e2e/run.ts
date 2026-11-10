/** #1090: production delivery → isolated native CLI generation → captured bytes.
 * This controlled bridge is not installed-native-hook certification. */
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Vault } from '@bastra-recall/core';
import { serve } from '../../../packages/daemon/__tests__/fixtures/rulebook-phase5/probe.js';
import { runSessionLane } from '../../../packages/daemon/src/session-lane.js';
import { runPromptLane } from '../../../packages/daemon/src/prompt-lane.js';
import { loadSessionState } from '../../../packages/daemon/src/session-state.js';
// @ts-expect-error plain ESM probe utilities are exercised independently by node:test
import { tasks, arithmeticRule, correspondenceRule } from './fixtures.mjs';
// @ts-expect-error plain ESM probe utilities are exercised independently by node:test
import { summarizeAttempts, judgeFixture, repairOnce } from './measurement.mjs';

const hash = (text:string|Buffer) => createHash('sha256').update(text).digest('hex');
const args = process.argv.slice(2), option = (key:string) => {const i=args.indexOf(key); return i < 0 ? undefined : args[i+1];};
const output=resolve(option('--report')??'/private/tmp/convention-e2e.json');
const authSource=option('--copy-codex-auth-from');
const codexModel=option('--codex-model')??'gpt-6.1-sol';
const hosts=[{name:'codex',model:codexModel},{name:'claude-code',model:'opus'}];
const timeoutMs=60000;
async function run(command:string, argv:string[], env:NodeJS.ProcessEnv, cwd:string, input='') {
 const start=performance.now();
 return new Promise<{exit:number|null;stdout:string;stderr:string;timed_out:boolean;duration_ms:number}>(done=>{
  const child=spawn(command,argv,{cwd,env,stdio:['pipe','pipe','pipe']}); let stdout='',stderr='',timed_out=false,settled=false;
  let hardTimer:ReturnType<typeof setTimeout>|undefined;
  const timer=setTimeout(()=>{timed_out=true;child.kill('SIGTERM');hardTimer=setTimeout(()=>child.kill('SIGKILL'),1000);},timeoutMs);
  const finish=(exit:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);if(hardTimer)clearTimeout(hardTimer);done({exit,stdout,stderr,timed_out,duration_ms:performance.now()-start});};
  child.stdout.on('data',b=>{if(stdout.length<1000000)stdout+=b;});child.stderr.on('data',b=>{if(stderr.length<100000)stderr+=b;});
  child.on('error',()=>finish(null));child.on('close',finish);child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
async function main(){
 if(!process.env.BASTRA_TEST_RUN_ROOT)throw Error('Use --import ./scripts/test-env.mjs; real user state is forbidden.');
 if(!process.argv.includes('--live-models'))throw Error('Explicit --live-models required; may consume the authenticated account quota.');
 const root=await mkdtemp(join(tmpdir(),'convention-e2e-')); await chmod(root,0o700);
 const vaultPath=join(root,'vault');await mkdir(vaultPath);
 const vault=new Vault(vaultPath);let live:Awaited<ReturnType<typeof serve>>|undefined;
 const rows:any[]=[],planned=hosts.flatMap(h=>tasks.map((t:any)=>`${h.name}:${t.id}`));
 const rubric_sha256=hash(JSON.stringify(tasks));
 const manifest:any={schema_version:1,scope:'synthetic controlled production-lane/native-CLI bridge',planned_attempt_ids:planned,rubric_sha256,
  no_native_hook_certification:true,model_selection:'Requested CLI identifiers are recorded; confirmed model is null unless emitted by the host.',rows};
 const persist=async()=>{manifest.summary=summarizeAttempts(rows,planned);await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(manifest,null,2)+'\n');};
 const seed=async(label:string)=>{
  for(const [id,body] of [['e2e-arithmetic',arithmeticRule(label)],['e2e-correspondence',correspondenceRule]]){
   await writeFile(join(vaultPath,id+'.md'),'---\n'+Object.entries({id,title:id,type:'lesson',scope:'all-projects',tags:['invented-fixture'],summary:'Invented E2E convention',recall_when:['When handling invented E2E tasks'],write_origin:'user-directed',rulebook:'always',applies_when:id==='e2e-arithmetic'?'When performing arithmetic':'When translating or drafting invented correspondence',created:'2026-01-01',updated:'2026-01-01'}).map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join('\n')+'\n---\n'+body+'\n');
  }
 };
 try{
  await seed('blue');await vault.init();live=await serve(vault);await persist();
  for(const host of hosts){
   const hostRoot=join(root,host.name);await mkdir(hostRoot);const home=join(hostRoot,'home');await mkdir(home);
   const config=join(home,host.name==='codex'?'.codex':'.claude');await mkdir(config,{mode:0o700});
   const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'en_US.UTF-8',TMPDIR:root,HOME:home,USERPROFILE:home,
    BASTRA_HOOK_STATE_DIR:join(root,'host-state'),BASTRA_DAEMON_URL:live.url,BASTRA_HTTP_PORT:String(new URL(live.url).port),BASTRA_LOG_PATH:join(root,'host-logs')};
   let copiedAuth=false;
   if(host.name==='codex'){
    env.CODEX_HOME=config;
    if(authSource){const stat=await lstat(authSource);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Auth source must be a regular file.');await writeFile(join(config,'auth.json'),await readFile(authSource),{mode:0o600});copiedAuth=true;}
    await writeFile(join(config,'config.toml'),'');
   }else{env.CLAUDE_CONFIG_DIR=config;env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';}
   const versionRun=await run(host.name==='codex'?'codex':'claude',['--version'],env,hostRoot);
   const version=versionRun.stdout.trim()||'unavailable';
   try{
    for(const task of tasks){
     await seed(task.label);for(const id of ['e2e-arithmetic','e2e-correspondence'])await vault.reindexFile(join(vaultPath,id+'.md'));
     const sid=`e2e-${host.name}-${task.id}`;
     const common={session_id:sid,cwd:hostRoot,bastra_client:host.name,bastra_codex_version:version.replace('codex-cli ','')};
     const startup=JSON.parse(await runSessionLane({...common,hook_event_name:'SessionStart',source:'startup'},live.url,undefined,async()=>null));
     const prompt=JSON.parse(await runPromptLane({...common,hook_event_name:'UserPromptSubmit',prompt:task.prompt},null,live.url,undefined,()=>[]));
     const loaded:any[]=[];
     for(const id of ['e2e-arithmetic','e2e-correspondence'])loaded.push(await live.post('/api/v1/load_memory',{id,session_id:sid},sid));
     await live.post('/api/v1/rulebook_check',{applicable:['e2e-arithmetic','e2e-correspondence'],session_id:sid},sid);
     const state=await loadSessionState(sid),rule=loaded.find(r=>r.id===(task.kind==='arithmetic'||task.kind==='rule-change'?'e2e-arithmetic':'e2e-correspondence'));
     const contexts=[startup.hookSpecificOutput?.additionalContext??'',prompt.hookSpecificOutput?.additionalContext??''];
     const input='This is an invented evaluation task. Use only the context below; do not use tools or read files. The controller has performed the rulebook check. No sending is requested.\n\n'+contexts.join('\n\n')+'\n\nFull rule loads:\n'+loaded.map(r=>JSON.stringify(r)).join('\n\n')+'\n\nUser task:\n'+task.prompt;
     const row:any={attempt_id:`${host.name}:${task.id}`,cluster_id:sid,host:{name:host.name,version},model:{requested:host.model,confirmed:null,effort:'medium'},
      rule:{id:rule.id,revision:rule.revision},task:{kind:task.kind,generation:task.generation,prompt:task.prompt,criteria:task.criteria},context_generation:hash(state.rulebookCheck??sid),
      delivery:{surface:'native CLI final assistant output',bridge_supplied_context_sha256:hash(contexts.join('\n')),bridge_supplied_context_bytes:Buffer.byteLength(contexts.join('\n')),full_model_input_bytes:Buffer.byteLength(input),full_model_input_sha256:hash(input),loaded:loaded.map(r=>({id:r.id,revision:r.revision})),native_hooks:false},
      first:{status:'unverified',reason:'pre-registered; generation not completed'},repaired:null};
     rows.push(row);await persist();
     const last=join(hostRoot,task.id+'.final.txt');
     const command=host.name==='codex'?'codex':'claude';
     const argv=host.name==='codex'?['exec','--cd',hostRoot,'--skip-git-repo-check','--sandbox','read-only','--ephemeral','--ignore-user-config','--ignore-rules','--json','--color','never','-m',host.model,'-c','model_reasoning_effort="medium"','-c','features.apps=false','-c','features.shell_tool=false','-o',last,'-']:
      ['--safe-mode','-p','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--disable-slash-commands','--no-session-persistence','--model',host.model,'--effort','medium','--output-format','json'];
     const generate=async(message:string)=>{
      await rm(last,{force:true});
      const result=await run(command,argv,env,hostRoot,message);let text:string|undefined;
     if(host.name==='codex')try{text=await readFile(last,'utf8');}catch{}
     else try{const body=JSON.parse(result.stdout);if(body.is_error!==true&&typeof body.result==='string')text=body.result;}catch{}
     const phase=text!==undefined&&text.length?{...judgeFixture(task.kind,text,task.label),text,sha256:hash(text)}:
       {status:result.exit===0?'unverified':'blocked',reason:result.timed_out?'native CLI deadline exceeded':'native CLI produced no final assistant bytes'};
      return {phase,result};
     };
     const {phase,result}=await generate(input);
     row.first=phase;row.duration_ms=result.duration_ms;row.exit=result.exit;row.timed_out=result.timed_out;
     await repairOnce(row,async()=>{
      const next=await generate(input+'\n\nThe first actual output failed the exact fixture oracle. Correct it under the same task/generation and current rule revision. Return only the requested final deliverable.\nFirst output:\n'+row.first.text);
      return {...next.phase,duration_ms:next.result.duration_ms,exit:next.result.exit};
     });
     row.native_event_types=result.stdout.split('\n').flatMap(line=>{try{const value=JSON.parse(line);return typeof value.type==='string'?[value.type]:[];}catch{return [];}});
     // Keep raw provider/auth diagnostics out of publishable output. Synthetic final bytes are retained above.
     row.diagnostic={stderr_bytes:Buffer.byteLength(result.stderr),stdout_bytes:Buffer.byteLength(result.stdout)};
     await persist();console.log(JSON.stringify({attempt:row.attempt_id,status:row.first.status,exit:row.exit,duration_ms:Math.round(row.duration_ms)}));
    }
   }finally{if(copiedAuth)await rm(join(config,'auth.json'),{force:true});}
  }
  manifest.all_planned_attempts_present=planned.every(id=>rows.some(r=>r.attempt_id===id));await persist();
 }finally{await live?.close();await vault.stop();await rm(root,{recursive:true,force:true});}
}
await main();
