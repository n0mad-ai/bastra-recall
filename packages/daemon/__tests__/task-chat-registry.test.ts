import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { registerChatHook, latestChatTarget, refreshChatRegistry, validateChatTarget } from '../src/task-chat-registry.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'chat-registry-'));
  const socket = join(root, 'inbox.sock'); const transcript = join(root, 'transcript.jsonl');
  await writeFile(transcript, '');
  const server = createServer(s => s.end()); server.listen(socket); await once(server, 'listening');
  t.after(() => new Promise<void>(r => server.close(() => r())));
  return {root, socket, transcript, dir:join(root,'registry'), now:Date.now()};
}
const human = (at:number) => JSON.stringify({type:'user',timestamp:new Date(at).toISOString(),origin:{kind:'human'},turnOrigin:'human',promptSource:'typed',message:{role:'user',content:'any language'}})+'\n';

test('only new proven human turns count; peer traffic and partial records do not', async t => {
  const f = await fixture(t); await writeFile(f.transcript, human(f.now-1000));
  await registerChatHook({hook_event_name:'SessionStart',session_id:'a',transcript_path:f.transcript,bastra_client:'claude-code'}, {CLAUDE_CODE_MESSAGING_SOCKET:f.socket,CLAUDE_CODE_MESSAGING_TOKEN:'private'}, f);
  assert.equal(await latestChatTarget(f), null);
  await appendFile(f.transcript, human(f.now));
  const a = await latestChatTarget(f); assert.equal(a?.sessionId,'a'); assert.equal(a?.lastHumanAt,f.now);
  await appendFile(f.transcript, JSON.stringify({type:'user',timestamp:new Date(f.now+100).toISOString(),origin:{kind:'peer'},turnOrigin:'peer',isMeta:true})+'\n');
  assert.equal((await latestChatTarget({...f,now:f.now+100}))?.lastHumanAt,f.now);
  assert.equal((await stat(f.dir)).mode & 0o777,0o700);
  assert.equal(await validateChatTarget(a!, f),true);
});

test('SessionStart before transcript creation registers and observes its first real turn',async t=>{
 const f=await fixture(t);const path=join(f.root,'missing-parent','not-yet.jsonl');
 await registerChatHook({hook_event_name:'SessionStart',session_id:'pending',transcript_path:path,bastra_client:'claude-code'},{CLAUDE_CODE_MESSAGING_SOCKET:'uds:'+f.socket},f);
 assert.equal(await latestChatTarget(f),null);await mkdir(join(f.root,'missing-parent'));await writeFile(path,human(f.now));
 assert.equal((await latestChatTarget(f))?.sessionId,'pending');
});

test('tool results do not create unknown activity and malformed project settings close the endpoint',async t=>{
 const f=await fixture(t);
 await registerChatHook({hook_event_name:'SessionStart',session_id:'a',transcript_path:f.transcript,bastra_client:'claude-code',cwd:f.root},{CLAUDE_CODE_MESSAGING_SOCKET:f.socket},f);
 await appendFile(f.transcript,human(f.now));assert.ok(await latestChatTarget(f));
 await appendFile(f.transcript,JSON.stringify({type:'user',timestamp:new Date(f.now+1).toISOString(),message:{role:'user',content:[{type:'tool_result',content:'finished'}]}})+'\n');
 assert.ok(await latestChatTarget({...f,now:f.now+1}));
 await mkdir(join(f.root,'.claude'));await writeFile(join(f.root,'.claude','settings.json'),'{');
 assert.equal(await latestChatTarget({...f,now:f.now+1}),null);
});

test('partial appended line blocks chat selection until fully persisted',async t=>{
 const f=await fixture(t);
 await registerChatHook({hook_event_name:'SessionStart',session_id:'a',transcript_path:f.transcript,bastra_client:'claude-code'},{CLAUDE_CODE_MESSAGING_SOCKET:f.socket},f);
 await appendFile(f.transcript,human(f.now));assert.ok(await latestChatTarget(f));
 const line=human(f.now+1);await appendFile(f.transcript,line.slice(0,-1));
 assert.equal(await latestChatTarget({...f,now:f.now+1}),null);
 await appendFile(f.transcript,'\n');assert.ok(await latestChatTarget({...f,now:f.now+1}));
});

test('resume rotates generation and fork never inherits historical activity',async t => {
 const f=await fixture(t); const p={hook_event_name:'SessionStart',session_id:'a',transcript_path:f.transcript,bastra_client:'claude-code'};
 const env={CLAUDE_CODE_MESSAGING_SOCKET:f.socket,CLAUDE_CODE_MESSAGING_TOKEN:'private'};
 await registerChatHook(p,env,f); await appendFile(f.transcript,human(f.now)); const a=await latestChatTarget(f);
 await registerChatHook({...p,source:'resume'},env,{...f,now:f.now+10});
 assert.equal(await validateChatTarget(a!,f),false);
 assert.equal((await latestChatTarget({...f,now:f.now+10}))?.lastHumanAt,f.now);
 await registerChatHook({...p,session_id:'fork',source:'fork'},env,f);
 assert.equal((await refreshChatRegistry(f)).find(s=>s.sessionId==='fork')?.lastHumanAt,undefined);
});

