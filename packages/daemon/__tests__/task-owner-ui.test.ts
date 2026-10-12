/** Deterministic DOM fixture: no browser, no real credentials, all task strings are data. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createContext,runInContext} from "node:vm";
class Node {
 dataset:Record<string,string>={};attributes:Record<string,string>={};open=false;draggable=false;classNames=new Set<string>();classList={toggle:(name:string,on:boolean)=>{if(on)this.classNames.add(name);else this.classNames.delete(name);},add:(name:string)=>{this.classNames.add(name);},remove:(name:string)=>{this.classNames.delete(name);}};
 setAttribute(name:string,value:string){this.attributes[name]=value;}
 onclick!:()=>Promise<void>;
 focus(_options?:any){}
 scrollTop=0;scrollLeft=0;
 textContent="";children:Node[]=[];disabled=false;hidden=false;value="";id="";className="";handlers:Record<string,Function>={};
 set innerHTML(_value:string){throw new Error("Task data must never enter HTML");}
 append(...nodes:Node[]){this.children.push(...nodes);}replaceChildren(...nodes:Node[]){this.children=nodes;}addEventListener(name:string,fn:Function){this.handlers[name]=fn;}remove(){}showModal(){this.open=true;}close(){this.open=false;}
}
const descendants=(n:Node):Node[]=>[n,...n.children.flatMap(descendants)];
async function ui(snapshot:any,due:any={cards:[]},overrides:any={}){
 const nodes=new Map<string,Node>(),get=(id:string)=>{if(!nodes.has(id)){const n=new Node();n.id=id;if(id==="task-message")n.hidden=true;nodes.set(id,n);}return nodes.get(id)!;};
 const document={hidden:false,activeElement:null as Node|null,handlers:{} as Record<string,Function>,addEventListener(name:string,fn:Function){this.handlers[name]=fn;},body:get("body"),getElementById:get,createElement:()=>{const n=new Node();n.focus=()=>{document.activeElement=n;};return n;},querySelectorAll:(selector:string)=>selector==="[data-task-column]"?get("task-tasks").children:[]};
 const source=(await readFile(new URL("../webui/js/tasks.js",import.meta.url),"utf8")).replace("export function createTasksView() {", "").replace(/return \{ open, close \};\s*\}\s*$/, ""),ctx=createContext({document,Intl,Date,JSON,Map,Set,Error,setTimeout,setInterval:()=>0,clearInterval:()=>{},crypto:{randomUUID:()=>"synthetic"},prompt:()=>null,confirm:()=>false,fetch:async(url:string)=>({ok:true,json:async()=>url.endsWith("task_due")?due:snapshot}),...overrides});
 runInContext(source,ctx);await runInContext("refresh()",ctx);return{nodes,get:(id:string)=>get(`task-${id}`),ctx};
}
test("terminal owner UI offers rearm while disabling invalid lifecycle actions and exposes real budgets",async()=>{
 const task={id:"terminal",goal:"Done </script><img onerror=bad>",original_request:"literal data",state:"resolved",last_failure:{code:"source_budget",message:"Quell-Bytegrenze überschritten"},armed:false,action_level:"notify",schedule:{kind:"instant",at:1000},timezone:"Europe/Madrid",deliveries:[{last_attempt:1000,acknowledged:true}],budget:{poll_interval_ms:60000,timeout_ms:1000,max_source_bytes:1024}};
 const base={role:"owner",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true,next_tick:1000},tasks:[task],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false},budgets:{max_assessments_per_turn:10,source_turn_ms:5000,poll_ms:60000,snapshot_bytes:4194304}};
 const u=await ui(base);await runInContext("selectTask(snapshot.tasks[0])",u.ctx);const all=descendants(u.get("detail-body"));for(const label of ["Freigeben","Zurückstellen","Erledigt","Abbrechen","Bearbeiten"]){assert.equal(all.find(n=>n.textContent===label),undefined,label);}assert.equal(all.find(n=>n.textContent==="Wieder zur Prüfung")?.disabled,false);
 assert.ok(all.some(n=>n.textContent===task.goal));assert.ok(all.some(n=>n.textContent.includes("Damals als gesehen markiert")));assert.ok(all.some(n=>n.textContent.includes("Quell-Bytegrenze überschritten")));assert.ok(!all.some(n=>n.textContent.includes("noch nicht erledigt")));
 for(const ended of ["cancelled","expired"]){const historical=await ui({...base,tasks:[{...task,state:ended}]});await runInContext("selectTask(snapshot.tasks[0])",historical.ctx);const text=descendants(historical.get("detail-body")).map(n=>n.textContent).join(" ");assert.match(text,/Damals als gesehen markiert/);assert.ok(!text.includes("noch nicht erledigt"));}assert.ok(all.some(n=>/Budget.*60s.*1000ms.*1024/.test(n.textContent)));assert.match(descendants(u.get("status")).map(n=>n.textContent).join(" "),/Globale Budgets.*10.*5s/);
 const proposal={id:"p",task_id:"terminal",task_revision:3,target_id:"artifact",payload_hash:"a".repeat(64),payload:"after </script>",required_domains:["personal"]};
 (u.ctx as any).fixture={proposal,preview:{before:"before </pre>",after:proposal.payload},approved:false};await runInContext("showProposal(fixture)",u.ctx);
 const preview=descendants(u.get("preview")).map(n=>n.textContent);assert.ok(preview.includes("Vorher"));assert.ok(preview.includes("Nachher"));assert.ok(preview.includes("before </pre>"));assert.ok(preview.includes(proposal.payload));assert.ok(!u.get("preview").textContent.startsWith("{"));assert.match(u.get("binding").textContent,/payload_hash/);assert.equal(descendants(u.get("proposal")).find(n=>n.id==="task-execute-button")?.disabled,true);
});

test("browser shows compact reconsideration, owner choices and the detail command",async()=>{
 const snapshot={role:"owner",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const c={task_id:"t",occurrence_id:"o",goal:"Neubewertung",due_at:1000,timezone:"Europe/Madrid",compact:true,detail_command:"bastra tasks get t",why_now:"Geprüfte Prämissenänderung",reconsideration:{decision:{option:"A",reason:"Wartung",alternatives:["B"]},old_premise:"costly",new_premise:"cheap",new_evidence:{id:"evidence",revision:"v1",observed_at:1000},choices:["keep","change","snooze","stop"]}};
 const u=await ui(snapshot,{cards:[c],overflow:0});await (u.get("due") as any).onclick();const nodes=descendants(u.get("cards"));assert.ok(nodes.some(n=>n.textContent==="Neubewertung"));assert.ok(nodes.some(n=>n.textContent.includes("bastra tasks get t")));for(const label of ["Beibehalten","Zurückstellen","Abbrechen","Entscheidung ändern"])assert.ok(nodes.some(n=>n.textContent===label&&!n.disabled));
});

test("browser prevents duplicate execute reservations and releases its exact holder after failure",async()=>{
 const snapshot={role:"owner",controls:{enabled:true,muted:false,execution_stopped:false},runtime:{running:true},tasks:[],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:true}};
 const calls:any[]=[];const u=await ui(snapshot,undefined,{confirm:()=>true,fetch:async(url:string,args:any)=>{const input=JSON.parse(args.body);calls.push({url,input});return url.endsWith("task_lease")?{ok:true,json:async()=>({lease:{id:"l",fence:7},holder_token:"secret"})}:url.endsWith("task_execute")?{ok:false,json:async()=>({code:"approval_stale"})}:{ok:true,json:async()=>snapshot};}});
 (u.ctx as any).fixture={proposal:{id:"p",required_domains:["personal"]},preview:{before:"old",after:"new"},approved:true,binding_status:"current"};await runInContext("showProposal(fixture)",u.ctx);
 const button=descendants(u.get("proposal")).find(n=>n.id==="task-execute-button")!;await Promise.all([button.handlers.click(),button.handlers.click()]);
 assert.equal(calls.filter(c=>c.url.endsWith("task_lease")).length,1);assert.equal(calls.filter(c=>c.url.endsWith("task_execute")).length,1);const released=calls.find(c=>c.url.endsWith("task_release"));assert.deepEqual(released.input,{lease_id:"l",holder_token:"secret",fence:7});assert.equal(button.disabled,true);assert.match(u.get("message").textContent,/Vorschlag wurde geändert/);
});

test("browser header uses plain language without exposing technical session status",async()=>{
 const html=await readFile(new URL("../webui/index.html",import.meta.url),"utf8");assert.match(html,/Erinnerungen erscheinen beim nächsten Gespräch/);assert.match(html,/Vorbereiten und Ausführen brauchen deine Freigabe/);assert.ok(!html.includes("Zustellung ist ein Anzeigeversuch"));
});

test("task views separate active, completed and failed work and show scrubbed origin as text",async()=>{
 const base={role:"agent",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const template={original_request:"Synthetic",armed:true,action_level:"notify",schedule:{kind:"instant",at:1000},timezone:"Europe/Madrid",deliveries:[],origin:{kind:"agent-observed",client:"client",session:"synthetic",context:"literal </script>"}};
 const tasks=[{...template,id:"active",goal:"Active",state:"due"},{...template,id:"done",goal:"Done",state:"resolved",armed:false},{...template,id:"failed",goal:"Failed",state:"cancelled",armed:false}];const u=await ui({...base,tasks});
 for(const [column,goal] of [["due","Active"],["done","Done"],["failed","Failed"]]){const col=u.get("tasks").children.find(n=>n.dataset.taskColumn===column)!;const nodes=descendants(col);assert.equal(nodes.filter(n=>n.textContent===goal).length,1);for(const other of tasks.filter(t=>t.goal!==goal))assert.ok(!nodes.some(n=>n.textContent===other.goal));assert.ok(nodes.some(n=>n.textContent.includes("vom Agenten bemerkt")));}
 await runInContext("selectTask(snapshot.tasks[0])",u.ctx);assert.ok(descendants(u.get("detail-body")).some(n=>n.textContent.includes("literal </script>")));
 const html=await readFile(new URL("../webui/index.html",import.meta.url),"utf8");assert.match(html,/data-view="tasks"/);assert.match(html,/id="tasks-view"/);
});

test("retired legacy proposal shows new preparation without preview, signing or execution",async()=>{
 const snapshot={role:"owner",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[],capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000,review_required:0},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:true}};
 const u=await ui(snapshot);(u.ctx as any).fixture={proposal:{id:"old",task_id:"task",target_id:"artifact",status:"stale"},binding_status:"approval_stale",approved:false};await runInContext("showProposal(fixture)",u.ctx);
 const visible=descendants(u.get("preview")).map(n=>n.textContent).join(" ");assert.match(visible,/Vorschlag veraltet/);assert.match(visible,/Neue Vorbereitung und neue Freigaben/);assert.equal(u.get("binding").textContent,"");assert.equal(u.get("sign-command").textContent,"");assert.ok(!descendants(u.get("proposal")).some(n=>n.id==="task-execute-button"));
});

test("kanban locks unauthorized drop targets and blocked drops never call mutation endpoints",async()=>{
 const task={id:"prepare",goal:"Draft",original_request:"Synthetic",state:"pending",armed:false,action_level:"prepare",schedule:{kind:"instant",at:1000},timezone:"Europe/Madrid",deliveries:[]};
 const base={role:"agent",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[task],capacity:{},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const calls:string[]=[];const u=await ui(base,undefined,{fetch:async(url:string)=>{calls.push(url);return{ok:true,json:async()=>base};}});
 const cols=u.get("tasks").children,card=cols.find(c=>c.dataset.taskColumn==="planned")!.children[1].children[0];
 await card.handlers.dragstart({dataTransfer:{setData(){}}});
 assert.equal(cols.find(c=>c.dataset.taskColumn==="done")!.children[0].attributes["aria-disabled"],"true");
 assert.equal(cols.find(c=>c.dataset.taskColumn==="due")!.children[0].attributes["aria-disabled"],"true");
 assert.equal(cols.find(c=>c.dataset.taskColumn==="failed")!.children[0].attributes["aria-disabled"],"false");
 await cols.find(c=>c.dataset.taskColumn==="done")!.handlers.drop({preventDefault(){}});
 assert.equal(calls.filter(url=>url.endsWith("task_resolve")).length,0);
 assert.match(u.get("message").textContent,/nicht abgelegt/);
 for(const col of cols){assert.equal(col.children[0].attributes['aria-disabled'],'false');assert.ok(!col.classNames.has('locked'));assert.ok(!col.classNames.has('drop-target'));}
 await card.handlers.dragstart({dataTransfer:{setData(){}}});assert.ok(cols.some(col=>col.classNames.has('locked')));await card.handlers.dragend();
 for(const col of cols){assert.equal(col.children[0].attributes['aria-disabled'],'false');assert.ok(!col.classNames.has('locked'));assert.ok(!col.classNames.has('drop-target'));}
});

test("archive columns initially show the newest twenty and load older records on demand",async()=>{
 const tasks=Array.from({length:45},(_,i)=>({id:String(i),goal:`Entry ${i}`,original_request:"Synthetic",state:"resolved",armed:false,action_level:"notify",schedule:{kind:"instant",at:1000},updated_at:i,timezone:"Europe/Madrid",deliveries:[]}));
 const base={role:"agent",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks,capacity:{},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const u=await ui(base);const list=()=>u.get("tasks").children.find(c=>c.dataset.taskColumn==="done")!.children[1];
 assert.equal(list().children.filter(c=>c.className==="task-card").length,20);
 assert.equal(descendants(list().children[0]).find(c=>c.className==="task-card-title")?.textContent,"Entry 44");
 await list().children.find(c=>c.textContent==="Ältere Einträge laden")!.handlers.click();
 assert.equal(list().children.filter(c=>c.className==="task-card").length,40);
});

test("tasks are integrated into the app without standalone pages or foreign palette",async()=>{
 const html=await readFile(new URL("../webui/index.html",import.meta.url),"utf8"),css=await readFile(new URL("../webui/css/tasks.css",import.meta.url),"utf8"),app=await readFile(new URL("../webui/js/app.js",import.meta.url),"utf8");
 assert.ok(!html.includes("<iframe"));assert.match(app,/createTasksView/);assert.match(app,/location.hash === "#tasks"/);assert.ok(!css.match(/#[0-9a-f]{3,8}\b/i));assert.match(css,/border-radius: 0/);
});

test("permitted drop rereads the current revision before resolving and never signs or executes",async()=>{
 const task={id:"notify",goal:"Reminder",original_request:"Synthetic",state:"pending",armed:true,action_level:"notify",schedule:{kind:"instant",at:1000},timezone:"Europe/Madrid",deliveries:[]};
 const base={role:"agent",controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[task],capacity:{},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const calls:any[]=[];const u=await ui(base,undefined,{fetch:async(url:string,args:any)=>{calls.push({url,input:JSON.parse(args.body)});return{ok:true,json:async()=>url.endsWith('task_get')?{...task,expected_revision:'fresh-server-revision'}:base};}});
 const cols=u.get('tasks').children,card=cols.find(c=>c.dataset.taskColumn==='planned')!.children[1].children[0];await card.handlers.dragstart({dataTransfer:{setData(){}}});
 cols.find(c=>c.dataset.taskColumn==='done')!.handlers.drop({preventDefault(){}});await runInContext('new Promise(r=>setTimeout(r,0))',u.ctx);
 const resolved=calls.find(c=>c.url.endsWith('task_resolve'));assert.ok(resolved);assert.equal(resolved.input.expected_revision,'fresh-server-revision');assert.equal(resolved.input.id,'notify');assert.ok(!calls.some(c=>/task_(approval|lease|execute)$/.test(c.url)));
});

test("loaded archived generations remain visible alongside a rearmed live task and keep their inspector",async()=>{
 const template={id:'same-id',original_request:'Synthetic',armed:false,action_level:'notify',schedule:{kind:'instant',at:1000},timezone:'Europe/Madrid',deliveries:[]};
 const live={...template,goal:'Rearmed live task',state:'pending',generation:1,revision:3},archived={...template,goal:'Historical completed task',state:'resolved',generation:0,revision:2,archived:true,archive_id:'old',history:[]};
 const base={role:'agent',controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[live],capacity:{},intents:[{task_id:'same-id',state:'unknown',id:'new-intent',target_id:'target',at:1000,before_hash:'a',after_hash:'b'}],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const u=await ui(base);(u.ctx as any).historical=archived;await runInContext('coldTasks=[historical];renderBoard();selectTask(historical);refresh()',u.ctx);
 const done=u.get('tasks').children.find(c=>c.dataset.taskColumn==='done')!;assert.ok(descendants(done).some(n=>n.textContent===archived.goal));
 const detail=descendants(u.get('detail-body'));assert.ok(detail.some(n=>n.textContent===archived.goal));assert.ok(detail.some(n=>n.textContent.includes('Aus dem Archiv')));assert.ok(!detail.some(n=>n.textContent===live.goal));
});

test('plain task copy hides session chatter and keeps technical values in a closed disclosure',async()=>{
 const task={id:'copy',goal:'Mein normaler Titel',original_request:'Erinner mich daran',state:'pending',armed:false,action_level:'prepare',schedule:{kind:'instant',at:1000},timezone:'Europe/Madrid',deliveries:[],origin:{kind:'user-request',client:'technical-client',session:'technical-session',context:'Synthetic'},budget:{poll_interval_ms:60000,timeout_ms:1000,max_source_bytes:1048576}};
 const base={role:'agent',controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[task],capacity:{},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const u=await ui(base);const board=descendants(u.get('tasks')).map(n=>n.textContent).join(' ');assert.match(board,/Wartet auf deine Freigabe/);assert.ok(!/unscharf|scharf|Owner-Prüfung|technical-client|technical-session|Timeout/.test(board));assert.equal(u.get('message').hidden,true);
 await runInContext('selectTask(snapshot.tasks[0])',u.ctx);const detail=descendants(u.get('detail-body'));
 for(const label of ['Status','Fällig','Herkunft','Wortlaut','Nächste Prüfung','Letzte Zustellung'])assert.ok(detail.some(n=>n.textContent===label),label);
 const technical=detail.find(n=>n.children.some(c=>c.textContent==='Technische Details'))!;assert.equal(technical.open,false);assert.ok(descendants(technical).some(n=>n.textContent.includes('technical-client')));assert.ok(descendants(technical).some(n=>n.textContent.includes('Timeout 1000ms')));
 assert.ok(!detail.some(n=>n.textContent==='Freigeben'||n.textContent==='Bearbeiten'));
 assert.equal(detail.find(n=>n.textContent==='Vorbereiten')?.disabled,true);assert.ok(detail.some(n=>n.textContent==='Zum Vorbereiten fehlt noch die Freigabe dieser Aufgabe.'));
});

test('seen acknowledgement remains separate from task completion after the copy change',async()=>{
 const task={id:'ack',goal:'Reminder',original_request:'Synthetic',state:'due',armed:true,action_level:'notify',schedule:{kind:'instant',at:1000},timezone:'Europe/Madrid',deliveries:[]};
 const base={role:'agent',controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[task],capacity:{},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}},calls:string[]=[];
 const u=await ui(base,{cards:[{task_id:'ack',occurrence_id:'occurrence',goal:'Reminder',action_level:'notify',due_at:1000,timezone:'Europe/Madrid',why_now:'Fällig'}]}, {fetch:async(url:string)=>{calls.push(url);return{ok:true,json:async()=>url.endsWith('task_get')?{...task,expected_revision:'fresh'}:url.endsWith('task_due')?{cards:[{task_id:'ack',occurrence_id:'occurrence',goal:'Reminder',action_level:'notify',due_at:1000,timezone:'Europe/Madrid'}]}:base};}});
 await u.get('due').onclick();await descendants(u.get('cards')).find(n=>n.textContent==='Als gesehen markieren')!.handlers.click();assert.ok(calls.some(c=>c.endsWith('task_acknowledge')));assert.ok(!calls.some(c=>c.endsWith('task_resolve')));
});

test('successful task actions visibly announce their result in the shared status region',async()=>{
 const base={role:'agent',controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[],capacity:{},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
 const u=await ui(base);await runInContext("message('Aufgabe gespeichert.')",u.ctx);assert.equal(u.get('message').hidden,false);assert.equal(u.get('message').textContent,'Aufgabe gespeichert.');assert.equal(u.get('message').dataset.kind,'success');
 await runInContext("message('')",u.ctx);assert.equal(u.get('message').hidden,true);
 const html=await readFile(new URL('../webui/index.html',import.meta.url),'utf8');assert.match(html,/id="task-message"[^>]*role="status"[^>]*aria-live="polite"/);
});


const liveBase={role:'agent',controls:{enabled:true,muted:false,execution_stopped:true},runtime:{running:true},tasks:[],capacity:{},intents:[],receipts:[],sources:[],adapters:[],proposals:[],approval:{enrolled_domains:[],protected_boundary:false}};
const liveTask={id:'outside',goal:'Created outside',original_request:'Synthetic',state:'pending',armed:true,action_level:'notify',schedule:{kind:'instant',at:1000},timezone:'Europe/Madrid',deliveries:[]};
async function liveUI(){
 let status:any=liveBase,tick:Function|undefined,calls=0,fail='';
 const u=await ui(status,undefined,{setInterval:(fn:Function)=>{tick=fn;return 1;},clearInterval:()=>{tick=undefined;},fetch:async()=>{calls++;if(fail==='network')throw new Error('offline');return{ok:!fail,json:async()=>fail?{code:fail}:status};}});
 await runInContext("token='fixture';open()",u.ctx);await new Promise(r=>setTimeout(r,0));
 return {...u,change:(next:any)=>{status=next;},fail:(kind:string)=>{fail=kind;},calls:()=>calls,tick:async()=>{await tick?.();}};
}
test('external task changes poll only in the visible view/window and returning refreshes immediately',async()=>{
 const u=await liveUI();u.change({...liveBase,tasks:[liveTask]});await u.tick();assert.ok(descendants(u.get('tasks')).some(n=>n.textContent===liveTask.goal));
 const before=u.calls();await runInContext('close()',u.ctx);await u.tick();assert.equal(u.calls(),before);
 await runInContext('open()',u.ctx);await new Promise(r=>setTimeout(r,0));assert.equal(u.calls(),before+1);
 const doc=(u.ctx as any).document;doc.hidden=true;await doc.handlers.visibilitychange();const hiddenCalls=u.calls();await u.tick();assert.equal(u.calls(),hiddenCalls);
 doc.hidden=false;await doc.handlers.visibilitychange();assert.equal(u.calls(),hiddenCalls+1);
});
test('background polling leaves drag, dialogs, unchanged board and loaded archives intact',async()=>{
 const u=await liveUI();u.change({...liveBase,tasks:[liveTask]});await runInContext('refresh()',u.ctx);
 const cols=u.get('tasks').children,card=cols[0].children[1].children[0];cols[0].children[1].scrollTop=125;const doc=(u.ctx as any).document;doc.activeElement=card.children[0];
 await u.tick();assert.equal(u.get('tasks').children[0],cols[0]);
 await card.handlers.dragstart({dataTransfer:{setData(){}}});u.change({...liveBase,tasks:[{...liveTask,goal:'New goal'}]});await u.tick();assert.equal(u.get('tasks').children[0],cols[0]);await card.handlers.dragend();
 u.get('compose').showModal();u.get('goal').value='Unsubmitted input';await u.tick();assert.equal(u.get('tasks').children[0],cols[0]);assert.equal(u.get('goal').value,'Unsubmitted input');u.get('compose').close();
 await runInContext("coldTasks=[{...snapshot.tasks[0],id:'archived',goal:'Old record',state:'resolved',archived:true}];",u.ctx);
 await u.tick();assert.ok(descendants(u.get('tasks')).some(n=>n.textContent==='New goal'));assert.ok(descendants(u.get('tasks')).some(n=>n.textContent==='Old record'));assert.equal(u.get('tasks').children[0].children[1].scrollTop,125);assert.equal(doc.activeElement,u.get('tasks').children[0].children[1].children[0].children[0]);
 await runInContext('selectTask(snapshot.tasks[0])',u.ctx);const details=u.get('detail-body').children;u.change({...liveBase,tasks:[]});await u.tick();assert.equal(u.get('detail-body').children,details);assert.equal(u.get('detail').open,true);
});
test('background failure keeps last good board and success message, expired access is shown once',async()=>{
 const u=await liveUI();await runInContext("message('Aufgabe gespeichert.')",u.ctx);const board=u.get('tasks').children;
 u.fail('network');await u.tick();assert.equal(u.get('tasks').children,board);assert.equal(u.get('message').textContent,'Aufgabe gespeichert.');
 u.fail('unauthorized');await u.tick();assert.match(u.get('message').textContent,/abgelaufen/);const calls=u.calls();await u.tick();assert.equal(u.calls(),calls);assert.equal(u.get('tasks').children,board);
});


test('topbar accent border follows only search inputs, with separate keyboard focus on view buttons',async()=>{
 const css=await readFile(new URL('../webui/css/search.css',import.meta.url),'utf8');
 assert.ok(!css.includes('#searchbox:focus-within'));
 assert.match(css,/#searchbox:has\(#search:focus,\s*#chat-input:focus\)/);
 const topbar=await readFile(new URL('../webui/css/topbar.css',import.meta.url),'utf8');
 assert.match(topbar,/#view-switch button:focus-visible/);
});

test('background redraw preserves archive-button focus and falls back safely when an action disappears',async()=>{
 const u=await liveUI(),archives=[{id:'old',at:1000,task_count:1}],base={...liveBase,archives,tasks:[liveTask]};u.change(base);await runInContext('refresh()',u.ctx);
 const doc=(u.ctx as any).document,archive=()=>u.get('tasks').children.find(c=>c.dataset.taskColumn==='done')!.children[1].children.at(-1)!;
 doc.activeElement=archive();u.change({...base,tasks:[{...liveTask,goal:'Changed outside'}]});await u.tick();assert.equal(doc.activeElement,archive());
 const card=u.get('tasks').children[0].children[1].children[0];doc.activeElement=descendants(card).find(n=>n.textContent==='Erledigt');u.change({...base,tasks:[{...liveTask,state:'resolved'}]});await u.tick();
 const done=u.get('tasks').children.find(c=>c.dataset.taskColumn==='done')!.children[1].children[0];assert.equal(doc.activeElement,done.children[0]);
});

test('moving runtime check timestamps do not rebuild the board; a visible change rebuilds once',async()=>{
 const u=await liveUI();u.change({...liveBase,tasks:[liveTask]});await runInContext('refresh()',u.ctx);
 const board=u.get('tasks'),replace=board.replaceChildren.bind(board);let rebuilds=0;board.replaceChildren=(...nodes:Node[])=>{rebuilds++;replace(...nodes);};
 for(let i=1;i<=5;i++){u.change({...liveBase,runtime:{running:true,next_tick:i*60000},tasks:[{...liveTask,next_check_at:i*60000}]});await u.tick();}
 assert.equal(rebuilds,0);assert.ok(descendants(u.get('status')).some(n=>n.textContent.includes('nächste Prüfung')));
 await board.children[0].children[1].children[0].children[0].handlers.click();assert.ok(descendants(u.get('detail-body')).some(n=>n.textContent===runInContext('time(300000,snapshot.tasks[0].timezone)',u.ctx)));u.get('detail').close();
 u.change({...liveBase,tasks:[{...liveTask,goal:'Visible change'}]});await u.tick();assert.equal(rebuilds,1);assert.ok(descendants(board).some(n=>n.textContent==='Visible change'));
 // next_check_at is not ignored when it is the actual visible due-time fallback.
 const event={...liveTask,schedule:{kind:'event'},next_check_at:60000};u.change({...liveBase,tasks:[event]});await u.tick();const before=board.children;
 u.change({...liveBase,tasks:[{...event,next_check_at:120000}]});await u.tick();assert.notEqual(board.children,before);
});

test('own inspector action immediately shows the new task state and valid actions',async()=>{
 let status:any={...liveBase,tasks:[{...liveTask,state:'due'}]};
 const u=await ui(status,undefined,{fetch:async(url:string)=>{if(url.endsWith('task_get'))return{ok:true,json:async()=>({expected_revision:'0:0'})};if(url.endsWith('task_resolve'))status={...liveBase,tasks:[{...liveTask,state:'resolved'}]};return{ok:true,json:async()=>status};}});
 await runInContext('selectTask(snapshot.tasks[0])',u.ctx);await descendants(u.get('detail-body')).find(n=>n.textContent==='Erledigt')!.handlers.click();
 const details=descendants(u.get('detail-body'));assert.equal(u.get('detail').open,true);assert.ok(details.some(n=>n.textContent==='erledigt'));
 for(const label of ['Erledigt','Zurückstellen','Abbrechen'])assert.ok(!details.some(n=>n.textContent===label),label);
 assert.ok(descendants(u.get('tasks').children.find(n=>n.dataset.taskColumn==='done')!).some(n=>n.textContent===liveTask.goal));assert.equal(u.get('message').textContent,'Aufgabe aktualisiert.');
});

test('reconnect paints the board when a timer response supersedes the foreground refresh',async()=>{
 const status={...liveBase,tasks:[liveTask]};let tick:Function|undefined,defer=false;const gates:Array<()=>void>=[];
 const u=await ui(status,undefined,{setInterval:(fn:Function)=>{tick=fn;return 1;},clearInterval:()=>{},fetch:async()=>{if(defer)await new Promise<void>(resolve=>gates.push(resolve));return{ok:true,json:async()=>status};}});
 await runInContext("token='fixture';open()",u.ctx);await new Promise(r=>setTimeout(r,0));u.get('disconnect').onclick();assert.equal(u.get('tasks').children.length,0);
 defer=true;u.get('token').value='fixture';u.get('connect').handlers.submit({preventDefault(){}});const background=tick!();assert.equal(gates.length,2);
 gates[1]();await background;gates[0]();await new Promise(r=>setTimeout(r,0));assert.equal(u.get('workspace').hidden,false);assert.equal(u.get('tasks').children.length,5);assert.ok(descendants(u.get('tasks')).some(n=>n.textContent===liveTask.goal));
});
