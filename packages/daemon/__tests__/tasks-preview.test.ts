import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tasksEnabled } from '../src/tasks-enabled.js';
import { ALL_TOOL_DEFS, filterToolDefsForSurface, isToolAllowed } from '../src/tool-defs.js';
import { ensureLocalTaskAgent, taskAgentAccessStatus } from '../src/task-auto-setup.js';
import { taskClientToken } from '../src/task-client-auth.js';
import { taskAttachment } from '../src/task-delivery.js';

test('preview defaults off; only explicit opt-in enables it', () => {
  for (const value of [undefined,'','0','false','true','invalid']) assert.equal(tasksEnabled({BASTRA_TASKS:value}),false);
  assert.equal(tasksEnabled({BASTRA_TASKS:'1'}),true);
  assert.ok(!ALL_TOOL_DEFS.some(t=>t.name.startsWith('task_')));
  for (const surface of ['search','write','full'] as const) {
    assert.equal(isToolAllowed('task_create',surface),false);
    assert.deepEqual(filterToolDefsForSurface([{name:'recall'},{name:'task_create'}],surface),[{name:'recall'}]);
  }
});

test('disabled access and passive cards never touch existing credentials/data', async () => {
  assert.equal(taskClientToken('/path/that/must/not/be/read'),undefined);
  assert.deepEqual(await ensureLocalTaskAgent(),{configured:false,reason:'disabled'});
  assert.equal((await taskAgentAccessStatus()).reason,'disabled');
  assert.equal(await taskAttachment({path:'/absent/tasks.json',authPath:'/absent/auth.json'},'Bearer old-token','test','http'),undefined);
});

for (const existing of [false,true]) test(`real default daemon: zero task I/O/timers, routes hidden, existing data preserved (${existing})`, async () => {
  const root=await mkdtemp(join(tmpdir(),'tasks-preview-')),data=join(root,'data'),vault=join(root,'vault'),audit=join(root,'audit.jsonl');
  await mkdir(vault); await mkdir(data); await writeFile(audit,'');
  const names=['tasks.json','task-auth.json','task-hook-token.json','task-approval-keys.json'];
  if(existing) for(const name of names) await writeFile(join(data,name),`untouched existing ${name}\n`);
  const reservation=createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
  const port=(reservation.address() as {port:number}).port; await new Promise<void>(r=>reservation.close(()=>r())); assert.notEqual(port,6723);
  const base=`http://127.0.0.1:${port}`;
  const env={...process.env,BASTRA_TASKS:'0',BASTRA_VAULT_PATH:vault,BASTRA_TASKS_PATH:join(data,'tasks.json'),BASTRA_HTTP_PORT:String(port),BASTRA_DAEMON_URL:base,BASTRA_AUTO_UPDATE:'0',BASTRA_EMBEDDING_PROVIDER:'none',BASTRA_BM25_ONLY:'1',TASK_DATA_ROOT:data,TASK_AUDIT:audit};
  // Test the actual unset default rather than the explicit kill switch.
  delete (env as NodeJS.ProcessEnv).BASTRA_TASKS;
  const child=spawn(process.execPath,['--import',fileURLToPath(new URL('./fixtures/tasks-off-guard.mjs',import.meta.url)),fileURLToPath(new URL('../dist/index.js',import.meta.url))],{env,stdio:['pipe','ignore','pipe']});
  let errors='';child.stderr!.on('data',c=>{errors=(errors+c).slice(-6000);});const closed=once(child,'close');
  try {
    let ready=false;const end=Date.now()+15000;
    while(Date.now()<end){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,25));}
    assert.ok(ready,errors);
    const tools=await (await fetch(base+'/tools')).json() as any;
    assert.ok(!JSON.stringify(tools).includes('task_create'));
    for(const route of ['/api/v1/tasks','/api/v1/task_list','/ui/tasks/session','/ui/tasks/logout','/ui/tasks/api/task_list']) {
      const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      assert.equal(response.status,404,route);assert.equal((await response.json() as any).code,'feature_disabled');
    }
    const session=await fetch(base+'/hook/session-context');
    assert.equal(session.status,200);assert.ok(!(await session.text()).includes('bastra-due'));
    // CLI must short-circuit before credential prompts, reads or network access.
    const cli=spawn(process.execPath,[fileURLToPath(new URL('../dist/cli.js',import.meta.url)),'tasks','setup-hooks','--json'],{env,stdio:['ignore','pipe','pipe']});
    let output='';cli.stdout.on('data',c=>{output+=c;});assert.equal((await once(cli,'close'))[0],0);
    assert.equal(JSON.parse(output).code,'feature_disabled');assert.match(output,/BASTRA_TASKS=1/);
    await new Promise(r=>setTimeout(r,100));
  } finally {child.kill('SIGTERM');await closed;}
  assert.equal(await readFile(audit,'utf8'),'','default start must do no task I/O or task timers');
  assert.deepEqual((await readdir(data)).sort(),existing?[...names].sort():[]);
  if(existing) for(const name of names) assert.equal(await readFile(join(data,name),'utf8'),`untouched existing ${name}\n`);
});

