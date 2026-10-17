import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { friendlyTaskCreate, friendlyTaskResult, friendlyTaskError } from "../src/cli/task-friendly.js";
import { parseArgs } from "../src/cli/commands.js";
import { mintTaskCredential, revokeTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { dispatchTaskHttp } from "../src/task-transport.js";
import { configureTaskHooks, taskClientCoverage } from "../src/cli/task-setup.js";
import { taskClientToken, taskHookConfigPath } from "../src/task-client-auth.js";
import { readTaskStore } from "../src/task-store.js";
import { reconcileTaskTime } from "../src/task-events.js";
test("human options select elapsed/calendar times, timezone and explicit arm; typos fail before action", () => {
  const args = parseArgs(["tasks", "create", "--goal", "Nach sieben Tagen auswerten", "--after", "7d", "--timezone", "Europe/Madrid", "--arm"]); assert.deepEqual(args.errors, []);
  const task = friendlyTaskCreate({ goal: "Auswerten", after: "7d", timezone: "Europe/Madrid", arm: true }, 1000) as any;
  assert.equal(task.schedule.at, 1000 + 7 * 86400000); assert.equal(task.arm, true);
  assert.equal((friendlyTaskCreate({ goal: "Termin", when: "2026-10-12T18:00", timezone: "Europe/Madrid" }) as any).schedule.kind, "calendar");
  assert.ok(parseArgs(["tasks", "create", "--aftr", "7d"]).errors!.length); assert.ok(parseArgs(["uninstall", "--arm"]).errors!.length);
  assert.throws(() => friendlyTaskCreate({ goal: "DST gap", when: "2026-03-29T02:30", timezone: "Europe/Madrid" }));
});
test("compiled bastra tasks due exists, is readable and preserves --json machine output", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-cli-friendly-")); const ctx = { path: join(root, "tasks.json"), authPath: join(root, "task-auth.json"), now: () => Date.now() };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", role: "owner", domains: ["personal"] });
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "client", role: "agent", domains: ["personal"] });
  await callTaskCrud(ctx, `Bearer ${owner.token}`, "task_create", { ...friendlyTaskCreate({ goal: "Evaluierung", after: "1m", timezone: "Europe/Madrid", arm: true }, Date.now() - 120000) }); await reconcileTaskTime(ctx);
  const server = createServer((req, res) => { if (!dispatchTaskHttp(req, res, req.method!, req.url!, ctx)) { res.writeHead(404); res.end(); } }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const run = async (argv: string[]) => { const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "tasks", ...argv], { env: { ...process.env, BASTRA_TASKS_PATH: ctx.path, BASTRA_DAEMON_URL: `http://127.0.0.1:${(server.address() as any).port}`, BASTRA_TASK_TOKEN: agent.token, BASTRA_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] }); let output="", errors=""; child.stdout.on("data", c=>{output+=c;});child.stderr.on("data",c=>{errors+=c;}); const [code]=await once(child,"exit"); return { code, output, errors }; };
  try {
    const due = await run(["due", "--agent"]); assert.equal(due.code, 0, due.errors); assert.match(due.output, /Evaluierung/); assert.match(due.output, /fällig/); assert.match(due.output, /Europe\/Madrid/);
    const list = await run(["list", "--agent"]); assert.equal(list.code, 0); assert.match(list.output, /scharf/);
    const json = await run(["list", "--agent", "--json"]); assert.equal(JSON.parse(json.output).tasks.length, 1);
    const capture = await run(["create", "--agent", "--goal", "Prüfen", "--after", "7d", "--timezone", "Europe/Madrid"]); assert.equal(capture.code, 0, capture.errors); assert.match(capture.output, /unscharf/);
    const armed = await run(["create", "--agent", "--goal", "Erinnern", "--after", "7d", "--arm"]); assert.equal(armed.code, 0, armed.errors); assert.match(armed.output, /scharf/);
    const denied = await run(["create", "--agent", "--goal", "Prüfen", "--after", "7d", "--arm", "--level", "prepare"]); assert.equal(denied.code, 1); assert.match(denied.errors, /Owner/);
    assert.equal((await readTaskStore(ctx.path)).tasks.length, 3);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
test("one owner setup gives hooks a private separate agent credential; missing/revoked/unsafe status is honest", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-hook-config-")), path = join(root, "tasks.json"), authPath = join(root, "task-auth.json");
  const previousPath=process.env.BASTRA_TASKS_PATH, previousToken=process.env.BASTRA_TASK_TOKEN; process.env.BASTRA_TASKS_PATH=path; delete process.env.BASTRA_TASK_TOKEN;
  try {
    assert.equal((await taskClientCoverage()).authorized, false);
    const owner = await mintTaskCredential(authPath, { actor_id: "owner", role: "owner", domains: ["personal"] });
    const result = await configureTaskHooks(`Bearer ${owner.token}`); const config = JSON.parse(await readFile(taskHookConfigPath(), "utf8"));
    assert.equal(config.token, taskClientToken()); assert.equal((await stat(taskHookConfigPath())).mode & 0o077, 0);
    const status = await taskClientCoverage(); assert.equal(status.authorized, true); assert.equal((status as any).role, "agent");
    await revokeTaskCredential(authPath, result.credential_id); assert.equal((await taskClientCoverage()).authorized, false);
    await chmod(taskHookConfigPath(), 0o644); assert.equal(taskClientToken(), undefined);
  } finally { if(previousPath===undefined)delete process.env.BASTRA_TASKS_PATH;else process.env.BASTRA_TASKS_PATH=previousPath;if(previousToken===undefined)delete process.env.BASTRA_TASK_TOKEN;else process.env.BASTRA_TASK_TOKEN=previousToken; }
});
test("global controls require owner/all domains, pause preserves obligations and resume does not renew authority", async () => {
  const root=await mkdtemp(join(tmpdir(),"task-controls-")),ctx={path:join(root,"tasks.json"),authPath:join(root,"auth.json")};
  const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]}),agent=await mintTaskCredential(ctx.authPath,{actor_id:"agent",role:"agent",domains:["personal"]});
  await callTaskCrud(ctx,`Bearer ${owner.token}`,"task_create",friendlyTaskCreate({goal:"Task",after:"1m",arm:true}));
  await assert.rejects(callTaskCrud(ctx,`Bearer ${agent.token}`,"task_controls",{muted:true}),/owner/);
  await callTaskCrud(ctx,`Bearer ${owner.token}`,"task_controls",{enabled:false,muted:true});const paused=await readTaskStore(ctx.path);
  await callTaskCrud(ctx,`Bearer ${owner.token}`,"task_controls",{enabled:true,muted:false});const resumed=await readTaskStore(ctx.path);
  assert.deepEqual(resumed.tasks,paused.tasks);assert.deepEqual(resumed.approvals,paused.approvals);assert.deepEqual(resumed.leases,paused.leases);
  await assert.rejects(callTaskCrud(ctx,`Bearer ${owner.token}`,"task_controls",{execution_stopped:false}),/Protected/);
});
test("readable states, local times, controls, off-status and errors keep machine JSON separate",()=>{
 const task:any={id:"task",goal:"Prüfen",schedule:{kind:"instant",at:Date.parse("2026-10-12T16:00:00Z")},timezone:"Europe/Madrid",armed:false,state:"snoozed",action_level:"notify",snoozed_until:Date.parse("2026-10-13T16:00:00Z"),deliveries:[]};
 assert.match(friendlyTaskResult("snooze",task),/zurückgestellt/);assert.match(friendlyTaskResult("snooze",task),/18:00/);assert.match(friendlyTaskResult("rearm",task),/UNSCHARF/);
 const base={controls:{enabled:false,muted:true,execution_stopped:true},runtime:{running:true,next_tick:0,last_error:null,backoff_ms:0},tasks:[task],sources:[],adapters:[],approval:{enrolled_domains:[],protected_boundary:false},capacity:{intents:0,intent_limit:1000,receipts:0,receipt_limit:10000},intents:[],receipts:[]};
 const status=friendlyTaskResult("status",base);assert.match(status,/Funktion: aus/);assert.match(status,/Automatik: aus/);assert.match(status,/Letzte Zustellung: noch keine/);assert.match(status,/Letzter Job-Fehler: keiner/);
 task.verification={outcome:"inconclusive",reason:"irrelevant_claim",checked_at:123};
 assert.match(friendlyTaskResult("status",base),/unklar\/strittig.*andere Prämisse/);
 assert.match(friendlyTaskResult("mute",{controls:base.controls,resumed_authority:false}),/Stumm geschaltet/);assert.ok(!friendlyTaskResult("stop",{controls:base.controls,resumed_authority:false}).startsWith("{"));
 assert.match(friendlyTaskError("not_found","cancel"),/unbekannt/);assert.match(friendlyTaskError("protected_boundary_required","resume"),/standardmäßig gestoppt/);
});
test("human recurrence is bounded and ambiguous autumn time stays visibly unarmed",()=>{
 const repeating=friendlyTaskCreate({goal:"Täglich",when:"2026-10-12T18:00",timezone:"Europe/Madrid",every:"1d",count:"3"}) as any;assert.equal(repeating.recurrence.kind,"calendar");assert.equal(repeating.recurrence.count,3);
 assert.throws(()=>friendlyTaskCreate({goal:"Endlos",after:"7d",every:"1d"}));
 const ambiguous=friendlyTaskCreate({goal:"Herbst",when:"2026-10-25T02:30",timezone:"Europe/Madrid",arm:true}) as any;assert.equal(ambiguous.arm,false);assert.match(friendlyTaskResult("create",{...ambiguous,id:"fixture",state:"pending",armed:false}),/Mehrdeutige Ortszeit/);
});
test("explicit owner due is always inspectable when muted/off; passive clients stay quiet",async()=>{
 const root=await mkdtemp(join(tmpdir(),"owner-due-inspect-")),ctx={path:join(root,"tasks.json"),authPath:join(root,"auth.json"),now:()=>120000};
 const owner=await mintTaskCredential(ctx.authPath,{actor_id:"owner",role:"owner",domains:["personal"]}),agent=await mintTaskCredential(ctx.authPath,{actor_id:"agent",role:"agent",domains:["personal"]});
 await callTaskCrud(ctx,`Bearer ${owner.token}`,"task_create",friendlyTaskCreate({goal:"Fällig",after:"1m",timezone:"Europe/Madrid",arm:true},0));await reconcileTaskTime(ctx);
 await callTaskCrud(ctx,`Bearer ${owner.token}`,"task_controls",{enabled:false,muted:true});assert.equal((await callTaskCrud(ctx,`Bearer ${owner.token}`,"task_due",{}) as any).cards.length,1);assert.equal((await callTaskCrud(ctx,`Bearer ${agent.token}`,"task_due",{}) as any).cards.length,0);
});
test("private owner cache is separate from hook access, rejects automation and remains revocable",async()=>{
 const root=await mkdtemp(join(tmpdir(),"owner-cache-")),path=join(root,"tasks.json"),authPath=join(root,"task-auth.json"),previous=process.env.BASTRA_TASKS_PATH,token=process.env.BASTRA_TASK_TOKEN;process.env.BASTRA_TASKS_PATH=path;delete process.env.BASTRA_TASK_TOKEN;
 try{const {saveOwnerTaskAccess,ownerTaskAccessPath,ownerTaskAuthorization}=await import("../src/cli/task-owner-access.js");const owner=await mintTaskCredential(authPath,{actor_id:"owner",role:"owner",domains:["personal"]});await saveOwnerTaskAccess(`Bearer ${owner.token}`);assert.equal((await stat(ownerTaskAccessPath())).mode&0o077,0);assert.equal(taskClientToken(),undefined);await assert.rejects(ownerTaskAuthorization(),/terminal/);const agent=await mintTaskCredential(authPath,{actor_id:"agent",role:"agent",domains:["personal"]});await assert.rejects(saveOwnerTaskAccess(`Bearer ${agent.token}`),/owner/);}
 finally{if(previous===undefined)delete process.env.BASTRA_TASKS_PATH;else process.env.BASTRA_TASKS_PATH=previous;if(token===undefined)delete process.env.BASTRA_TASK_TOKEN;else process.env.BASTRA_TASK_TOKEN=token;}
});

