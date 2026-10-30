/** Real receipt/Stop dogfood after explicit semantic task reporting. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordRulebookCheck} from '../src/rulebook-check.js';
import {loadSessionState} from '../src/session-state.js';
import {callerSessionStore} from '../src/caller-session.js';
import {validateArtifactHandler} from '../src/validate-artifact-handler.js';
import {runStopLane} from '../src/stop-lane.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
test('incoming → review → approved copy → Stop repair → real validation receipt',async t=>{
 const root=await mkdtemp(join(tmpdir(),'semantic-dogfood-')),previous=process.env.BASTRA_HOOK_STATE_DIR,oldStop=process.env.BASTRA_STOP_SAME_TURN;
 process.env.BASTRA_HOOK_STATE_DIR=root;process.env.BASTRA_STOP_SAME_TURN='1';
 t.after(async()=>{if(previous===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=previous;if(oldStop===undefined)delete process.env.BASTRA_STOP_SAME_TURN;else process.env.BASTRA_STOP_SAME_TURN=oldStop;await rm(root,{recursive:true,force:true});});
 const catalog:KernelCandidates={entries:[{id:'message',title:'Message',group:'explicit',rulebook:'on-demand',applies_when:'When composing correspondence',body:'Review then copy',revision:'rev1',updated:null,stale_status:'unknown',validator:{tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'}}],omitted:0};
 const sid='dogfood';await recordRulebookCheck(sid,{applicable:['message'],task:'draft-for-review'},catalog);
 await recordRulebookCheck(sid,{applicable:['message'],task:'approved-copy'},catalog);
 const state=await loadSessionState(sid),text='Hi Alex, could you check the invented question?';
 const stop=(active=false)=>{const payload={session_id:sid,bastra_client:'claude-code',hook_event_name:'Stop',stop_hook_active:active,transcript:[{role:'user',content:'approved'},{role:'assistant',content:text}]};return runStopLane(payload,'http://127.0.0.1:1',{kernel:async()=>catalog});};
 assert.match(await stop(),/copy-repair/);
 const result=await callerSessionStore.run(sid,()=>validateArtifactHandler({text,channel:'discord-dm',normalize:'none',rule:{id:'message',revision:'rev1'},task:{kind:state.activeTask!.kind,generation:state.activeTask!.generation}}));
 assert.equal(result.receipt_stored,true);assert.equal(await stop(true),'{}');
});
