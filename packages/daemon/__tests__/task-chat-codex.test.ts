import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { registerCodexChat, closeCodexChat, registerChatHook, latestChatTarget, validateChatTarget, refreshChatRegistry } from '../src/task-chat-registry.js';

const human=(at:number)=>JSON.stringify({type:'user',timestamp:new Date(at).toISOString(),origin:{kind:'human'},turnOrigin:'human',promptSource:'typed',message:{content:'fixture'}})+'\n';
test('Codex bridge competes globally with Claude, keeps closed latest barrier, rotates on resume',async t=>{
 const root=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'cxr-')),dir=join(root,'registry'),now=Date.now();
 const socket=join(root,'delivery.sock'),transcript=join(root,'codex.jsonl'),claudeTranscript=join(root,'claude.jsonl');
 await writeFile(transcript,'',{mode:0o600});await writeFile(claudeTranscript,'');
 let generation='generation-1';const token='private-fixture';
 const server=createServer(s=>{let data='';s.on('data',chunk=>{data+=chunk;if(!data.includes('\n'))return;const p=JSON.parse(data);s.end(JSON.stringify({ok:p.token===token&&p.generation===generation&&p.sessionId==='codex-session'})+'\n');});});
 server.listen(socket);await once(server,'listening');t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const claudeSocket=join(root,'claude.sock'),claudeServer=createServer(s=>s.end());claudeServer.listen(claudeSocket);await once(claudeServer,'listening');t.after(()=>new Promise<void>(r=>claudeServer.close(()=>r())));
 const input={sessionId:'codex-session',generation,socketPath:socket,token,transcriptPath:transcript};
 await registerChatHook({hook_event_name:'SessionStart',session_id:'claude',bastra_client:'claude-code',transcript_path:claudeTranscript},{CLAUDE_CODE_MESSAGING_SOCKET:claudeSocket},{dir,now});
 await appendFile(claudeTranscript,human(now));assert.equal((await latestChatTarget({dir,now}))?.sessionId,'claude');
 await registerCodexChat(input,{dir,now});
 await appendFile(transcript,human(now+1));const codex=await latestChatTarget({dir,now:now+1});
 assert.equal(codex?.client,'codex');assert.equal(codex?.sessionId,'codex-session');
 // Ordinary Codex hooks must not overwrite bridge registration or manufacture an unknown barrier.
 await registerChatHook({hook_event_name:'UserPromptSubmit',session_id:'codex-session',bastra_client:'codex'},{BASTRA_CODEX_CHAT_TOKEN:token},{dir,now:now+1});
 assert.equal((await latestChatTarget({dir,now:now+1}))?.generation,generation);
 await closeCodexChat(input,{dir,now:now+2});assert.equal(await latestChatTarget({dir,now:now+2}),null);
 generation='generation-2';await registerCodexChat({...input,generation,source:'resume'},{dir,now:now+3});
 assert.equal(await validateChatTarget(codex!,{dir,now:now+3}),false);
 assert.equal((await latestChatTarget({dir,now:now+3}))?.generation,generation);
 // Fork has no inherited activity; an idle daemon refresh is not activity either.
 await closeCodexChat({...input,generation},{dir,now:now+4});
 await registerCodexChat({...input,sessionId:'fork',generation:'fork-gen',source:'fork'},{dir,now:now+5});
 assert.equal((await refreshChatRegistry({dir,now:now+5})).find(s=>s.sessionId==='fork')?.lastHumanAt,undefined);
 assert.equal(await latestChatTarget({dir,now:now+5}),null);
});

test('ordinary Codex resume does not inherit a crashed bridge hook exemption',async t=>{
 const root=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'cxs-')),dir=join(root,'registry'),now=Date.now();
 const socket=join(root,'bridge.sock'),transcript=join(root,'bridge.jsonl');await writeFile(transcript,'',{mode:0o600});
 const server=createServer(s=>s.end());server.listen(socket);await once(server,'listening');t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 await registerCodexChat({sessionId:'resumed',generation:'crashed',socketPath:socket,token:'old-token',transcriptPath:transcript},{dir,now});
 await registerChatHook({hook_event_name:'UserPromptSubmit',session_id:'resumed',bastra_client:'codex'},{},{dir,now:now+1});
 assert.equal((await refreshChatRegistry({dir,now:now+1}))[0]?.lastUnknownAt,now+1,'a new unattached human input blocks fallback even when the old bridge crashed');
});

test('Codex metadata from an ordinary rollout never proves human origin',async t=>{
 const root=await mkdtemp(join(tmpdir(),'codex-unsupported-')),path=join(root,'rollout.jsonl'),now=Date.now();await writeFile(path,'');
 await registerChatHook({hook_event_name:'SessionStart',session_id:'ordinary',transcript_path:path,bastra_client:'codex'},{},{dir:join(root,'registry'),now});
 await appendFile(path,human(now));
 assert.equal(await latestChatTarget({dir:join(root,'registry'),now}),null);
});
