import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runGateLane} from '../src/gate-lane.js';
import {preparedGate,type PreparedGateTiming} from './fixtures/rulebook-phase5/prepared-gate.js';
import {RULEBOOK_CATALOG_BUDGET_MS} from '../src/rulebook-catalog.js';

const catalog={entries:[{id:'budget-fixture',title:'Fixture',body:'Full fixture rule',group:'explicit' as const,rulebook:'always' as const,revision:null,updated:null,stale_status:'unknown' as const}],omitted:0};
const payload=(session_id:string)=>({session_id,bastra_client:'claude-code',hook_event_name:'PreToolUse',tool_name:'mcp__mail__send',tool_input:{}});
const denied=(raw:string)=>JSON.parse(raw).hookSpecificOutput?.permissionDecision==='deny';

test('#1412 slow fixture catalog preparation does not consume the mechanical gate budget',async t=>{
 const delay=RULEBOOK_CATALOG_BUDGET_MS+30;
 const kernel=async()=>{await new Promise(resolve=>setTimeout(resolve,delay));return catalog;};
 const deps={kernel,reflexPool:()=>[]};
 const start=performance.now();
 const raw=await runGateLane(payload('phase5-budget-unprepared'),deps);
 t.diagnostic(JSON.stringify({raw,elapsed_ms:performance.now()-start,catalog_budget_ms:RULEBOOK_CATALOG_BUDGET_MS,provider_delay_ms:delay}));
 assert.equal(denied(raw),false,`production must fail open for delayed catalog: ${raw}`);
 let timing:PreparedGateTiming|undefined;
 const prepared=await preparedGate(payload('phase5-budget-prepared'),deps,value=>{timing=value;});
 assert.ok(timing,'prepared calls retain timing evidence');
 assert.ok(timing.preparation_ms>=delay,'both catalog projections are prepared outside the gate');
 assert.ok(timing.gate_ms>=0);
 t.diagnostic(JSON.stringify({raw:prepared,...timing,catalog_budget_ms:RULEBOOK_CATALOG_BUDGET_MS}));
 assert.equal(denied(prepared),true,`prepared mechanical decision must retain full denial: ${prepared}`);
 assert.match(prepared,/rulebook_check/);
});

test('#1412 prepared gate retains content projection for periodic full-rule delivery',async()=>{
 const {mutateSessionState}=await import('../src/session-state.js');
 const {RULE_KERNEL_TOOL_CALLS}=await import('../src/rule-kernel.js');
 const sid='phase5-projection-specific';
 await mutateSessionState(sid,state=>{state.toolCalls=RULE_KERNEL_TOOL_CALLS-1;});
 const modes:(string|undefined)[]=[];
 const kernel=async(_active:unknown,_project:unknown,mode?:'ids'|'content')=>{
  modes.push(mode);
  return mode==='ids'?{...catalog,ids_only:true as const,entries:catalog.entries.map(e=>({...e,title:'',body:''}))}
   :{...catalog,entries:catalog.entries.map(e=>({...e,title:'Content projection title',body:'COMPLETE_PROJECTION_SPECIFIC_BODY'}))};
 };
 const raw=await preparedGate({...payload(sid),tool_name:'Read'},{kernel,reflexPool:()=>[]});
 assert.match(raw,/COMPLETE_PROJECTION_SPECIFIC_BODY/,'periodic delivery must receive full content, never the IDs projection');
 assert.deepEqual(modes,['ids','content']);
});

test('#1412 prepared mechanical denial is independent of runner wall time', async t => {
  let wall = Date.now();
  t.mock.method(Date, 'now', () => wall += RULEBOOK_CATALOG_BUDGET_MS + 1);
  const deps = {kernel: async () => catalog, reflexPool: () => []};
  const raw = await preparedGate(payload('phase5-clock-prepared'), deps);
  assert.equal(denied(raw), true, `mechanical denial must deliver the rulebook check: ${raw}`);
  assert.match(raw, /rulebook_check/);
});