test('newest unsupported, ended or stale chat blocks fallback to older Claude',async t=>{
 const f=await fixture(t); const env={CLAUDE_CODE_MESSAGING_SOCKET:f.socket,CLAUDE_CODE_MESSAGING_TOKEN:'private'};
 await registerChatHook({hook_event_name:'SessionStart',session_id:'a',transcript_path:f.transcript,bastra_client:'claude-code'},env,f);
 await appendFile(f.transcript,human(f.now)); assert.ok(await latestChatTarget(f));
 const codex=join(f.root,'codex.jsonl'); await writeFile(codex,'');
 await registerChatHook({hook_event_name:'SessionStart',session_id:'b',transcript_path:codex,bastra_client:'codex'}, {},f);
 await appendFile(codex,JSON.stringify({type:'event_msg',timestamp:new Date(f.now+1).toISOString(),payload:{type:'user_message',message:'hi'}})+'\n');
 assert.equal(await latestChatTarget({...f,now:f.now+1}),null);
 await registerChatHook({hook_event_name:'SessionEnd',session_id:'b',bastra_client:'codex'}, {},f);
 assert.equal(await latestChatTarget({...f,now:f.now+1}),null);
 assert.equal(await latestChatTarget({...f,now:f.now+31*60000}),null);
});

test('rejects symlink endpoints and subagent registration', async t=>{
 const f=await fixture(t); const link=join(f.root,'link.sock'); await symlink(f.socket,link);
 const p={hook_event_name:'SessionStart',session_id:'a',transcript_path:f.transcript,bastra_client:'claude-code'};
 await registerChatHook(p,{CLAUDE_CODE_MESSAGING_SOCKET:link},f); assert.equal((await refreshChatRegistry(f))[0]?.socketPath,undefined);
 await registerChatHook({...p,session_id:'sub',agent_id:'worker'},{},f);
 assert.equal((await refreshChatRegistry(f)).length,1);
});

test('unsupported prompt without SessionStart blocks fallback without inventing human activity',async t=>{
 const f=await fixture(t);
 await registerChatHook({hook_event_name:'SessionStart',session_id:'a',transcript_path:f.transcript,bastra_client:'claude-code'},{CLAUDE_CODE_MESSAGING_SOCKET:f.socket},f);
 await appendFile(f.transcript,human(f.now));assert.ok(await latestChatTarget(f));
 await registerChatHook({hook_event_name:'UserPromptSubmit',session_id:'missing-start',bastra_client:'codex'}, {},{...f,now:f.now+1});
 assert.equal(await latestChatTarget({...f,now:f.now+1}),null);
 const barrier=(await refreshChatRegistry(f)).find(s=>s.sessionId==='missing-start');assert.equal(barrier?.lastHumanAt,undefined);assert.equal(barrier?.lastUnknownAt,f.now+1);
});

test('token registry rejects both named sync folders and an ancestor symlink into them before creating it',async t=>{
 const f=await fixture(t),cloud=join(f.root,'CloudStorage');await mkdir(cloud);
 const alias=join(f.root,'local-alias');await symlink(cloud,alias);
 const p={hook_event_name:'SessionStart',session_id:'a',transcript_path:f.transcript,bastra_client:'claude-code'};
 for(const dir of [join(cloud,'registry'),join(alias,'registry')]) {
  await assert.rejects(registerChatHook(p,{CLAUDE_CODE_MESSAGING_SOCKET:f.socket,CLAUDE_CODE_MESSAGING_TOKEN:'private'},{...f,dir}),/outside sync/);
  await assert.rejects(stat(dir),{code:'ENOENT'});
 }
});

test('two supported chats select the last real human turn and reject a shared socket pathname',async t=>{
 const first=await fixture(t),second=await fixture(t);const now=Date.now();
 const opts={dir:first.dir,now};
 const start=(sessionId:string,transcript:string)=>({hook_event_name:'SessionStart',session_id:sessionId,transcript_path:transcript,bastra_client:'claude-code'});
 await registerChatHook(start('first',first.transcript),{CLAUDE_CODE_MESSAGING_SOCKET:first.socket},opts);
 await registerChatHook(start('second',second.transcript),{CLAUDE_CODE_MESSAGING_SOCKET:second.socket},opts);
 await appendFile(first.transcript,human(now+1));await appendFile(second.transcript,human(now+2));
 assert.equal((await latestChatTarget({...opts,now:now+2}))?.sessionId,'second');
 await appendFile(first.transcript,human(now+3));
 const selected=await latestChatTarget({...opts,now:now+3});assert.equal(selected?.sessionId,'first');
 await registerChatHook(start('reused-path',second.transcript),{CLAUDE_CODE_MESSAGING_SOCKET:first.socket},{...opts,now:now+4});
 assert.equal(await validateChatTarget(selected!,{...opts,now:now+4}),false);
 assert.equal(await latestChatTarget({...opts,now:now+4}),null);
});