test("mid-flow errors name DST gap, bounded repeat and past snooze; declining resume is not an agent error",async()=>{
 assert.throws(()=>friendlyTaskCreate({goal:"Gap",when:"2026-03-29T02:30",timezone:"Europe/Madrid"}),/Sommerzeit/);
 assert.throws(()=>friendlyTaskCreate({goal:"Repeat",after:"7d",every:"1d"}),/--count.*--end/);
 assert.match(friendlyTaskError("validation","snooze","snooze_past"),/Vergangenheit/);assert.match(friendlyTaskError("forbidden","resume","owner_declined"),/Nicht bestätigt/);
 const f:any={id:"t",goal:"Test",schedule:{kind:"instant",at:1},timezone:"Europe/Madrid",state:"pending",armed:false,action_level:"notify",review_reason:"Explicit owner review required",budget:{poll_interval_ms:60000,timeout_ms:1000,max_source_bytes:1024}};
 assert.ok(!friendlyTaskResult("get",f).includes("Explicit"));assert.match(friendlyTaskResult("get",f),/Budget.*60s/);assert.ok(!friendlyTaskResult("due",{cards:[{...f,due_at:1,task_id:"t",occurrence_id:"o",why_now:"Registered condition is due; evaluation is not a passed measurement gate"}],overflow:0}).includes("Registered condition"));
});
