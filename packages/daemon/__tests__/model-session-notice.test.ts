import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, chmod, readFile, writeFile, unlink, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendModelSessionNotice, modelSessionHintPath } from "../src/model-session-notice.js";
import { pendingModelNotice, type ModelOffer } from "../src/model-recommendation.js";
import { maybeEmitModelHint } from "../src/cli/update-hint.js";
import { runSessionLane } from "../src/session-lane.js";
import { withPathLock } from "../src/path-lock.js";

const offer: ModelOffer = { id: "independent-day-rec", model: "new:4b", sizeGB: 3, improves: "Invented improvement", current: "old:4b", envOverride: null };
const day = Date.parse("2026-10-10T23:59:59Z");
const notice = async () => offer;
async function fixture(work: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-model-session-day-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const keys = ["BASTRA_UPDATE_CHECK", "BASTRA_EXPAND_MODEL", "BASTRA_RERANK_MODEL", "BASTRA_EMBEDDING_PROVIDER"];
  const saved = keys.map(k => [k, process.env[k]] as const);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  for (const key of keys) delete process.env[key];
  try { await work(dir); }
  finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    for (const [key,value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true });
  }
}
const context = (out: string) => String(JSON.parse(out).hookSpecificOutput?.additionalContext ?? "");

async function sessions(work: (start: (client: "codex" | "claude-code") => Promise<string>) => Promise<void>) {
  const bodies: Record<string, unknown> = {
    "/health": { ok: true },
    "/hook/session-context": { budget: {}, aborted: [], data: { recalls: [], floors: [], conventions: [], care: { open: 0, queued: 0 }, imports: { open: 0, queued: 0 }, onboarding: false } },
    "/hook/hinted": {},
  };
  const server = createServer((req,res) => {
    req.resume(); req.on("end", () => { const body = bodies[(req.url ?? "").split("?")[0]]; res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? {})); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let i = 0;
  try { await work(client => {
    const payload = { hook_event_name: "SessionStart", source: "startup" as const, cwd: "/tmp", session_id: `day-${i++}`, bastra_client: client };
    return runSessionLane(payload, `http://127.0.0.1:${(server.address() as {port:number}).port}`, undefined, notice);
  }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("SessionStart shares one day across sessions and Claude/Codex, and resumes on a new day", () => fixture(async () => {
  await sessions(async start => {
    assert.match(context(await start("claude-code")), /<bastra-model-recommendation>/);
    assert.doesNotMatch(context(await start("codex")), /<bastra-model-recommendation>/);
    assert.doesNotMatch(context(await start("claude-code")), /<bastra-model-recommendation>/);
    await writeFile(modelSessionHintPath(), "2000-01-01\n");
    assert.match(context(await start("codex")), /<bastra-model-recommendation>/);
    const bytes = await readFile(modelSessionHintPath(), "utf8");
    assert.ok(bytes.includes(new Date().toISOString().slice(0,10)));
  });
}));

test("parallel SessionStarts prepare only one model block", () => fixture(async () => {
  await sessions(async start => {
    const outputs = await Promise.all([start("claude-code"),start("codex"),start("codex")]);
    assert.equal(outputs.filter(out => context(out).includes("<bastra-model-recommendation>")).length, 1);
  });
}));

test("UTC midnight resets the day; a new recommendation ID alone does not, just like the CLI", () => fixture(async dir => {
  const shownPath = join(dir,"days.txt");
  assert.ok((await appendModelSessionNotice("{}",notice,{shownPath,now:day})).block);
  assert.equal((await appendModelSessionNotice("{}",async()=>({...offer,id:"changed-rec"}),{shownPath,now:day})).block, "");
  assert.ok((await appendModelSessionNotice("{}",notice,{shownPath,now:day+1000})).block);
  assert.deepEqual((await readFile(shownPath,"utf8")).trim().split("\n"),["2026-10-10","2026-10-11"]);
}));

test("a foreign busy lease skips immediately, silently and without spending the day", t => fixture(async dir => {
  const shownPath = join(dir,"days.txt"),lock=shownPath+".lock";
  await writeFile(lock,"invented foreign lease");
  let err="",calls=0; t.mock.method(process.stderr,"write",(text:unknown)=>{err+=String(text);return true;});
  const started=performance.now();
  assert.deepEqual(await appendModelSessionNotice("{}",async()=>{calls++;return offer;},{shownPath,now:day}),{stdout:"{}",block:""});
  assert.ok(performance.now()-started<100,"never wait for the five-second lease");
  assert.equal(err,""); assert.equal(calls,0); await assert.rejects(stat(shownPath),{code:"ENOENT"});
  assert.equal(await readFile(lock,"utf8"),"invented foreign lease");
  await unlink(lock);
  assert.ok((await appendModelSessionNotice("{}",notice,{shownPath,now:day})).block);
}));

test("a busy local chain is not queued and produces no late claim", () => fixture(async dir => {
  const shownPath=join(dir,"days.txt"); let release!:()=>void,entered!:()=>void;
  const enteredPromise=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const writer=withPathLock(shownPath,async()=>{entered();await held;});await enteredPromise;
  try { assert.equal((await appendModelSessionNotice("{}",notice,{shownPath,now:day})).block,""); }
  finally { release();await writer; }
  await assert.rejects(stat(shownPath),{code:"ENOENT"});
  assert.ok((await appendModelSessionNotice("{}",notice,{shownPath,now:day})).block);
}));

test("only an inserted, well-formed block creates a marker; existing context is retained", () => fixture(async dir => {
  const shownPath=join(dir,"days.txt");
  for(const out of ["{broken","[]",'{"hookSpecificOutput":{"additionalContext":123}}','{"hookSpecificOutput":{"hookEventName":"Stop"}}'])assert.equal((await appendModelSessionNotice(out,notice,{shownPath,now:day})).block,"");
  assert.equal((await appendModelSessionNotice("{}",async()=>null,{shownPath,now:day})).block,"");
  assert.equal((await appendModelSessionNotice("{}",async()=>({...offer,id:"bad id"}),{shownPath,now:day})).block,"");
  await assert.rejects(stat(shownPath),{code:"ENOENT"});
  const original=JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"invented prior context"},foreign:"keep"});
  const next=await appendModelSessionNotice(original,notice,{shownPath,now:day});
  assert.ok(context(next.stdout).startsWith("invented prior context\n<bastra-model-recommendation>"));assert.equal(JSON.parse(next.stdout).foreign,"keep");
}));

test("an inaccessible marker omits the block and preserves the directory", t => fixture(async dir => {
  const shownPath=join(dir,"directory");await mkdir(shownPath);let err="";t.mock.method(process.stderr,"write",(text:unknown)=>{err+=String(text);return true;});
  assert.deepEqual(await appendModelSessionNotice("{}",notice,{shownPath,now:day}),{stdout:"{}",block:""});assert.equal(err,"");assert.ok((await stat(shownPath)).isDirectory());
}));

test("an unwritable existing marker leaves the response and prior days unchanged", {skip: process.platform === "win32" || process.getuid?.() === 0}, t => fixture(async dir => {
  const shownPath=join(dir,"days.txt");await writeFile(shownPath,"2000-01-01\n");await chmod(shownPath,0o400);let err="";t.mock.method(process.stderr,"write",(text:unknown)=>{err+=String(text);return true;});
  try { assert.deepEqual(await appendModelSessionNotice("{}",notice,{shownPath,now:day}),{stdout:"{}",block:""});assert.equal(await readFile(shownPath,"utf8"),"2000-01-01\n");assert.equal(err,""); }
  finally { await chmod(shownPath,0o600); }
}));

test("recommended models and tag variants never create a day marker", () => fixture(async dir => {
  const settingsPath=join(dir,"settings.json"),shownPath=join(dir,"days.txt");
  const recommendation={id:offer.id,models:{baseline:{model:offer.model,sizeGB:offer.sizeGB,improves:offer.improves}}};
  for(const model of ["new:4b","NEW:4B","new:4b-it-q4"]){
    await writeFile(settingsPath,JSON.stringify({generation:{model}}));
    assert.equal((await appendModelSessionNotice("{}",()=>pendingModelNotice({recommendation,ramGB:16,settingsPath}),{shownPath})).block,"");
    await assert.rejects(stat(shownPath),{code:"ENOENT"});
  }
}));

test("CLI and agent day markers cannot suppress one another in either order", t => fixture(async dir => {
  const settingsPath=join(dir,"settings.json"),cliPath=join(dir,"cli.txt"),shownPath=join(dir,"agent.txt");await writeFile(settingsPath,JSON.stringify({generation:{model:offer.current}}));
  const recommendation={id:offer.id,models:{baseline:{model:offer.model,sizeGB:offer.sizeGB,improves:offer.improves}}};const opts={recommendation,ramGB:16,settingsPath,shownPath:cliPath};
  t.mock.method(process.stderr,"write",()=>true);
  assert.equal(await maybeEmitModelHint(opts),true);assert.ok((await appendModelSessionNotice("{}",notice,{shownPath})).block);assert.equal(await maybeEmitModelHint(opts),false);
  await unlink(cliPath);await unlink(shownPath);
  assert.ok((await appendModelSessionNotice("{}",notice,{shownPath})).block);assert.equal(await maybeEmitModelHint(opts),true);
}));
