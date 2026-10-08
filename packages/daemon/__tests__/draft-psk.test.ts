import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTypedDrafts } from "../src/draft-capture.js";
import { listDrafts } from "../src/draft-store.js";

test("PSK is removed from persisted quote, question and situation before deriving literals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "psk-capture-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  const now = Date.now();
  const quote = "Our staging VPN requires PSK='fixture vpn' and a separate deployment configuration.";
  try {
    await captureTypedDrafts([
      { role: "assistant", content: "", commands: ["vpn PSK='fixture vpn' --host staging.example"], cwd: "/fixture/staging" },
      { role: "user", content: quote, cwd: "/fixture/staging", at: now },
      { role: "assistant", content: "", commands: ["$psk='fixture vpn'; vpn connect"] },
    ], { session_id: "psk-fixture" }, now, [{ kind: "answer", turn: 1, quote, context: "Is PSK='fixture vpn' the staging configuration?" }]);
    const rows = await listDrafts(now);
    assert.equal(rows.length, 1);
    assert.match(rows[0].quote, /\[REDACTED\]/);
    assert.match(rows[0].context!, /\[REDACTED\]/);
    assert.match(rows[0].situation.before[0], /\[REDACTED\]/);
    assert.match(rows[0].situation.after[0], /\[REDACTED\]/);
    assert.ok(!JSON.stringify(rows).includes("fixture vpn"));
    assert.ok(!(await readFile(process.env.BASTRA_DRAFTS_PATH, "utf8")).includes("fixture vpn"));
  } finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH; else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy command secrets do not survive in literal, novel or matched fields on write',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-secret-'));const previous=process.env.BASTRA_DRAFTS_PATH;process.env.BASTRA_DRAFTS_PATH=join(dir,'drafts.json');
 try{
  const {writeFile}=await import('node:fs/promises');const {captureDraft,draftFingerprint,draftId}=await import('../src/draft-store.js');const now=Date.now(),secret='fixture-low-secret',quote='Use a separate calibration database for our invented deployments.';
  await writeFile(process.env.BASTRA_DRAFTS_PATH,JSON.stringify({version:1,rows:[{id:'d-0123456789ab',fp:'a'.repeat(40),kind:'typed',quote,situation:{before:[`curl -u user:${secret} https://fixture.invalid`],after:[],reads:[],lits:[secret,'fixture.invalid']},evidence:[{session_id:'old',turn:1,ts:now}],created:now,last_touched:now,surfaced:[{session_id:'reader',ts:now-2,novel:[secret],used:{ts:now-1,tool:'Bash',exit_code:0,matched:[secret]}}],state:'open'}]}));
  const fp=draftFingerprint('Another fictional deployment requires an isolated aquarium recorder.');await captureDraft({id:draftId('new',0,fp),fp,quote:'Another fictional deployment requires an isolated aquarium recorder.',kind:'typed',situation:{before:[],after:[],reads:[],lits:[]},evidence:[{session_id:'new',turn:0,ts:now}],created:now,last_touched:now,surfaced:[],state:'open'});
  assert.ok(!(await readFile(process.env.BASTRA_DRAFTS_PATH,'utf8')).includes(secret));
 }finally{if(previous===undefined)delete process.env.BASTRA_DRAFTS_PATH;else process.env.BASTRA_DRAFTS_PATH=previous;await rm(dir,{recursive:true,force:true});}
});
