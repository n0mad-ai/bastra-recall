import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Vault, SearchIndex} from '@bastra-recall/core';
import {startHttpServer} from '../../../src/http.js';
import {Telemetry} from '../../../src/telemetry.js';
import {addFloor} from '../../../src/floors.js';
import {cachedRulebookCatalog} from '../../../src/rulebook-catalog.js';
import {runSessionLane} from '../../../src/session-lane.js';
import {runPromptLane} from '../../../src/prompt-lane.js';
import {runGateLane} from '../../../src/gate-lane.js';
import {runStopLane} from '../../../src/stop-lane.js';
import {taskValidators} from '../../../src/task-validators.js';
import {roundCorrespondence} from '../../../src/rulebook-check.js';
import {vaultConventionOf} from '../../../src/convention-source.js';
import {loadSessionState} from '../../../src/session-state.js';
import {githubConventionGate} from '../../../src/github-conventions-lane.js';
import {setPrimaryLanguage} from '../../../src/settings.js';
import {inventedRules, languages, type Language} from './fixtures.js';

export type Row = {language: string; client: string; case: string; status: 'PASS'|'GAP'|'FAIL'; detail: string};
export type ProbeResult = {rows: Row[]; rules: number; duration_ms: number; costs:{honestRounds:number;checks:number;stopBlocks:number;repairs:number;payloadBytes:number;ignoredHarmlessBlocks:number}};
const clients = ['claude-code', 'codex'] as const;
const common = (sid: string, client = 'claude-code') => ({session_id:sid, bastra_client:client, bastra_codex_version:'0.162.1', cwd:'/tmp'});
const parse = (s: string) => JSON.parse(s);
const denied = (out: any) => out.hookSpecificOutput?.permissionDecision === 'deny';
const context = (out: any): string => out.hookSpecificOutput?.additionalContext ?? '';

