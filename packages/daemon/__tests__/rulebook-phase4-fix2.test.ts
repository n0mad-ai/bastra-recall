import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkStopRepair} from '../src/stop-repair.js';
import {loadSessionState,mutateSessionState} from '../src/session-state.js';
import {recordRulebookLoad,recordRulebookCheck,requireActionRules,beginRulebookRound,RulebookCheckArgs} from '../src/rulebook-check.js';
import {githubWriteActions} from '../src/github-shell-actions.js';
import type {KernelCandidates} from '../src/rulebook-catalog.js';
const validator={tool:'validate_artifact',channel:'discord-dm',limit:2000,unit:'utf16'} as const;
const catalog:KernelCandidates={entries:[],omitted:0};
let root:string;const previous=process.env.BASTRA_HOOK_STATE_DIR;
before(async()=>{root=await mkdtemp(join(tmpdir(),'phase4-fix2-'));process.env.BASTRA_HOOK_STATE_DIR=root;});
after(async()=>{if(previous===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=previous;await rm(root,{recursive:true,force:true});});
async function load(sid:string){await recordRulebookLoad(sid,'copy-rule',null,{revision:'r1',validator});}
async function task(sid:string,kind:'draft-for-review'|'approved-copy'|'none'|'translate-only'){
 await mutateSessionState(sid,s=>{s.activeTask={id:sid,kind,since:Date.now(),generation:0,...(kind==='approved-copy'?{approvalSource:'user-turn' as const}:{})};});
}
const stop=(sid:string,text:string)=>checkStopRepair({session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:text}]});
test('loaded validator checks explicit review copies and all approved forms, without activeConventions',async()=>{
 const forms=['x'.repeat(3000),'```\n'+'x'.repeat(3000)+'\n```','```text\n'+'x'.repeat(3000)+'\n```','```markdown\n'+'x'.repeat(3000)+'\n```','> '+'x'.repeat(3000)];
 for(const kind of ['draft-for-review','approved-copy'] as const)for(const [i,text] of forms.entries()){
  const sid=`form-${kind}-${i}`;await load(sid);await task(sid,kind);
  assert.equal((await loadSessionState(sid)).activeConventions,undefined);
  if(kind==='draft-for-review'&&i===0){assert.equal(await stop(sid,text),null,'review prose is not delivered copy');continue;}
  const p={session_id:sid,hook_event_name:'Stop',transcript:[{role:'assistant',content:text}]};
  assert.equal((await checkStopRepair(p))?.action,'request',sid);
  p.transcript.push({role:'assistant',content:text});
  assert.equal((await checkStopRepair(p))?.action,'request');
  p.transcript.push({role:'assistant',content:text});
  assert.equal((await checkStopRepair(p))?.action,'exhausted');assert.equal(await checkStopRepair(p),null);
 }
});
test('loaded validators and any fence never create a task or change none/translation',async()=>{
 for(const kind of [undefined,'none','translate-only'] as const)for(const label of ['','text','markdown','discord-dm','typescript']){
  const sid=`harmless-${kind}-${label}`;await load(sid);if(kind)await task(sid,kind);
  assert.equal(await stop(sid,'```'+label+'\nShell output\n```'),null);
  const s=await loadSessionState(sid);assert.equal(s.activeTask?.kind,kind);assert.equal(s.repairAttempts,undefined);
 }
});
test('task without validator stays untouched; active validator alone checks oversized review fences',async()=>{
 await task('no-validator','draft-for-review');assert.equal(await stop('no-validator','copy'),null);
 await task('active-only','draft-for-review');await mutateSessionState('active-only',s=>{s.activeConventions=[{id:'active',revision:'r',setAt:1,validator}];});
 assert.equal((await stop('active-only','```\n'+'x'.repeat(3000)+'\n```'))?.action,'request');
});
async function receipt(sid:string){await mutateSessionState(sid,s=>{s.receipts=[{taskId:sid,generation:0,hash:'a'.repeat(64),receipt:'sha256:'+'a'.repeat(64),channel:validator.channel,limit:2000,unit:'max(codepoints,utf16)',at:1}];});}
test('largest fenced or quoted copy is checked; channel comes from rule regardless of fence label',async()=>{
 await load('largest');await task('largest','approved-copy');await receipt('largest');
 assert.equal(await stop('largest','```markdown\nA short copy\n```'),null);
 assert.equal((await stop('largest','```text\nshort\n```\n```markdown\n'+'x'.repeat(3000)+'\n```'))?.action,'request');
 await load('quote');await task('quote','approved-copy');await receipt('quote');
 assert.equal((await stop('quote','An explanation.\n\n> Short copy.\n\n'+'Outside explanation. '.repeat(200)))?.action,'request','oversized prose remains a candidate alongside a short quote');
});
test('not_applicable needs a substantive reason and reports the exact exception ID next round',async()=>{
 for(const reason of ['.','..........','          ','short','!!!!!!!!!!!']){
  assert.equal(RulebookCheckArgs.safeParse({applicable:[],not_applicable:[{id:'github-policy',reason}]}).success,false,reason);
 }
 const sid='exception';await requireActionRules({session_id:sid,bastra_client:'claude-code'},[{id:'github-policy',revision:'r'}]);
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[{id:'github-policy',reason:'.'}]},catalog)).ok,false);
 assert.equal((await recordRulebookCheck(sid,{applicable:[],not_applicable:[{id:'github-policy',reason:'This repository follows a separate policy.'}]},catalog)).ok,true);
 assert.match(await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},catalog),/github-policy/);
 assert.doesNotMatch(await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},catalog),/github-policy/);
});
test('AST detects issue/pr lifecycle writes and GraphQL mutation fields, not queries or quoted prose',async()=>{
 for(const command of ['gh pr merge 1','gh issue close 1','gh issue reopen 1','gh issue edit 1 --title x','gh pr close 1','gh pr edit 1 --title x',
  ...['createIssue','updateIssue','closeIssue','mergePullRequest'].map(name=>`gh api graphql -f 'query=mutation { ${name}(input: {}) { id } }'`),
  `gh api graphql --raw-field='query=mutation MyChange { result: updatePullRequest(input: {}) { id } }'`])assert.ok((await githubWriteActions(command)).length,command);
 for(const command of [`gh api graphql -f 'query=query { repository { issues { nodes { id } } } }'`,`echo 'gh pr merge 1'`,`gh pr merge --help`,`gh api graphql -f 'query=query { repository(name: "createIssue(input: {})") { id } }'`])assert.deepEqual(await githubWriteActions(command),[],command);
});

test('loaded-only validator measures a reported approved-copy task without wording inference',async()=>{
 const sid='original-c3';await load(sid);
 await recordRulebookCheck(sid,{applicable:[],task:'draft-for-review'},catalog);
 assert.equal(await checkStopRepair({session_id:sid,hook_event_name:'Stop'},[{role:'assistant',content:'```\nShort draft.\n```'}]),null);
 await recordRulebookCheck(sid,{applicable:[],task:'approved-copy'},catalog);
 const state=await loadSessionState(sid);assert.equal(state.activeTask?.kind,'approved-copy');
 assert.equal(state.activeConventions,undefined,'loaded-only validator must suffice');
 assert.equal((await stop(sid,'x'.repeat(3000)))?.action,'request');
});
