import {test} from "node:test";
import assert from "node:assert/strict";
import {claudeSessionPidFrom} from "../src/statusline-session.js";

test("fix3: process ancestry stops at the nearest host instead of borrowing a Claude grandparent",()=>{
 const resolve=(table:string)=>claudeSessionPidFrom(300,table);
 assert.equal(resolve("300 200 node\n200 100 /opt/codex\n100 1 /opt/claude"),300);
 assert.equal(resolve("300 200 node\n200 100 /opt/codex-aarch64-apple-darwin\n100 1 claude"),300);
 assert.equal(resolve("300 200 node\n200 100 /opt/claude\n100 1 codex"),200,"a Claude launched by Codex uses its own Claude host");
 assert.equal(resolve("300 200 node\n200 100 /opt/claude\n100 1 launchd"),200);
});

test("fix3: a Codex forwarder never loads or overwrites a launching Claude feed",async t=>{
 const {mkdtemp,mkdir,writeFile,readFile,rm,chmod}=await import("node:fs/promises");
 const {join}=await import("node:path");
 const {tmpdir}=await import("node:os");
 const {execFile}=await import("node:child_process");
 const {promisify}=await import("node:util");
 const {STATUSLINE_DIR,sessionFeedPath}=await import("../src/statusline-session.js");
 const {defaultStatuslineState}=await import("../src/statusline-feed.js");
 const root=await mkdtemp(join(tmpdir(),"host-feed-")),claudePid=987654321;
 t.after(()=>rm(root,{recursive:true,force:true}));
 const parentFeed=JSON.stringify({...defaultStatuslineState(),cc_session_id:"parent-claude",turn_id:9});
 await mkdir(STATUSLINE_DIR,{recursive:true});await writeFile(sessionFeedPath(claudePid),parentFeed);
 t.after(()=>rm(sessionFeedPath(claudePid),{force:true}));
 const ps=join(root,"ps");
 await writeFile(ps,`#!/bin/sh\nprintf '%s\\n' '${process.pid} 987654322 node' '987654322 ${claudePid} /opt/codex' '${claudePid} 1 claude'\n`);await chmod(ps,0o700);
 const script=`const f=await import('./packages/daemon/src/mcp-forwarder-statusline.ts');f.syncStatuslineTurn();console.log(JSON.stringify({sid:f.liveStatusline.cc_session_id}));f.flushStatusline();`;
 const result=await promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:process.cwd(),env:{...process.env,PATH:root+":"+process.env.PATH}});
 assert.notEqual(JSON.parse(result.stdout).sid,"parent-claude");
 assert.equal(await readFile(sessionFeedPath(claudePid),"utf8"),parentFeed);
});