/** Uses production HTTP routes/search/lanes; never registers a file watcher. */
export async function serve(vault: Vault) {
  const search = new SearchIndex(vault); search.start();
  const telemetry = new Telemetry();
  const deps = {vault, search, telemetry, vaultPath:vault.root};
  const http = await startHttpServer({port:0, ...deps, version:'phase5-probe', toolDeps:deps,
    documentWriteEnabled:false, embedding:{on:false, providerId:null, source:'none'}});
  const url = `http://127.0.0.1:${http.port}`;
  const post = async (path:string, body:unknown, sid?:string) => {
    const response = await fetch(url+path, {method:'POST', headers:{'content-type':'application/json',
      ...(sid ? {'x-bastra-cc-session':sid} : {})}, body:JSON.stringify(body), signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200,`${path}: ${await response.clone().text()}`);
    return response.json() as Promise<any>;
  };
  return {url, post, deps, close:async()=>{await http.close(); search.stop();}};
}

/** Old source/channel fixtures explicitly dismiss other isolated fixture rules.
 * The correspondence-declaration probes deliberately do not use this helper. */
export async function declareUnrelatedCorrespondence(live:Awaited<ReturnType<typeof serve>>,sid:string){
 const state=await loadSessionState(sid),catalog=await cachedRulebookCatalog(live.deps.vault,{project:null,active:state.activeConventions??[]});
 const ids=new Set(roundCorrespondence(state).rules.map(r=>r.id));
 const result=await live.post('/api/v1/rulebook_check',{session_id:sid,applicable:catalog.entries.filter(e=>ids.has(e.id)).map(e=>e.id),not_applicable:catalog.entries.filter(e=>(e.validator||e.rule_categories?.includes('correspondence'))&&!ids.has(e.id)).map(e=>({id:e.id,reason:'This rule belongs to a different isolated fixture; only this session’s loaded rules apply.'}))},sid);
 assert.equal(result.ok,true,JSON.stringify(result));
}

async function seed() {
  const root = await mkdtemp(join(tmpdir(),'rulebook-phase5-'));
  const path = join(root,'vault'); await mkdir(path);
  for (const {fm,body} of inventedRules()) {
    await writeFile(join(path,`${fm.id}.md`),`---\n${Object.entries(fm).map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n${body}\n`);
  }
  // Floors are per-user registry entries, not invented frontmatter properties.
  for (const lang of Object.keys(languages)) await addFloor({memory_id:`p5-${lang}-floor`,condition:`p5-${lang}`,reason:'Invented floor'});
  const vault = new Vault(path); await vault.init();
  return {root,vault};
}

export async function runProbe(): Promise<ProbeResult> {
  assert.ok(process.env.BASTRA_TEST_RUN_ROOT,'Run with --import ./scripts/test-env.mjs; installed user settings/hooks are forbidden.');
  const started = performance.now();
  const f = await seed(); const server = await serve(f.vault);
  await setPrimaryLanguage('en');
  const rows: Row[] = [];
  const costs={honestRounds:0,checks:0,stopBlocks:0,repairs:0,payloadBytes:0,ignoredHarmlessBlocks:0};
  const kernel = (active: readonly import('../../../src/session-state.js').ActiveConvention[] = [], project: string|null = null, mode?: 'ids'|'content') => cachedRulebookCatalog(f.vault,{project,active,mode});
  const catalog = await kernel(); assert.equal(catalog.entries.length,125);
  const correspondenceIds=catalog.entries.filter(e=>e.validator||e.rule_categories?.includes("correspondence")).map(e=>e.id);
  assert.equal(catalog.entries.filter(e=>e.rulebook==='always').length,10);
  const gate = async (sid:string, client:string, name='Write', input={}) => parse(await runGateLane({...common(sid,client), hook_event_name:'PreToolUse',tool_name:name,tool_input:input},{reflexPool:()=>[],kernel}));
  const prompt = async (sid:string, client:string, text:string) => parse(await runPromptLane({...common(sid,client), hook_event_name:'UserPromptSubmit',prompt:text},null,server.url,undefined,()=>[],{kernel}));
  const stop = async (sid:string,client:string,text:string,active=false) => parse(await runStopLane({...common(sid,client),hook_event_name:'Stop',stop_hook_active:active,transcript:[{role:'assistant',content:text}]},server.url,{kernel,conventionOf:vaultConventionOf(f.vault)}));
  const load = (sid:string,id:string) => server.post('/api/v1/load_memory',{id,session_id:sid},sid);
  const check = (sid:string,input:object) => server.post('/api/v1/rulebook_check',{...input,session_id:sid},sid);
  const declare=(sid:string,applicable:string[]=[],extra:object={})=>check(sid,{applicable,not_applicable:correspondenceIds.filter(id=>!applicable.includes(id)).map(id=>({id,reason:'This fixture round is outside this rule’s correspondence scope.'})),...extra});
  const attempt = async (language:string,client:string,name:string,fn:()=>Promise<string|void>,gap=false) => {
    try {const detail=await fn(); rows.push({language,client,case:name,status:gap?'GAP':'PASS',detail:detail??'Verified'});}
    catch(error) {rows.push({language,client,case:name,status:'FAIL',detail:String(error)});}
  };
  try {
    for(const client of clients) {
      // All languages coexist, so size/budget pressure is real, not five tiny catalogs.
      for (const source of ['startup','resume','clear','compact','fork'] as const) {
        const sid=source==='fork'?`delivery-fork-${client}`:`delivery-${client}`;
        const out=parse(await runSessionLane({...common(sid,client),hook_event_name:'SessionStart',source},server.url,undefined,async()=>null));
        const ctx=context(out);
        for(const lang of Object.keys(languages) as Language[]) await attempt(lang,client,`delivery-${source}`,async()=>{
          assert.ok(ctx.length>0&&ctx.length<10000,`context size ${ctx.length}`);
          for(const kind of ['always','floor']) assert.ok(ctx.includes(`COMPLETE_${lang}_${kind}`),`missing full ${lang} ${kind}`);
          assert.match(ctx,/list_rules/,'large index must announce pagination');
          const ids:string[]=[]; let cursor: string|undefined; const cursors=new Set<string>();
          do {
            const page=await server.post('/api/v1/list_rules',{...(cursor?{cursor}:{})});
            assert.equal(page.total,125); ids.push(...page.rules.map((r:any)=>r.id));
            for(const rule of page.rules.filter((r:any)=>r.id.startsWith(`p5-${lang}-`))) {
              assert.ok(rule.title&&rule.applies_when,`index description ${rule.id}`);
            }
            cursor=page.next_cursor;
            if(cursor){assert.ok(!cursors.has(cursor));cursors.add(cursor);}
            else assert.equal(page.end,true);
            assert.ok(cursors.size<20,'pagination must terminate');
          }while(cursor);
          assert.equal(new Set(ids).size,125);assert.equal(ids.length,125);
          for(const {fm} of inventedRules()) assert.ok(ids.includes(fm.id));
          return '10 whole always/floor bodies; all 125 IDs/descriptions via production list_rules, explicit end; hook <10k chars';
        });
      }
      for (const [lang,t] of Object.entries(languages) as [Language,typeof languages[Language]][]) {
        await attempt(lang,client,'read-write-boundary',async()=>{
          const sid=`boundary-${client}-${lang}`; await prompt(sid,client,t.question);
          for(const [name,input] of [['Read',{}],['Grep',{}],['Bash',{command:'git status --short'}],['exec_command',{cmd:'rg fixture src'}],['mcp__bastra_recall__list_rules',{}]] as const)
            assert.equal(denied(await gate(sid,client,name,input)),false,name);
          for(const [i,name] of ['Write','apply_patch','mcp__bastra_recall__save_memory','mcp__mail__send'].entries()){
            const own=sid+i;assert.equal(denied(await gate(own,client,name)),true,name);
            assert.equal((await check(own,{applicable:[]})).ok,true);
            assert.equal(denied(await gate(own,client,name)),false,name);
          }
        });
        await attempt(lang,client,'context-proof-isolation',async()=>{
          const sid=`context-${client}-${lang}`;
          await check(sid,{applicable:[]});assert.equal(denied(await gate(sid,client)),false);
          for(const source of ['compact','clear'] as const){
            const out=parse(await runSessionLane({...common(sid,client),hook_event_name:'SessionStart',source},server.url,undefined,async()=>null));
            assert.ok(context(out).includes(`COMPLETE_${lang}_always`));
            assert.equal(denied(await gate(sid,client)),true,'previous context proof must expire');
            await check(sid,{applicable:[]});assert.equal(denied(await gate(sid,client)),false);
          }
          const worker=await runGateLane({...common(sid,client),agent_id:'invented-worker',hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{}},{reflexPool:()=>[],kernel});
          assert.equal(denied(parse(worker)),true,'worker cannot inherit parent proof');
          assert.equal(denied(await gate(sid+'-fork',client)),true,'fork cannot inherit parent proof');
        });
        await attempt(lang,client,'github-required-ids',async()=>{
          const sid=`github-${client}-${lang}`;
          const p={...common(sid,client),hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'gh issue create --title fixture'}};
          await check(sid,{applicable:[]});
          let out=parse((await githubConventionGate(p,server.url,Date.now()+3000))??'{}');
          assert.equal(denied(out),true);
          for(const l of Object.keys(languages)) assert.ok(JSON.stringify(out).includes(`p5-${l}-github`));
          assert.equal((await check(sid,{applicable:[]})).ok,true);
          assert.equal(denied(await gate(sid,client)),true,'empty applicability cannot discharge required IDs');
          const actor=JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors.find((a:any)=>a.key==='main');
          assert.equal(actor.required.length,5);
          // Verify real full loads remove each required ID, with a fresh denial budget.
          await prompt(sid,client,t.github);
          for(const l of Object.keys(languages)) await load(sid,`p5-${l}-github`);
          assert.equal(denied(await gate(sid,client)),false);
          assert.equal(JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors[0].required.length,0);
        });
        await attempt(lang,client,'ignored-checks-bounded',async()=>{
          const sid=`ignore-${client}-${lang}`;await prompt(sid,client,t.coding);
          const actions=[];for(let i=0;i<5;i++)actions.push(await gate(sid,client));
          assert.deepEqual(actions.map(denied),[true,true,false,false,false]);
          const stops=[];for(let i=0;i<4;i++)stops.push(await stop(sid,client,'42',i>0));
          assert.deepEqual(stops.map(s=>s.decision==='block'),[true,false,false,false]);
          assert.match(context(await prompt(sid,client,t.ok)),/unchecked boundary|ungeprüft/);
          assert.doesNotMatch(context(await prompt(sid,client,t.ok)),/unchecked boundary|ungeprüft/);
          return 'Scripted noncompliant agent: exactly 2 action denials and 1 rulebook Stop block; next-prompt violation, delivered once';
        });
        await attempt(lang,client,'correspondence-load-path',async()=>{
          const sid=`reply-load-${client}-${lang}`;
          assert.match(context(await prompt(sid,client,t.incoming)),/125.*index|125.*Index/);
          assert.equal((await stop(sid,client,t.draft)).decision,'block');
          // A fresh round restores the full Stop budget. Removing the actual
          // load below must make the first Stop block, not pass a retry guard.
          await prompt(sid,client,t.incoming);
          await load(sid,`p5-${lang}-correspondence`);
          assert.equal((await declare(sid,[`p5-${lang}-correspondence`])).ok,true);
          assert.notEqual((await stop(sid,client,t.draft)).decision,'block');
        });
        await attempt(lang,client,'correspondence-empty-check-bypass',async()=>{
          const sid=`reply-bypass-${client}-${lang}`;await prompt(sid,client,t.incoming);
          assert.equal((await check(sid,{applicable:[]})).ok,true);
          const out=await stop(sid,client,t.draft);assert.equal(out.decision,'block');
          for(const id of correspondenceIds)assert.ok(out.reason.includes(id));
          assert.notEqual((await stop(sid,client,t.draft,true)).decision,'block');
          assert.equal((await declare(sid)).ok,true,'explicit per-ID non-applicability is allowed and audited');
          assert.notEqual((await stop(sid,client,t.draft,true)).decision,'block');
          return 'Empty applicability cannot silently skip correspondence IDs: one block, then bounded unchecked passage; explicit per-ID exceptions remain possible, not semantic proof';
        });
        await attempt(lang,client,'task-omission',async()=>{
          const variants=[t.draft.repeat(150),`\x60\x60\x60text\n${t.draft.repeat(150)}\n\x60\x60\x60`,`> ${t.draft.repeat(150)}`];
          for(const [i,text]of variants.entries()){
            assert.ok(text.length>2000);
            const sid=`omit-${client}-${lang}-${i}`;await prompt(sid,client,t.incoming);await load(sid,`p5-${lang}-correspondence`);
            assert.equal((await declare(sid,[`p5-${lang}-correspondence`])).ok,true);
            assert.equal((await loadSessionState(sid)).activeTask,undefined);
            const out=await stop(sid,client,text);
            assert.notEqual(out.decision,'block');
            assert.equal(JSON.stringify(out).includes('<copy-repair'),client==='claude-code');
            if(client==='codex')assert.equal(JSON.parse((await loadSessionState(sid)).rulebookCheck!).copyViolations,1);
            assert.equal((await loadSessionState(sid)).activeTask,undefined,'no invented task or approval');
          }
          return client==='claude-code'?'All 3 oversized forms request repair without any task report':'All 3 oversized forms record a violation without a task report; Codex same-turn repair remains disabled';
        });
        await attempt(lang,client,'task-before-load',async()=>{
          const sid=`task-first-${client}-${lang}`;await prompt(sid,client,t.incoming);
          assert.equal((await check(sid,{applicable:[],task:'draft-for-review'})).ok,true);
          await load(sid,`p5-${lang}-correspondence`);
          assert.equal((await declare(sid,[`p5-${lang}-correspondence`])).ok,true);
          assert.ok((await loadSessionState(sid)).loadedConventions?.some(c=>c.id===`p5-${lang}-correspondence`&&c.validator?.limit===2000));
          assert.ok(taskValidators(await loadSessionState(sid)).some(c=>c.validator.limit===2000&&c.validator.channel==='discord-dm'));
          const out=await stop(sid,client,t.draft.repeat(150));
          assert.equal(JSON.stringify(out).includes('<copy-repair'),client==='claude-code');
          return client==='claude-code'?'Late load activates repair on real Stop lane':'Codex repair unsupported; actual loaded ID and selected constraint verified';
        });
        await attempt(lang,client,'honest-single-check',async()=>{
          for(const [i,text]of [t.question,t.calculation,t.ok,t.code,t.translation].entries()){
            const sid=`honest-${client}-${lang}-${i}`;await prompt(sid,client,text);
            const input={applicable:[],not_applicable:correspondenceIds.map(id=>({id,reason:'This harmless round does not prepare correspondence.'}))};
            const response=await check(sid,input);costs.checks++;costs.payloadBytes+=Buffer.byteLength(JSON.stringify({...input,session_id:sid}));
            assert.equal(response.ok,true);const out=await stop(sid,client,'42');
            costs.honestRounds++;if(out.decision==='block')costs.stopBlocks++;if(JSON.stringify(out).includes('<copy-repair'))costs.repairs++;
            assert.notEqual(out.decision,'block');assert.ok(!JSON.stringify(out).includes('<copy-repair'));
            assert.notEqual((await loadSessionState(sid)).activeTask?.kind,'approved-copy');
          }
          return '5 harmless rounds including translation/code: one explicit check per round, no Stop blocks and no copy repairs';
        });
        await attempt(lang,client,'harmless-prompts',async()=>{
          for(const [i,text]of [t.question,t.calculation,t.ok,t.code].entries()){
            const sid=`harmless-${client}-${lang}-${i}`;await prompt(sid,client,text);
            assert.equal(denied(await gate(sid,client,'Read')),false);
            assert.equal((await stop(sid,client,'42')).decision,'block','one explicit correspondence check expected');costs.ignoredHarmlessBlocks++;
            assert.notEqual((await stop(sid,client,'42',true)).decision,'block');
            assert.equal((await declare(sid)).ok,true);
            assert.notEqual((await stop(sid,client,'42')).decision,'block');
            const state=await loadSessionState(sid);assert.equal(state.activeTask,undefined);assert.equal(state.receipts,undefined);
            assert.equal(state.repairAttempts,undefined);
            assert.equal((await check(sid,{applicable:[],task:'approved-copy'})).ok,false,'model cannot fabricate user approval');
            assert.equal((await loadSessionState(sid)).activeTask,undefined);
          }
          return '4 benign prompts: reads pass; at most one generic rulebook Stop; no task, approval or validator receipt fabricated';
        });
      }
    }
    // Real HTTP transport outage: kill only this disposable server, then restart it.
    for(const client of clients) await attempt('all',client,'autonomous-outage-reset',async()=>{
      let live=await serve(f.vault);
      const sid=`autonomous-${client}`;
      try {
        for(let round=0;round<6;round++){
          const p={...common(sid,client),hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{file_path:'/tmp/invented-only'}};
          if(round===2){
            const deadUrl=live.url;await live.close();
            const output=await hookProcess(deadUrl,p);assert.equal(output.code,0);assert.deepEqual(parse(output.stdout),{});
            live=await serve(f.vault);
          }
          if(round===3){
            const restored=parse(await runSessionLane({...common(sid,client),hook_event_name:'SessionStart',source:'compact'},live.url,undefined,async()=>null));
            assert.ok(context(restored).includes('COMPLETE_ja_always'));
            assert.equal(denied(await live.post('/hook/gate',{payload:p})),true,'compact invalidates prior check');
          }
          const roundLanguage=Object.values(languages)[round%5];
          const notice=await live.post('/hook/prompt',{payload:{...common(sid,client),hook_event_name:'UserPromptSubmit',prompt:roundLanguage.calculation}});
          if(round===2)assert.match(context(notice),/unchecked boundary|ungeprüft/,'real hook failure spool must surface on recovery');
          const first=await live.post('/hook/gate',{payload:p});assert.equal(denied(first),true);
          assert.equal((await live.post('/api/v1/rulebook_check',{applicable:[],not_applicable:correspondenceIds.map(id=>({id,reason:'This calculation round does not prepare correspondence.'})),session_id:sid},sid)).ok,true);
          assert.equal(denied(await live.post('/hook/gate',{payload:p})),false);
          const answer=await live.post('/hook/stop',{payload:{...common(sid,client),hook_event_name:'Stop',transcript:[{role:'assistant',content:'42'}]}});
          assert.notEqual(answer.decision,'block');
        }
      }finally{await live.close();}
      return '6 scripted rounds, real thin-client failure exits 0, recovery notice, context reset, continued HTTP tools/answers without user input';
    });
  } finally {await server.close();await f.vault.stop();await rm(f.root,{recursive:true,force:true});}
  return {rows,rules:125,duration_ms:performance.now()-started,costs};
}

