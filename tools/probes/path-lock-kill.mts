/** #1207 crash-recovery measurement (POSIX, 200 SIGKILL rounds).
 * Run from repo root:
 * node --import tsx --import ./scripts/test-env.mjs tools/probes/path-lock-kill.mts
 * Empty guards are aged via utimes after the kill; no 4-second sleeps.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withPathLock, pathLockFilePath } from "../../packages/daemon/src/path-lock.js";
const dir = await mkdtemp(join(tmpdir(), 'bastra-kill-'));
const worker = join(dir, 'worker.mts');
await writeFile(worker, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [state, phase] = process.argv.slice(2);
let markerFd;
const open = fs.openSync, write = fs.writeFileSync;
function stop() { process.send('guard'); while(true) {} }
fs.openSync = (...args) => { const fd = open(...args); if(args[0] === state+'.lock.mutation') { markerFd=fd; if(phase==='empty') stop(); } return fd; };
fs.writeFileSync = (...args) => { const result=write(...args); if(args[0] === markerFd) stop(); return result; };
syncBuiltinESMExports();
const { withPathLock } = await import(${JSON.stringify(new URL("../../packages/daemon/src/path-lock.ts", import.meta.url).href)});
await withPathLock(state, async()=>{}, {crossProcess:true,requireLock:true});
`);
let full=0, empty=0, max=0;
try {
 for(let i=0;i<200;i++) {
  const state=join(dir, 'state.json');
  const child=spawn(process.execPath,['--import','tsx',worker,state,i%2?'full':'empty'],{stdio:['ignore','ignore','pipe','ipc']});
  let err=''; child.stderr.on('data', c=>err+=c);
  const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
  await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error(err)))});
  child.kill('SIGKILL'); await exited;
  const guard=pathLockFilePath(state)+'.mutation';
  const body=await readFile(guard,'utf8');
  if(body) full++; else { empty++; const old=new Date(Date.now()-4500); await utimes(guard,old,old); }
  const start=performance.now();
  await withPathLock(state,async()=>{await writeFile(state,String(i))},{crossProcess:true,requireLock:true});
  max=Math.max(max,performance.now()-start);
  if(await readFile(state,'utf8')!==String(i)) throw new Error('lost write');
 }
 const leftovers=(await readdir(dir)).filter(x=>x!== 'worker.mts' && x!== 'state.json');
 if(leftovers.length) throw new Error('leftovers '+leftovers);
 console.log(JSON.stringify({rounds:200,full,empty,emptyAgeAdvancedMs:4500,maxFollowupMs:max,failed:0,leftovers:0}));
} finally {await rm(dir,{recursive:true,force:true});}
