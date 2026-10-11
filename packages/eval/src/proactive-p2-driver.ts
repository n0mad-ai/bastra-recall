/** Actual P2 daemon/HTTP/MCP/CLI observations. No synthetic runtime or human attestations. */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ACTION_CASES, actionFixture, runActions } from "./proactive-action-driver.js";
import type { FeatureDriver } from "./proactive-measurement-run.js";
const arg = process.argv.indexOf("--feature-root");
if (arg < 0) throw new Error("feature-root required");
const feature = resolve(process.argv[arg + 1]);
const commit = execFileSync("git", ["-C", feature, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const design = readFileSync(join(feature, "docs/design/proactive-tasks.md"), "utf8");
const daemonDir = join(feature, "packages/daemon/dist");
const { configFingerprint } = await import(pathToFileURL(join(daemonDir,"daemon-spawn-env.js")).href);
const auth = await import(pathToFileURL(join(daemonDir, "task-auth.js")).href);
const sourceApi = existsSync(join(daemonDir,"task-events.js")) ? await import(pathToFileURL(join(daemonDir,"task-events.js")).href) : undefined;
const storeApi = await import(pathToFileURL(join(daemonDir, "task-store.js")).href);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit"); child.kill("SIGTERM");
  const finished = await Promise.race([done.then(() => true), delay(2000).then(() => false)]);
  if (!finished) { child.kill("SIGKILL"); await done; }
}

const driver: FeatureDriver = {
  metadata: { feature_commit: commit, contract_prs: { P0: 1159, P1: 1164, P2: 1170, P2a: 1167, P2b: 1169, ...(existsSync(join(daemonDir,"task-events.js")) ? {P3:1171} : {}), ...(existsSync(join(daemonDir,"task-runtime.js")) ? {P5a:1175} : {}), ...(existsSync(join(daemonDir,"task-delivery.js")) ? {P5:1179} : {}), ...(existsSync(join(daemonDir,"task-execution.js")) ? {P7:1181,P8:1183,P9:1182} : {}) },
    supported_cases: ["p3-source-key-tuple-boundary","p3-automatic-evaluation","p3-returning-source-transitions","p2-auth-boundaries","p2-transport-parity","p2-owner-lifecycle","p2-durable-restart","p2-concurrency-cas","p1-p2-corruption-recovery","dst-recurrence-rollback","seven-day-evaluation","active-session-deadline","offline-restart","relay-overflow-disabled-purged","multi-client-occurrence","acknowledged-unfinished",...ACTION_CASES],
    design_sha256: createHash("sha256").update(design).digest("hex"), adapter: "synthetic registered local-artifact-v1 for action cases; none for notify/CRUD", client: "HTTP + MCP stdio forwarder + actual CLI", profile: "isolated synthetic-local P2",
    support_sha256: Object.fromEntries([...["index.js","task-service.js","task-auth.js","task-store.js","task-transport.js","mcp-forwarder.js","cli.js","task-events.js","task-clock.js","daemon-spawn-env.js","task-runtime.js","task-outbox.js","task-delivery.js","task-execution.js","task-actions.js","task-approval-keys.js"].filter(name => existsSync(join(daemonDir,name))).map(name => [name,createHash("sha256").update(readFileSync(join(daemonDir,name))).digest("hex")]), ["package-lock",createHash("sha256").update(readFileSync(join(feature,"package-lock.json"))).digest("hex")], ["crash-guard",createHash("sha256").update(readFileSync(new URL("./proactive-crash-guard.mjs",import.meta.url))).digest("hex")], ["action-driver",createHash("sha256").update(readFileSync(new URL("./proactive-action-driver.ts",import.meta.url))).digest("hex")], ["network-guard",createHash("sha256").update(readFileSync(new URL("./proactive-network-guard.mjs",import.meta.url))).digest("hex")]]) },
  async run(c, context) {
    const { root, port, repetition } = context;
    if (port === 6723 || context.feature_root !== feature) throw new Error("isolated context mismatch");
    const vault = join(root, "vault"), taskPath = join(root, "data/tasks.json"), authPath = join(root, "data/task-auth.json");
    mkdirSync(vault, { recursive: true, mode: 0o700 }); mkdirSync(join(root, "home"), { mode: 0o700 });
    const base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, "home"), USERPROFILE: join(root, "home"), TMPDIR: root,
      BASTRA_MEASUREMENT_ROOT: root, BASTRA_TASKS_PATH: taskPath, BASTRA_VAULT_PATH: vault,
      BASTRA_HTTP_PORT: String(port), BASTRA_DAEMON_URL: base, BASTRA_FORWARDER_SPAWN: "0",
      BASTRA_EMBEDDING_PROVIDER: "none", BASTRA_UPDATE_CHECK: "off", BASTRA_CODE_AWARENESS: "0", BASTRA_TELEMETRY: "0",
      BASTRA_LOG_PATH: join(root, "logs"), BASTRA_API_TOKEN: "legacy-fixture", BASTRA_RM_ARCHIVES: "0",
      BASTRA_PENDING_SUGGESTIONS_PATH: join(root,"relay.json"), BASTRA_DRAFTS_PATH: join(root,"drafts.json"), BASTRA_PENDING_RELAY: "1",
      BASTRA_OLLAMA_AUTOSTART: "0", BASTRA_COMMONS_PATH: join(root, "commons"),
      NODE_OPTIONS: `--import ${fileURLToPath(new URL("./proactive-network-guard.mjs", import.meta.url))}` };
    const owner = await auth.mintTaskCredential(authPath, { actor_id: "fixture-owner", domains: ["personal"], role: "owner" });
    const agent = await auth.mintTaskCredential(authPath, { actor_id: "fixture-agent", domains: ["personal"], role: "agent" });
    const other = await auth.mintTaskCredential(authPath, { actor_id: "other-owner", domains: ["other"], role: "owner" });
    const tokens: Record<string,string | undefined> = { owner: owner.token, agent: agent.token, other: other.token, legacy: "legacy-fixture", absent: undefined };
    const crashPath=join(root,"fixture-crash.json");
    if(c.id==="external-success-no-receipt") {env.BASTRA_MEASUREMENT_CRASH_PATH=crashPath;env.NODE_OPTIONS+=` --import ${fileURLToPath(new URL("./proactive-crash-guard.mjs",import.meta.url))}`;}
    const clockPath = join(root,"fixture-clock.json");
    if (ACTION_CASES.includes(c.id) || ["dst-recurrence-rollback","p3-automatic-evaluation","p3-returning-source-transitions","seven-day-evaluation","active-session-deadline","offline-restart","relay-overflow-disabled-purged","multi-client-occurrence","acknowledged-unfinished"].includes(c.id)) { writeFileSync(clockPath,String(Date.parse("2026-10-24T12:00:00Z")),{mode:0o600}); env.BASTRA_MEASUREMENT_NOW_PATH=clockPath; }
    const evidence: any[] = [{ root, port, feature_commit: commit, synthetic_credentials: true, reference_instant: context.reference_instant,
      clock_mode: env.BASTRA_MEASUREMENT_NOW_PATH ? "child-only frozen Date.now; real host timers" : "real wall clock for auth/CRUD; no frozen-clock trigger claim", crud_schedule_at: Date.parse(context.reference_instant) + 86400000 }];
    const processes: ChildProcessWithoutNullStreams[] = [];
    const logs: Record<string, string> = {};
    function child(name: string, entry: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
      const p = spawn(process.execPath, [join(daemonDir, entry), ...args], { cwd: feature, env: { ...env, ...extra }, stdio: "pipe" });
      processes.push(p); logs[name] = "";
      p.stderr.on("data", d => { logs[name] += d.toString(); }); return p;
    }
    let daemon: ChildProcessWithoutNullStreams;
    async function start() {
      daemon = child(`daemon-${processes.length}`, "index.js"); daemon.stdout.resume();
      for (let i = 0; i < 150; i++) {
        if (daemon.exitCode !== null) throw new Error("daemon exited during setup");
        try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) }); if (r.ok) { const health = await r.json() as any; if (health.build_revision !== commit || health.config_fingerprint !== configFingerprint(env)) throw new Error("health identity disagrees with pinned isolated configuration"); evidence.push({ health }); return; } } catch {}
        await delay(100);
      } throw new Error("isolated daemon startup timeout");
    }
    async function http(method: string, path: string, body: unknown = undefined, persona = "owner", headers: Record<string,string> = {}) {
      const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(tokens[persona] ? { Authorization: `Bearer ${tokens[persona]}` } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      const data = await response.json() as any; evidence.push({ transport: "http", method, path, persona, input: body, status: response.status, result: data });
      return { status: response.status, data };
    }
    const input = (key = "fixture") => ({ idempotency_key: key, original_request: "Check invented run after seven days", goal: "Evaluate invented run",
      resolution_condition: "Explicit fixture-owner resolution", schedule: { kind: "instant", at: Date.parse(context.reference_instant) + 86400000 }, timezone: "Europe/Madrid",
      scope: { kind: "personal", name: "measurement" }, owner_domains: ["personal"] });
    async function create(key = "fixture", persona = "owner") { const r = await http("POST", "/api/v1/tasks", input(key), persona); if (r.status !== 200) throw new Error("fixture creation failed"); return r.data; }
    async function op(name: string, task: any, more: object = {}, persona = "owner") { return http("POST", `/api/v1/task_${name}`, { id: task.id, expected_revision: task.expected_revision, ...more }, persona); }
    async function cli(sub: string, body: unknown) {
      const path = join(root, `cli-${evidence.length}.json`); writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
      const p = child(`cli-${evidence.length}`, "cli.js", ["tasks", sub, "agent", path, "--json"], { BASTRA_TASK_TOKEN: agent.token });
      let stdout = "", stderr = ""; p.stdout.on("data", d => { stdout += d; }); p.stderr.on("data", d => { stderr += d; });
      const [exit] = await once(p, "exit");
      const data = JSON.parse(exit === 0 ? stdout : stderr.trim().split("\n").at(-1)!);
      evidence.push({ transport: "cli-process", sub, input: body, exit, result: data }); return data;
    }
    let mcp: ChildProcessWithoutNullStreams | undefined;
    let seq = 0;
    const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
    async function rpc(method: string, params: object) {
      const id = ++seq;
      return new Promise<any>((ok, fail) => {
        const timer = setTimeout(() => { waiting.delete(id); fail(new Error("MCP request timeout")); }, 10000);
        waiting.set(id, { ok: v => { clearTimeout(timer); ok(v); }, fail: e => { clearTimeout(timer); fail(e); } });
        mcp!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    async function mcpCall(name: string, args: object) {
      if (!mcp) {
        mcp = child("mcp", "mcp-forwarder.js", [], { BASTRA_TASK_TOKEN: agent.token });
        let pending = "";
        mcp.stdout.on("data", d => {
          pending += d; let n;
          while ((n = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0,n); pending = pending.slice(n+1);
            const message = JSON.parse(line);
            if (waiting.has(message.id)) { const w = waiting.get(message.id)!; waiting.delete(message.id); message.error ? w.fail(new Error(JSON.stringify(message.error))) : w.ok(message.result); }
          }
        });
        await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "measurement-fixture", version: "1" } });
        mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })+"\n");
      }
      const raw = await rpc("tools/call", { name, arguments: args });
      const data = JSON.parse(raw.content[0].text);
      evidence.push({ transport: "actual-mcp-stdio", name, input: args, isError: raw.isError ?? false, result: data }); return data;
    }
    const action = ACTION_CASES.includes(c.id) ? await actionFixture(feature,root,authPath,tokens,auth) : undefined;
    let values: Record<string, boolean | number | string> = {};
    try {
      await start();
      const deliveryCases=["seven-day-evaluation","active-session-deadline","offline-restart","relay-overflow-disabled-purged","multi-client-occurrence","acknowledged-unfinished"];
      if(ACTION_CASES.includes(c.id)) {
        values=await runActions(c,{http,input,fixture:action,clockPath,taskPath,evidence,start,crashPath,stopDaemon:()=>stop(daemon!)});
      } else if(deliveryCases.includes(c.id)) {
        const t0=Date.parse("2026-10-24T12:00:00Z");
        const snapshot=()=>JSON.parse(readFileSync(taskPath,"utf8"));
        const setClock=(at:number)=>{writeFileSync(clockPath,String(at));evidence.push({frozen_clock:at});};
        const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+5000;while(!predicate(snapshot())&&Date.now()<end)await delay(50);return snapshot();};
        const make=async(key:string,at:number)=>{const r=await http("POST","/api/v1/tasks",{...input(key),arm:true,schedule:{kind:"instant",at}});if(r.status!==200)throw new Error("delivery fixture creation failed");return r.data;};
        const due=async(more:object={},persona="owner")=>(await http("POST","/api/v1/task_due",{session:"delivery-fixture",...more},persona)).data;
        const countAttempts=(s:any)=>s.occurrences.reduce((n:number,o:any)=>n+o.attempts.reduce((n:number,a:any)=>n+(a.count??1),0)+(o.compacted_attempts??0),0);
        const counts=(s:any)=>({ack:s.occurrences.filter((o:any)=>o.acknowledgement).length,resolution:s.occurrences.filter((o:any)=>o.resolution).length});
        const contact=()=>http("GET","/api/v1/health",undefined,"legacy",{"x-bastra-task-authorization":`Bearer ${owner.token}`});
        if(c.id==="relay-overflow-disabled-purged") {
          for(let i=0;i<5;i++)await make(`overflow-${i}`,t0+1000);
          await delay(5500);setClock(t0+1000);await stop(daemon!);await start();await wait(s=>s.occurrences.length===5);
          const originalIds=snapshot().occurrences.map((o:any)=>o.id).sort();
          const overflow=await due({max_bytes:256});const normal=await due({max_bytes:16384});
          const states=[snapshot()];
          await stop(daemon!);env.BASTRA_PENDING_RELAY="0";await start();const disabled=await due({max_bytes:16384});states.push(snapshot());
          const purge=child("relay-purge","cli.js",["drafts","purge"]);let output="";purge.stdout.on("data",d=>output+=d);const [exit]=await once(purge,"exit");if(exit!==0)throw new Error("isolated relay purge command failed");evidence.push({relay_purge_exit:exit,output});
          const purged=await due({max_bytes:16384});states.push(snapshot());
          values={due_retained_all_subruns:overflow.overflow===5&&overflow.cards.length===0&&[normal,disabled,purged].every(r=>r.pending===5&&r.cards.length===3)&&states.every(s=>s.occurrences.length===5&&s.tasks.every((t:any)=>t.state==="due")),fabricated_acknowledgements:states.reduce((n,s)=>n+counts(s).ack,0),stable_retry_ids_all_subruns:states.every(s=>equal(s.occurrences.map((o:any)=>o.id).sort(),originalIds))};
          evidence.push({overflow,normal,disabled,purged,states});
        } else {
          const after=c.id==="seven-day-evaluation"?7*86400000:1000;
          const task=await make(c.id,t0+after);await delay(5500);
          const before=snapshot();if(before.occurrences.length)throw new Error("future delivery task fired early");
          const offline=c.id!=="active-session-deadline"&&c.id!=="multi-client-occurrence";
          if(offline)await stop(daemon!);setClock(t0+after);if(offline)await start();
          await http("GET",`/api/v1/tasks/${task.id}`);await wait(s=>s.occurrences.length===1);
          if(c.id==="active-session-deadline") {
            // Ordinary successful contact, empty vault, no recall/reconcile/task_due call.
            const response=await contact();const s=await wait(s=>countAttempts(s)===1);
            values={logical_firings:s.occurrences.length,delivery_attempts:countAttempts(s),acknowledgement_receipts:counts(s).ack};
            evidence.push({passive_attachment_received:response.data.proactive_due?.cards?.length===1,empty_vault:true});
            if(response.data.proactive_due?.cards?.length!==1)values.delivery_attempts=0;
          } else if(c.id==="multi-client-occurrence") {
            const second=await auth.mintTaskCredential(authPath,{actor_id:"second-client",domains:["personal"],role:"owner"});tokens.second=second.token;
            const replies=await Promise.all([due({},"owner"),due({},"second")]);const retry=await due();const s=snapshot();
            values={logical_firings:s.occurrences.length,stable_retry_ids:[...replies,retry].every(r=>r.cards.length===1&&r.cards[0].occurrence_id===s.occurrences[0].id),duplicate_resolutions:counts(s).resolution};
          } else if(c.id==="acknowledged-unfinished") {
            const shown=await due();const current=(await http("GET",`/api/v1/tasks/${task.id}`)).data;
            const ack=await op("acknowledge",current,{occurrence_id:shown.cards[0].occurrence_id});if(ack.status!==200)throw new Error("fixture acknowledge failed");
            await stop(daemon!);await start();const shownAck=await due({include_acknowledged:true});const s=snapshot();
            values={acknowledgement_receipts:counts(s).ack,remains_open:s.tasks[0].state==="due"&&shownAck.cards.length===1&&shownAck.cards[0].acknowledged===true,resolution_receipts:counts(s).resolution};
          } else {
            const shown=await due();const s=snapshot();
            values=c.id==="seven-day-evaluation"?{durable_before_fire:before.tasks.length===1&&before.tasks[0].armed,logical_firings:s.occurrences.length,gate_claimed_passed:false}:{logical_firings:s.occurrences.length,due_retained:s.tasks[0].state==="due"&&shown.cards.length===1,background_claimed:shown.coverage!=="next-contact-only"};
            evidence.push({pre_fire_snapshot:before,shown,synthetic_clock_is_not_seven_day_window:true});
          }
        }
      } else if(c.id === "p3-source-key-tuple-boundary") {
        const sources=[{id:"collision:a",kind:"event",producer_actor:"fixture-owner",owner_domains:["personal"],sensitivity:"private",max_age_ms:100000,enabled:true},{id:"collision",kind:"event",producer_actor:"other-owner",owner_domains:["other"],sensitivity:"private",max_age_ms:100000,enabled:true}];
        for(const [i,source] of sources.entries()) {const r=await http("POST","/api/v1/tasks/sources",source,i===0?"owner":"other");if(r.status!==200)throw new Error("valid tuple source registration failed");}
        const results: Array<{status:number;data:any}>=[];
        for(const [i,source] of sources.entries()) results.push(await http("POST","/api/v1/tasks/events",{source_id:source.id,source_revision:0,dedup_key:i===0?"b":"a:b",value:"same-invented-value",state_updated_at:Date.now()},i===0?"owner":"other"));
        const snapshot=JSON.parse(readFileSync(taskPath,"utf8"));const eventB=snapshot.events.find((e:any)=>e.id===results[1].data.event_id);
        values={accepted_submissions:results.filter(r=>r.status===200).length,journal_events:snapshot.events.length,distinct_event_ids:new Set(results.map(r=>r.data.event_id)).size,source_actor_bindings_exact:sources.every(s=>snapshot.events.some((e:any)=>e.source_id===s.id&&e.actor===s.producer_actor&&equal(e.owner_domains,s.owner_domains))),foreign_domain_receipt_reused:Boolean(eventB&&eventB.source_id!==sources[1].id)};
        evidence.push({registered_sources:sources,submission_results:results,journal:snapshot.events});
      } else if (c.id === "p3-automatic-evaluation") {
        const t0=Date.parse("2026-10-24T12:00:00Z");
        const setClock=(at:number)=>{writeFileSync(clockPath,String(at));evidence.push({frozen_clock:at});};
        const count=(id:string)=>JSON.parse(readFileSync(taskPath,"utf8")).occurrences.filter((o:any)=>o.task_id===id).length;
        const wait=async(id:string,budget:number)=>{const end=Date.now()+budget;while(count(id)===0&&Date.now()<end){if(daemon!.exitCode!==null)throw new Error("daemon died in automatic evaluation");await delay(100);}return count(id);};
        const make=async(key:string,at:number)=>{const r=await http("POST","/api/v1/tasks",{...input(key),arm:true,schedule:{kind:"instant",at}});if(r.status!==200)throw new Error("automatic task creation failed");return r.data;};
        setClock(t0);const startup=await make("automatic-start",t0+1000);await delay(5500);if(count(startup.id)!==0)throw new Error("future startup task fired early");await stop(daemon!);setClock(t0+1000);
        // No HTTP health probe or MCP contact at restart: only launch the real daemon and inspect private durable state.
        daemon=child(`daemon-${processes.length}`,"index.js");daemon.stdout.resume();
        const startCount=await wait(startup.id,5000);console.log(JSON.stringify({case_id:c.id,repetition,phase:"startup",logical_firings:startCount,expected:1}));
        const contact=await make("automatic-contact",t0+2000);await delay(5500);if(count(contact.id)!==0)throw new Error("future contact task fired early");setClock(t0+2000);
        await http("GET",`/api/v1/tasks/${contact.id}`);const contactCount=await wait(contact.id,5000);
        console.log(JSON.stringify({case_id:c.id,repetition,phase:"next-contact",logical_firings:contactCount,expected:1}));
        const polling=await make("automatic-poll",t0+3000);await delay(5500);if(count(polling.id)!==0)throw new Error("future poll task fired early");setClock(t0+3000);
        const pollCount=await wait(polling.id,65000);
        console.log(JSON.stringify({case_id:c.id,repetition,phase:"poll",logical_firings:pollCount,expected:1}));
        values={startup_logical_firings:startCount,contact_logical_firings:contactCount,poll_logical_firings:pollCount,manual_reconcile_calls:evidence.filter(e=>e.path?.includes("reconcile")).length};
      } else if(c.id === "p3-returning-source-transitions") {
        const repo=join(root,"fixture-repository");mkdirSync(repo,{mode:0o700});const artifact=join(root,"source.txt");writeFileSync(artifact,"A",{mode:0o600});
        const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8",env:{...env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"}}).trim();
        git("init","-b","fixture");
        const commitFixture=(name:string)=>git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","--allow-empty","-m",name);
        commitFixture("A");const a=git("rev-parse","HEAD");commitFixture("B");const b=git("rev-parse","HEAD");git("update-ref","refs/heads/observed",a);
        const common={producer_actor:"task-source-reader",owner_domains:["personal"],sensitivity:"private",max_age_ms:100000,enabled:true};
        for(const source of [{...common,id:"file-watch",kind:"file",root,path:"source.txt"},{...common,id:"git-watch",kind:"git",root:repo,ref:"refs/heads/observed"}]){
          const r=await http("POST","/api/v1/tasks/sources",source);if(r.status!==200)throw new Error("returning source registration failed");
        }
        await stop(daemon!);let quiet=true;
        const ctx={path:taskPath,authPath,now:()=>Number(readFileSync(clockPath,"utf8"))};
        for(const [i,value] of ["A","B","A","B"].entries()){
          writeFileSync(clockPath,String(Date.parse("2026-10-24T12:00:00Z")+i*1000));writeFileSync(artifact,value);git("update-ref","refs/heads/observed",value==="A"?a:b);
          await sourceApi!.observeTaskSources(ctx);const first=JSON.parse(readFileSync(taskPath,"utf8"));
          await sourceApi!.observeTaskSources(ctx);const second=JSON.parse(readFileSync(taskPath,"utf8"));quiet&&=first.events.length===second.events.length;
          evidence.push({transition:i+1,file_value:value,git_ref:value==="A"?a:b,first_snapshot:first,unchanged_snapshot:second});
        }
        const events=JSON.parse(readFileSync(taskPath,"utf8")).events;
        values={file_events:events.filter((e:any)=>e.source_id==="file-watch").length,git_events:events.filter((e:any)=>e.source_id==="git-watch").length,unchanged_polls_quiet:quiet,distinct_event_ids:new Set(events.map((e:any)=>e.id)).size};
      } else if (c.id === "p2-auth-boundaries") {
        const t = await create();
        const checks = await Promise.all([
          http("GET", "/api/v1/tasks", undefined, "absent"), http("GET", "/api/v1/tasks", undefined, "legacy"),
          http("POST", "/api/v1/task_review", { id:t.id,expected_revision:t.expected_revision }, "agent"),
          http("POST", "/api/v1/tasks", { ...input("forged"), arm:true }, "agent"),
          http("POST", "/api/v1/tasks", { ...input("spoof"), source:"user",approved:true,actor:"fixture-owner" }, "agent"),
          http("POST", "/api/v1/tasks", { ...input("cross-domain"), owner_domains:["other"] }, "agent"),
        ]);
        const hidden = await http("GET", `/api/v1/tasks/${t.id}`, undefined, "other");
        const list = await http("GET", "/api/v1/tasks", undefined, "other");
        const origin = await http("GET", "/api/v1/tasks", undefined, "owner", { Origin:"https://foreign.invalid" });
        const rotated = await auth.mintTaskCredential(authPath,{actor_id:"fixture-agent",domains:["personal"],role:"agent"},agent.credential_id);
        const old = await http("GET", "/api/v1/tasks", undefined, "agent"); tokens.agent=rotated.token;
        const fresh = await http("GET", "/api/v1/tasks", undefined, "agent");
        await auth.revokeTaskCredential(authPath,rotated.credential_id);
        const revoked = await http("GET", "/api/v1/tasks", undefined, "agent");
        values={unauthorised_successes:checks.filter(r=>r.status===200).length,cross_domain_visible:hidden.status!==404||list.data.tasks.length!==0,spoofed_authority:checks[4].status===200,revocation_immediate:old.status===401&&fresh.status===200&&revoked.status===401,foreign_origin_denied:origin.status===403};
      } else if(c.id==="p2-transport-parity") {
        const t = await create("fixture","agent");
        const tool = await http("POST","/api/v1/task_create",input(),"agent");
        const viaMcp = await mcpCall("task_create",input()); const viaCli = await cli("create",input());
        const readMcp = await mcpCall("task_get",{id:t.id}); const readCli=await cli("get",{id:t.id});
        const lists=[(await http("GET","/api/v1/tasks",undefined,"agent")).data,await mcpCall("task_list",{}),await cli("list",{})];
        const denied={id:t.id,expected_revision:t.expected_revision};
        const a=await http("POST","/api/v1/task_review",denied,"agent"),b=await mcpCall("task_review",denied),d=await cli("review",denied);
        values={same_task_all_transports:[tool.data,viaMcp,viaCli,readMcp,readCli].every(v=>equal(v,t))&&lists.every(v=>equal(v.tasks,[t])),stored_tasks:JSON.parse(readFileSync(taskPath,"utf8")).tasks.length,agent_proposal_armed:t.armed,denial_codes_match:a.status===403&&a.data.code===b.code&&b.code===d.code};
      } else if(c.id==="p2-owner-lifecycle") {
        let t=await create(); const reviewed=await op("review",t); t=reviewed.data;
        const armed=t.armed===true&&t.action_level==="notify";
        const denied=await Promise.all(["acknowledge","resolve","rearm"].map(name=>op(name,t,{},"agent")));
        const missing=await op("acknowledge",t,{occurrence_id:"nonexistent"});
        const now=Date.now(); t=(await op("snooze",t,{until:now+3600000},"agent")).data;
        const deadline=t.agent_snooze_deadline;
        const bound=await op("snooze",t,{until:deadline+1},"agent");
        const repeated=await op("snooze",t,{until:now+7200000},"agent"); t=repeated.data;
        const gen=t.generation; const until=t.snoozed_until;
        const cosmetic=await http("PATCH",`/api/v1/tasks/${t.id}`,{expected_revision:t.expected_revision,patch:{goal:"Cosmetic fixture change"}}); t=cosmetic.data;
        const cosmeticOk=!t.armed&&t.generation===gen&&t.snoozed_until===until;
        const trigger=await http("PATCH",`/api/v1/tasks/${t.id}`,{expected_revision:t.expected_revision,patch:{schedule:{kind:"instant",at:now+9000000}}}); t=trigger.data;
        const editOk=cosmeticOk&&!t.armed&&t.state==="pending"&&t.generation===gen+1&&t.snoozed_until===undefined;
        t=(await op("resolve",t)).data; const terminal=await op("review",t); const oldGen=t.generation;
        t=(await op("rearm",t)).data;
        const rearmOk=t.state==="pending"&&!t.armed&&t.generation===oldGen+1;
        t=(await op("cancel",t)).data; const cancelReview=await op("review",t);
        values={owner_notify_armed:armed,agent_ack_resolve_rearm_denied:denied.every(r=>r.status===403),missing_occurrence_ack_denied:missing.status===404,snooze_fixed_ceiling:bound.status===400&&repeated.status===200&&repeated.data.agent_snooze_deadline===deadline,edits_disarm:editOk,terminal_not_resurrected:terminal.status===409&&cancelReview.status===409,rearm_unarmed_new_generation:rearmOk};
      } else if(c.id==="p2-durable-restart") {
        let t=await create(); t=(await op("review",t)).data;
        const before=JSON.parse(readFileSync(taskPath,"utf8")); await stop(daemon!); await start();
        const r=await http("GET",`/api/v1/tasks/${t.id}`),m=await mcpCall("task_get",{id:t.id}),cl=await cli("get",{id:t.id});
        const after=JSON.parse(readFileSync(taskPath,"utf8"));
        values={task_equal_after_restart:[r.data,m,cl].every(v=>equal(v,t)),history_retained:equal(before.tasks[0].history,after.tasks[0].history),private_modes:[taskPath,`${taskPath}.backup`,authPath].every(p=>(statSync(p).mode&0o777)===0o600),fabricated_occurrences:after.occurrences.length};
      } else if(c.id==="p2-concurrency-cas") {
        const t=await create(); const original=JSON.parse(readFileSync(taskPath,"utf8")).tasks[0].history;
        const raced=await Promise.all(["a","b"].map(goal=>http("PATCH",`/api/v1/tasks/${t.id}`,{expected_revision:t.expected_revision,patch:{goal}})));
        const duplicates=await Promise.all([1,2,3,4].map(()=>http("POST","/api/v1/tasks",input("concurrent"))));
        const drift=await http("POST","/api/v1/tasks",{...input("concurrent"),goal:"Changed payload"});
        const after=JSON.parse(readFileSync(taskPath,"utf8")).tasks.find((x:any)=>x.id===t.id);
        values={cas_winners:raced.filter(r=>r.status===200).length,cas_conflicts:raced.filter(r=>r.status===409).length,idempotent_ids:duplicates.every(r=>r.status===200)?new Set(duplicates.map(r=>r.data.id)).size:-1,idempotency_drift_denied:drift.status===409,history_append_only:equal(original,after.history.slice(0,original.length))&&after.history.length===original.length+1};
      } else if(c.id==="dst-recurrence-rollback") {
        const setClock = (iso: string | number) => { const at=typeof iso==="number"?iso:Date.parse(iso);writeFileSync(clockPath,String(at));evidence.push({frozen_clock:at}); };
        const reconcile = async () => { const r=await http("POST","/api/v1/tasks/reconcile",{});if(r.status!==200)throw new Error("reconcile fixture failed"); };
        const snapshot = () => JSON.parse(readFileSync(taskPath,"utf8"));
        const cal = (local_time:string) => ({kind:"calendar",local_time,timezone:"Europe/Madrid",gap:"reject",overlap:"earlier",at:0,offset_minutes:0});
        const gap=await http("POST","/api/v1/tasks",{...input("gap"),arm:true,schedule:cal("2026-03-29T02:30:00")});
        const overlap=await http("POST","/api/v1/tasks",{...input("overlap"),arm:true,schedule:cal("2026-10-25T02:30:00"),recurrence:{kind:"calendar",interval:1,count:2,catch_up:"latest"}});
        if(overlap.status!==200)throw new Error("overlap creation failed");
        setClock("2026-10-25T00:29:59Z");await reconcile();const before=snapshot().occurrences.length;
        setClock("2026-10-25T00:30:00Z");await reconcile();const first=snapshot();
        setClock("2026-10-25T01:30:00Z");await reconcile();const second=snapshot();
        await stop(daemon!);await start();await reconcile();const restarted=snapshot();
        setClock("2026-10-24T12:00:00Z");await reconcile();const rolled=snapshot();
        setClock("2026-10-26T01:30:00Z");await reconcile();const calendarDone=snapshot();
        const at=Date.parse("2026-11-01T00:00:00Z");setClock(at-1000);
        const recurrence=await http("POST","/api/v1/tasks",{...input("elapsed"),arm:true,schedule:{kind:"duration",reference_at:at-1000,duration_ms:1000,at},recurrence:{kind:"elapsed",interval:1000,count:5,catch_up:"latest"}});
        setClock(at+2500);await reconcile();const catchup=snapshot();
        setClock(at+10000);await reconcile();await reconcile();const done=snapshot();
        const calTask=first.tasks.find((t:any)=>t.id===overlap.data.id);
        const caught=catchup.occurrences.filter((o:any)=>o.task_id===recurrence.data.id);
        const finalElapsed=done.occurrences.filter((o:any)=>o.task_id===recurrence.data.id);
        const calendarOccurrences=calendarDone.occurrences.filter((o:any)=>o.task_id===overlap.data.id);
        const correct=gap.status===400&&overlap.data.schedule.at===Date.parse("2026-10-25T00:30:00Z")&&overlap.data.schedule.offset_minutes===120&&before===0&&first.occurrences.length===1&&calTask.next_slot.at===Date.parse("2026-10-26T01:30:00Z")&&second.occurrences.length===1&&restarted.occurrences.length===1&&rolled.occurrences.length===1&&calendarOccurrences.length===2&&calendarOccurrences[1].due_at-calendarOccurrences[0].due_at===25*3600000&&recurrence.status===200&&caught.length===1&&caught[0].due_at===at+2000&&caught[0].missed_count===2&&finalElapsed.length===2&&finalElapsed[1].due_at===at+4000&&done.tasks.find((t:any)=>t.id===recurrence.data.id).next_slot===undefined;
        values={declared_policy_followed_all_subruns:correct,duplicate_occurrences:done.occurrences.length-new Set(done.occurrences.map((o:any)=>o.id)).size};
        evidence.push({gap,overlap,before,first,second,restarted,rolled,calendarDone,catchup,done});
      } else if(c.id==="p1-p2-corruption-recovery") {
        const empty=await http("GET","/api/v1/tasks"); let t=await create(); t=(await op("review",t)).data;
        const saved=readFileSync(taskPath,"utf8"); const old=t.expected_revision;
        // Save an explicitly supported v1 round-trip as the recoverable snapshot, then corrupt only while stopped.
        t=(await op("snooze",t,{until:Date.now()+60000})).data;
        await stop(daemon!); writeFileSync(taskPath,'{"schema_version":1,',{mode:0o600}); await start();
        const corrupt=await http("GET","/api/v1/tasks"); await stop(daemon!); const corruptBytes=readFileSync(taskPath,"utf8");
        const future=JSON.stringify({...JSON.parse(saved),schema_version:999});writeFileSync(taskPath,future); await start();
        const unsupported=await http("GET","/api/v1/tasks"); await stop(daemon!); const preserved=readFileSync(taskPath,"utf8")===future;
        const recovered=await storeApi.recoverTaskStore(taskPath,"fixture-owner");
        const originals=recovered.quarantine&&readFileSync(recovered.quarantine,"utf8")===future;
        await start(); const get=await http("GET",`/api/v1/tasks/${t.id}`);
        const stale=await http("POST","/api/v1/task_review",{id:t.id,expected_revision:old});
        values={first_run_empty:empty.status===200&&empty.data.tasks.length===0,corruption_503:corrupt.status===503&&corrupt.data.code==="corrupt",future_version_503:unsupported.status===503&&unsupported.data.code==="unsupported_version",original_bytes_preserved:corruptBytes==='{"schema_version":1,'&&preserved&&Boolean(originals),recovery_disarmed:get.status===200&&get.data.armed===false,old_revision_denied:stale.status===409,private_modes:[taskPath,authPath,recovered.quarantine].every(p=>(statSync(p).mode&0o777)===0o600)};
        evidence.push({published_storage_primitive:"recoverTaskStore",recovery:recovered,quarantine_sha256:createHash("sha256").update(readFileSync(recovered.quarantine)).digest("hex")});
      } else throw new Error("unsupported published-stage fixture");
      evidence.push({ task_snapshot: existsSync(taskPath)?JSON.parse(readFileSync(taskPath,"utf8")):null });
      return { case_id:c.id,repetition,values,evidence };
    } catch(error) {
      writeFileSync(join(root,"incomplete-evidence.json"),JSON.stringify({case_id:c.id,repetition,error:String(error),values,evidence},null,2),{mode:0o600});
      throw error;
    } finally {
      for(const p of processes.reverse()) await stop(p);
      writeFileSync(join(root,"process-logs.json"),JSON.stringify(logs,null,2),{mode:0o600});
      evidence.push({ process_logs:logs, all_children_stopped:processes.every(p=>p.exitCode!==null||p.signalCode!==null), blocked_network:existsSync(join(root,"blocked-network.jsonl"))?readFileSync(join(root,"blocked-network.jsonl"),"utf8"):"" });
    }
  }
};
export default driver;