test('served UI hides Tasks by default and restores the same tab with opt-in', async () => {
  const { createServer }=await import('node:http');
  const { handleWebUi, resolveWebUiDir }=await import('../src/webui.js');
  const root=await mkdtemp(join(tmpdir(),'tasks-ui-preview-')),settings=join(root,'settings.json');
  await writeFile(settings,JSON.stringify({ui:{enabled:true}}));
  const server=createServer((req,res)=>{void handleWebUi(req,res,req.url!,resolveWebUiDir(),settings);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,previous=process.env.BASTRA_TASKS;
  try {
    for(const enabled of [false,true]) {
      if(enabled) process.env.BASTRA_TASKS='1'; else delete process.env.BASTRA_TASKS;
      for(const path of ['/ui/','/ui/index.html']) {
        const response=await fetch(base+path),html=await response.text();
        assert.equal(response.status,200);assert.match(html,new RegExp(`data-tasks-enabled="${enabled}"`));
        assert.equal(/data-view="tasks" hidden/.test(html),!enabled);
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.equal(Number(response.headers.get('content-length')),Buffer.byteLength(html));
      }
    }
  } finally {if(previous===undefined) delete process.env.BASTRA_TASKS;else process.env.BASTRA_TASKS=previous;await new Promise<void>(r=>server.close(()=>r()));}
});

test('one opt-in restores the canonical tools on write/full surfaces', async () => {
  const moduleUrl=new URL('../dist/tool-defs.js',import.meta.url).href;
  const script=`import {ALL_TOOL_DEFS,filterToolDefsForSurface} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(Object.fromEntries(['search','write','full'].map(s=>[s,filterToolDefsForSurface(ALL_TOOL_DEFS,s).filter(t=>t.name.startsWith('task_')).map(t=>t.name)]))));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,BASTRA_TASKS:'1'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',c=>{output+=c;});assert.equal((await once(child,'close'))[0],0);
  const tools=JSON.parse(output);assert.deepEqual(tools.search,[]);assert.ok(tools.write.includes('task_create'));assert.deepEqual(tools.write,tools.full);
});

test('standalone MCP registration and guessed calls follow the preview switch', async () => {
  const { Client }=await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport }=await import('@modelcontextprotocol/sdk/client/stdio.js');
  for(const enabled of [false,true]) {
    const root=await mkdtemp(join(tmpdir(),'tasks-mcp-preview-')),vault=join(root,'vault');await mkdir(vault);
    const env=Object.fromEntries(Object.entries({...process.env,BASTRA_TASKS:enabled?'1':'0',BASTRA_HTTP:'off',BASTRA_VAULT_PATH:vault,BASTRA_TASKS_PATH:join(root,'data','tasks.json'),BASTRA_AUTO_UPDATE:'0',BASTRA_EMBEDDING_PROVIDER:'none',BASTRA_BM25_ONLY:'1',BASTRA_VAULT_RECONCILE_MS:'0'}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env,stderr:'ignore'});
    const client=new Client({name:'preview-test',version:'1.0.0'});
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.some(t=>t.name==='task_create'),enabled);
      if(!enabled) {
        const result=await client.callTool({name:'task_create',arguments:{}});
        assert.equal(result.isError,true);assert.match(JSON.stringify(result),/preview disabled/);
      }
    } finally {await client.close();}
  }
});
