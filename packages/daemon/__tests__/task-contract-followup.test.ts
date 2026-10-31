/** Trivial prompt delivery retains explicit state without recall or extra searches. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runPromptLane} from '../src/prompt-lane.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {sessionBudget} from '../src/session-budget.js';
let root='',base='',requests=0;const saved=new Map<string,string|undefined>();
const server=createServer((req,res)=>{requests++;req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end('{"hits":[],"score_kind":"rrf"}');});});
before(async()=>{root=await mkdtemp(join(tmpdir(),'task-followup-'));for(const [key,value]of Object.entries({BASTRA_HOOK_STATE_DIR:join(root,'state'),BASTRA_LOG_PATH:join(root,'logs'),BASTRA_TELEMETRY:'off',BASTRA_PROMPT_HOOK_MODE:'all'})){saved.set(key,process.env[key]);process.env[key]=value;}await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));for(const [key,value]of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});});
const prompt=(sid:string,text:string)=>runPromptLane({hook_event_name:'UserPromptSubmit',session_id:sid,prompt:text,cwd:root},null,base);
test('short text with no reported task cannot create one and performs no searches',async()=>{
 const before=requests;for(const text of ['ok','👍','ja']){assert.equal(await prompt('empty',text),'{}');assert.equal((await loadSessionState('empty')).activeTask,undefined);}assert.equal(requests,before);
});
test('trivial prompt renders reported stage and charges only the emitted block',async()=>{
 const sid='reported';await mutateSessionState(sid,s=>{s.activeTask={id:sid,kind:'approved-copy',since:1,generation:0};s.activeConventions=[{id:'rule',revision:'r1',scope:'task',setAt:1}];});
 const before=requests,spent=sessionBudget.spent(sid);const raw=await prompt(sid,'ok');const block=JSON.parse(raw).hookSpecificOutput.additionalContext;
 assert.match(block,/task="approved-copy"/);assert.equal(requests,before);assert.equal(sessionBudget.spent(sid)-spent,Math.ceil(block.length/4));assert.equal((await loadSessionState(sid)).activeTask?.kind,'approved-copy');
});