function hookProcess(url:string,payload:object):Promise<{code:number|null;stdout:string}> {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../../../src/gate-hook.ts',import.meta.url))],{
      cwd:process.cwd(),env:{...process.env,BASTRA_DAEMON_URL:url,BASTRA_HOOK_TIMEOUT_MS:'1500'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('thin client hung: '+stderr));},5000);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout});});child.stdin.end(JSON.stringify(payload));
  });
}

/** Read-only vault index; all state, logs and settings remain in the isolated test home. */
export async function measureLatency(vaultPath:string, rounds=20) {
  assert.ok(process.env.BASTRA_TEST_RUN_ROOT);
  const vault=new Vault(vaultPath);await vault.init();
  const live=await serve(vault);
  const samples: Record<string,number[]>={gate:[],prompt:[],stop:[]};
  const responses:Record<string,Record<string,number>>={gate:{},prompt:{},stop:{}};
  const collect=async(name:string,path:string,payload:object,measured:boolean)=>{
    const start=performance.now();const out=await live.post(path,{payload});
    if(measured){samples[name].push(performance.now()-start);const kind=denied(out)?'deny':out.decision==='block'?'block':'pass';responses[name][kind]=(responses[name][kind]??0)+1;}
  };
  try {
    // Four independent sessions concurrently; two warmup rounds excluded.
    await Promise.all(Array.from({length:4},async(_,i)=>{
      const p=common(`latency-${i}`);
      for(let r=-2;r<rounds;r++){
        await collect('prompt','/hook/prompt',{...p,hook_event_name:'UserPromptSubmit',prompt:'17 + 25'},r>=0);
        await collect('gate','/hook/gate',{...p,hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{}},r>=0);
        await collect('stop','/hook/stop',{...p,hook_event_name:'Stop',stop_hook_active:false,transcript:[{role:'assistant',content:'42'}]},r>=0);
      }
    }));
    return {memories:vault.size(),sessions:4,rounds,warmup:2,mode:'production HTTP lanes, lexical search, embeddings off, isolated settings, default real-vault scope (all-projects/user-preference), no watchers; index initialization excluded',
      lanes:Object.fromEntries(Object.entries(samples).map(([name,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [name,{n:values.length,median_ms:(sorted[(sorted.length-1)>>1]+sorted[sorted.length>>1])/2,p95_ms:sorted[Math.ceil(sorted.length*.95)-1],responses:responses[name],samples_ms:values}];}))};
  }finally{await live.close();await vault.stop();}
}
