/** Deterministic DOM fixture: no browser, no real credentials, all task strings are data. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createContext,runInContext} from "node:vm";
class Node {
 textContent="";children:Node[]=[];disabled=false;hidden=false;value="";id="";className="";handlers:Record<string,Function>={};
 set innerHTML(_value:string){throw new Error("Task data must never enter HTML");}
 append(...nodes:Node[]){this.children.push(...nodes);}replaceChildren(...nodes:Node[]){this.children=nodes;}addEventListener(name:string,fn:Function){this.handlers[name]=fn;}remove(){}showModal(){}close(){}
}
const descendants=(n:Node):Node[]=>[n,...n.children.flatMap(descendants)];
async function ui(snapshot:any,due:any={cards:[]},overrides:any={}){
 const nodes=new Map<string,Node>(),get=(id:string)=>{if(!nodes.has(id)){const n=new Node();n.id=id;nodes.set(id,n);}return nodes.get(id)!;};
 const document={getElementById:get,createElement:()=>new Node(),querySelectorAll:()=>[]};
 const source=await readFile(new URL("../webui/js/tasks.js",import.meta.url),"utf8"),ctx=createContext({document,Intl,Date,JSON,Map,Set,Error,crypto:{randomUUID:()=>"synthetic"},prompt:()=>null,confirm:()=>false,fetch:async(url:string)=>({ok:true,json:async()=>url.endsWith("task_due")?due:snapshot}),...overrides});
 runInContext(source,ctx);await runInContext("taskView='all';refresh()",ctx);return{nodes,get,ctx};
}
test("terminal owner UI offers rearm while disabling invalid lifecycle actions and exposes real budgets",async()=>{
 const task={id:"terminal",goal:"Done </script><img onerror=bad>",original_request:"literal data",state:"resolved",last_failure:{code:"source_budget",message:"Quell-Bytegrenze überschritten"},armed:false,action_level:"notify",schedule:{kind:"instant",at:1000},timezone:"Europe/Madrid",deliveries:[{last_attempt:1000,acknowledged:true}],budget:{poll_interval_ms:60000,timeout_ms:1000,max_source_bytes:1024}};
 const base={role:"owner",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true,next_tick:1000},tasks:[task],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false},budgets:{max_assessments_per_turn:10,source_turn_ms:5000,poll_ms:60000,snapshot_bytes:4194304}};
 const u=await ui(base),all=descendants(u.get("tasks"));for(const label of ["Scharf schalten","Zurückstellen","Erledigt","Beenden","Bearbeiten"]){assert.equal(all.find(n=>n.textContent===label)?.disabled,true,label);}assert.equal(all.find(n=>n.textContent==="Wieder zur Prüfung")?.disabled,false);
 assert.ok(all.some(n=>n.textContent===task.goal));assert.ok(all.some(n=>n.textContent.includes("früher quittiert")));assert.ok(all.some(n=>n.textContent.includes("Quell-Bytegrenze überschritten")));assert.ok(!all.some(n=>n.textContent.includes("noch offen")));
 for(const ended of ["cancelled","expired"]){const historical=await ui({...base,tasks:[{...task,state:ended}]});const text=descendants(historical.get("tasks")).map(n=>n.textContent).join(" ");assert.match(text,/früher quittiert/);assert.ok(!text.includes("noch offen"));}assert.ok(all.some(n=>/Budget.*60s.*1000ms.*1024/.test(n.textContent)));assert.match(descendants(u.get("status")).map(n=>n.textContent).join(" "),/Globale Budgets.*10.*5s/);
 const proposal={id:"p",task_id:"terminal",task_revision:3,target_id:"artifact",payload_hash:"a".repeat(64),payload:"after </script>",required_domains:["personal"]};
 (u.ctx as any).fixture={proposal,preview:{before:"before </pre>",after:proposal.payload},approved:false};await runInContext("showProposal(fixture)",u.ctx);
 const preview=descendants(u.get("preview")).map(n=>n.textContent);assert.ok(preview.includes("Vorher"));assert.ok(preview.includes("Nachher – exakt freizugebende Bytes"));assert.ok(preview.includes("before </pre>"));assert.ok(preview.includes(proposal.payload));assert.ok(!u.get("preview").textContent.startsWith("{"));assert.match(u.get("binding").textContent,/payload_hash/);assert.equal(descendants(u.get("proposal")).find(n=>n.id==="execute-button")?.disabled,true);
});

test("browser shows compact reconsideration, owner choices and the detail command",async()=>{
 const snapshot={role:"owner",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const c={task_id:"t",occurrence_id:"o",goal:"Neubewertung",due_at:1000,timezone:"Europe/Madrid",compact:true,detail_command:"bastra tasks get t",why_now:"Geprüfte Prämissenänderung",reconsideration:{decision:{option:"A",reason:"Wartung",alternatives:["B"]},old_premise:"costly",new_premise:"cheap",new_evidence:{id:"evidence",revision:"v1",observed_at:1000},choices:["keep","change","snooze","stop"]}};
 const u=await ui(snapshot,{cards:[c],overflow:0});await (u.get("due") as any).onclick();const nodes=descendants(u.get("cards"));assert.ok(nodes.some(n=>n.textContent==="Neubewertung"));assert.ok(nodes.some(n=>n.textContent.includes("bastra tasks get t")));for(const label of ["Beibehalten","Zurückstellen","Überwachung beenden","Entscheidung ändern"])assert.ok(nodes.some(n=>n.textContent===label&&!n.disabled));
});

test("browser prevents duplicate execute reservations and releases its exact holder after failure",async()=>{
 const snapshot={role:"owner",controls:{enabled:true,muted:false,execution_stopped:false},runtime:{running:true},tasks:[],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:true}};
 const calls:any[]=[];const u=await ui(snapshot,undefined,{confirm:()=>true,fetch:async(url:string,args:any)=>{const input=JSON.parse(args.body);calls.push({url,input});return url.endsWith("task_lease")?{ok:true,json:async()=>({lease:{id:"l",fence:7},holder_token:"secret"})}:url.endsWith("task_execute")?{ok:false,json:async()=>({code:"approval_stale"})}:{ok:true,json:async()=>snapshot};}});
 (u.ctx as any).fixture={proposal:{id:"p",required_domains:["personal"]},preview:{before:"old",after:"new"},approved:true,binding_status:"current"};await runInContext("showProposal(fixture)",u.ctx);
 const button=descendants(u.get("proposal")).find(n=>n.id==="execute-button")!;await Promise.all([button.handlers.click(),button.handlers.click()]);
 assert.equal(calls.filter(c=>c.url.endsWith("task_lease")).length,1);assert.equal(calls.filter(c=>c.url.endsWith("task_execute")).length,1);const released=calls.find(c=>c.url.endsWith("task_release"));assert.deepEqual(released.input,{lease_id:"l",holder_token:"secret",fence:7});assert.equal(button.disabled,true);assert.match(u.get("message").textContent,/Bindung geändert/);
});

test("browser header distinguishes presentation attempt from owner acknowledgement",async()=>{
 const html=await readFile(new URL("../webui/tasks.html",import.meta.url),"utf8");assert.match(html,/Zustellung ist ein Anzeigeversuch/);assert.match(html,/Erst Quittieren heißt gesehen/);assert.ok(!html.includes("Zustellung heißt gesehen"));
});

test("task views separate active, completed and failed work and show scrubbed origin as text",async()=>{
 const base={role:"agent",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const template={original_request:"Synthetic",armed:true,action_level:"notify",schedule:{kind:"instant",at:1000},timezone:"Europe/Madrid",deliveries:[],origin:{kind:"agent-observed",client:"client",session:"synthetic",context:"literal </script>"}};
 const tasks=[{...template,id:"active",goal:"Active",state:"due"},{...template,id:"done",goal:"Done",state:"resolved",armed:false},{...template,id:"failed",goal:"Failed",state:"cancelled",armed:false}];const u=await ui({...base,tasks});
 for(const [view,goal] of [["active","Active"],["done","Done"],["failed","Failed"]]){await runInContext(`taskView='${view}';refresh()`,u.ctx);const nodes=descendants(u.get("tasks"));assert.equal(nodes.filter(n=>n.textContent===goal).length,1);for(const other of tasks.filter(t=>t.goal!==goal))assert.ok(!nodes.some(n=>n.textContent===other.goal));assert.ok(nodes.some(n=>n.textContent.includes("vom Agenten bemerkt")&&n.textContent.includes("literal </script>")));}
 const html=await readFile(new URL("../webui/index.html",import.meta.url),"utf8");assert.match(html,/data-view="tasks"/);assert.match(html,/id="tasks-view"/);
});

test("retired legacy proposal shows new preparation without preview, signing or execution",async()=>{
 const snapshot={role:"owner",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:true}};
 const u=await ui(snapshot);(u.ctx as any).fixture={proposal:{id:"old",task_id:"task",target_id:"artifact",status:"stale"},binding_status:"approval_stale",approved:false};await runInContext("showProposal(fixture)",u.ctx);
 const visible=descendants(u.get("preview")).map(n=>n.textContent).join(" ");assert.match(visible,/Vorschlag veraltet/);assert.match(visible,/Neue Vorbereitung und neue Freigaben/);assert.equal(u.get("binding").textContent,"");assert.equal(u.get("sign-command").textContent,"");assert.ok(!descendants(u.get("proposal")).some(n=>n.id==="execute-button"));
});
