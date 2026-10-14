import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir, hostname} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import * as mainClaims from './fixtures/commit-claim-main.js';
import {acquireCommitClaim,releaseCommitClaim} from '../src/save-commit.js';
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t:any,raw:string){const dir=await fs.mkdtemp(join(tmpdir(),'claim-1208-'));t.after(async()=>{const clean=async(p:string)=>{for(const e of await fs.readdir(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())await clean(f);else await fs.unlink(f);}await fs.rmdir(p);};await clean(dir);});const lock=join(dir,'claim');await fs.writeFile(lock,raw);const old=new Date(Date.now()-120000);await fs.utimes(lock,old,old);return{dir,lock};}

test('stale marker takeover cannot unlink another reclaimer’s fresh marker generation',{timeout:5000},async t=>{
 const raw=JSON.stringify({pid:1,host:'foreign-fixture',ts:0,token:'old'}),{dir,lock}=await fixture(t,raw),mark=`${lock}.reclaim-${createHash('sha256').update(raw).digest('hex').slice(0,16)}`;
 await fs.writeFile(mark,'');const old=new Date(Date.now()-120000);await fs.utimes(mark,old,old);
 const actors=new AsyncLocalStorage<string>(),bObserved=gate(),aRead=gate(),bDone=gate();let readsA=0;
 const readFile=fs.readFile,open=fs.open,stat=fs.stat;
 fs.stat=(async(...args:any[])=>{const result=await Reflect.apply(stat,fs,args);if(args[0]===mark){if(actors.getStore()==='B'){bObserved.resolve();await aRead.promise;}else if(actors.getStore()==='A')await bObserved.promise;}return result;}) as typeof fs.stat;
 const afterRead=async(p:any)=>{if(p===lock&&actors.getStore()==='A'&&++readsA===3){aRead.resolve();await bDone.promise;}};
 fs.readFile=(async(...args:any[])=>{const result=await Reflect.apply(readFile,fs,args);await afterRead(args[0]);return result;}) as typeof fs.readFile;
 fs.open=(async(...args:any[])=>{const h=await Reflect.apply(open,fs,args);if(args[0]===mark&&args[1]==='r'){const st=h.stat;h.stat=(async(...a:any[])=>{const result=await Reflect.apply(st,h,a);if(actors.getStore()==='B'){bObserved.resolve();await aRead.promise;}else if(actors.getStore()==='A')await bObserved.promise;return result;}) as typeof h.stat;}if(args[0]===lock&&args[1]==='r'){const read=h.readFile;h.readFile=(async(...a:any[])=>{const result=await Reflect.apply(read,h,a);await afterRead(lock);return result;}) as typeof h.readFile;}return h;}) as typeof fs.open;syncBuiltinESMExports();
 let results:PromiseSettledResult<string>[]=[];
 try{const b=actors.run('B',()=>acquireCommitClaim(lock,'fixture',lock)).finally(bDone.resolve);const a=actors.run('A',()=>acquireCommitClaim(lock,'fixture',lock));results=await Promise.allSettled([a,b]);}
 finally{fs.readFile=readFile;fs.open=open;fs.stat=stat;syncBuiltinESMExports();}
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'only one reclaimer may hold the claim');
 for(const r of results)if(r.status==='fulfilled')await releaseCommitClaim(lock,r.value);assert.deepEqual(await fs.readdir(dir),[]);
 // Normal release must never traverse an externally supplied recovery symlink.
 const outside=await fs.mkdtemp(join(tmpdir(),'claim-outside-')),generation=join(outside,'0000000000000000');await fs.mkdir(generation);await fs.writeFile(join(generation,'marker'),'keep');
 await fs.symlink(outside,`${lock}.recovery`,process.platform==='win32'?'junction':'dir');
 try{const token=await acquireCommitClaim(lock,'fixture',lock);await releaseCommitClaim(lock,token);assert.equal(await fs.readFile(join(generation,'marker'),'utf8'),'keep');}
 finally{await fs.unlink(`${lock}.recovery`);await fs.unlink(join(generation,'marker')).catch(()=>{});await fs.rmdir(generation).catch(()=>{});await fs.rmdir(outside);}
});

test('an empty legacy generation cannot displace a newly published claim',{timeout:5000},async t=>{
 const {dir,lock}=await fixture(t,''),actors=new AsyncLocalStorage<string>(),bChecked=gate(),cPublished=gate(),cReturn=gate();let bReads=0;
 const readFile=fs.readFile,open=fs.open,link=fs.link;
 const beforeRead=async(p:any)=>{if(p===lock&&actors.getStore()==='B'&&++bReads===2){bChecked.resolve();await cPublished.promise;}};
 fs.readFile=(async(...args:any[])=>{await beforeRead(args[0]);return Reflect.apply(readFile,fs,args);}) as typeof fs.readFile;
 fs.open=(async(...args:any[])=>{const h=await Reflect.apply(open,fs,args);if(args[0]===lock&&args[1]==='r'){const read=h.readFile;h.readFile=(async(...a:any[])=>{await beforeRead(lock);return Reflect.apply(read,h,a);}) as typeof h.readFile;}if(args[0]===lock&&args[1]==='wx'&&actors.getStore()==='C'){const write=h.writeFile;h.writeFile=(async(...a:any[])=>{cPublished.resolve();await cReturn.promise;return Reflect.apply(write,h,a);}) as typeof h.writeFile;}return h;}) as typeof fs.open;
 fs.link=(async(...args:any[])=>{const result=await Reflect.apply(link,fs,args);if(args[1]===lock&&actors.getStore()==='C'){cPublished.resolve();await cReturn.promise;}return result;}) as typeof fs.link;syncBuiltinESMExports();
 let results:PromiseSettledResult<string>[]=[];
 try{const b=actors.run('B',()=>acquireCommitClaim(lock,'fixture',lock));await bChecked.promise;const a=await actors.run('A',()=>acquireCommitClaim(lock,'fixture',lock));await releaseCommitClaim(lock,a);const c=actors.run('C',()=>acquireCommitClaim(lock,'fixture',lock));const rb=await Promise.allSettled([b]);cReturn.resolve();results=[...rb,...await Promise.allSettled([c])];}
 finally{cReturn.resolve();fs.readFile=readFile;fs.open=open;fs.link=link;syncBuiltinESMExports();}
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'the delayed empty-generation reclaimer must lose');
 for(const r of results)if(r.status==='fulfilled')await releaseCommitClaim(lock,r.value);assert.deepEqual(await fs.readdir(dir),[]);
});

test('a one-shot ENOENT before legacy marker removal leaves no orphan', { timeout: 5000 }, async t => {
  const raw = JSON.stringify({ pid: 1, host: 'foreign-fixture', ts: 0, token: 'old' });
  const { dir, lock } = await fixture(t, raw);
  const marker = `${lock}.reclaim-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  await fs.writeFile(marker, '');
  const old = new Date(Date.now() - 120000);
  await fs.utimes(marker, old, old);
  const unlink = fs.unlink;
  let injected = false;
  fs.unlink = (async path => {
    if (path === marker && !injected) {
      injected = true;
      throw Object.assign(new Error('one-shot provider failure'), { code: 'ENOENT' });
    }
    return unlink(path);
  }) as typeof fs.unlink;
  syncBuiltinESMExports();
  try {
    await assert.rejects(acquireCommitClaim(lock, 'fixture', lock), /another save/);
    const token = await acquireCommitClaim(lock, 'fixture', lock);
    await releaseCommitClaim(lock, token);
  } finally {
    fs.unlink = unlink;
    syncBuiltinESMExports();
  }
  assert.ok(injected);
  assert.deepEqual(await fs.readdir(dir), []);
});


test('release cannot clear a different reclaimer’s fresh generation', {timeout:10000}, async t => {
  const {dir,lock}=await fixture(t,'');await fs.unlink(lock);
  const a=await acquireCommitClaim(lock,'fixture',lock);
  const actors=new AsyncLocalStorage<string>(),readyR=gate(),readyR2=gate(),resumeR=gate(),resumeR2=gate();
  const reads={R:0,R2:0};const original={unlink:fs.unlink,readFile:fs.readFile,open:fs.open};
  let r!:Promise<string>;
  const afterRead=async(p:unknown)=>{
    const actor=actors.getStore();
    if(p!==lock||(actor!=='R'&&actor!=='R2')||++reads[actor]!==3)return;
    (actor==='R'?readyR:readyR2).resolve();
    await (actor==='R'?resumeR:resumeR2).promise;
  };
  fs.readFile=(async(...args:any[])=>{const raw=await Reflect.apply(original.readFile,fs,args);await afterRead(args[0]);return raw;}) as typeof fs.readFile;
  fs.open=(async(...args:any[])=>{const h=await Reflect.apply(original.open,fs,args);if(args[0]===lock&&args[1]==='r'){const read=h.readFile;h.readFile=(async(...a:any[])=>{const raw=await Reflect.apply(read,h,a);await afterRead(lock);return raw;}) as typeof h.readFile;}return h;}) as typeof fs.open;
  fs.unlink=(async(path)=>{
    await original.unlink(path);
    if(path===lock&&actors.getStore()==='A'){
      await fs.writeFile(lock,JSON.stringify({pid:2147483647,host:hostname(),ts:Date.now(),token:'dead-C'}));
      r=actors.run('R',()=>acquireCommitClaim(lock,'fixture',lock));
      void r.catch(()=>{}).finally(readyR.resolve);
      await readyR.promise;
    }
  }) as typeof fs.unlink;syncBuiltinESMExports();
  let results:PromiseSettledResult<string>[]=[];
  try {
    await actors.run('A',()=>releaseCommitClaim(lock,a));
    const r2=actors.run('R2',()=>acquireCommitClaim(lock,'fixture',lock));
    void r2.catch(()=>{}).finally(readyR2.resolve);
    await readyR2.promise;
    resumeR.resolve();const first=await Promise.allSettled([r]);resumeR2.resolve();
    results=[...first,...await Promise.allSettled([r2])];
  } finally {
    resumeR.resolve();resumeR2.resolve();Object.assign(fs,original);syncBuiltinESMExports();
  }
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'cleanup must not give R2 a second lease for G');
  for(const r of results)if(r.status==='fulfilled')await releaseCommitClaim(lock,r.value);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('main and the new version read and exclude each other’s live regular claim', {timeout:5000}, async t => {
  const {dir,lock}=await fixture(t,'');await fs.unlink(lock);
  const fresh=await acquireCommitClaim(lock,'fixture',lock);
  assert.equal(await mainClaims.claimIsAbandoned(lock),false,'main must see the new exclusive owner');
  assert.ok((await fs.lstat(lock)).isFile());
  await assert.rejects(mainClaims.acquireCommitClaim(lock,'fixture',lock),/another save/);
  await releaseCommitClaim(lock,fresh);
  const old=await mainClaims.acquireCommitClaim(lock,'fixture',lock);
  await assert.rejects(acquireCommitClaim(lock,'fixture',lock),/another save/);
  await mainClaims.releaseCommitClaim(lock,old);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('a new reclaimer holds main’s canonical marker until publication', {timeout:5000}, async t => {
  const {dir,lock}=await fixture(t,JSON.stringify({pid:1,host:'foreign-fixture',ts:0,token:'old'}));
  const actors=new AsyncLocalStorage<string>(),ready=gate(),resume=gate();let reads=0;
  const original={readFile:fs.readFile,open:fs.open};
  const afterRead=async(p:unknown)=>{if(p===lock&&actors.getStore()==='new'&&++reads===3){ready.resolve();await resume.promise;}};
  fs.readFile=(async(...args:any[])=>{const raw=await Reflect.apply(original.readFile,fs,args);await afterRead(args[0]);return raw;}) as typeof fs.readFile;
  fs.open=(async(...args:any[])=>{const h=await Reflect.apply(original.open,fs,args);if(args[0]===lock&&args[1]==='r'){const read=h.readFile;h.readFile=(async(...a:any[])=>{const raw=await Reflect.apply(read,h,a);await afterRead(lock);return raw;}) as typeof h.readFile;}return h;}) as typeof fs.open;syncBuiltinESMExports();
  let results:PromiseSettledResult<string>[]=[];
  try {
    const modern=actors.run('new',()=>acquireCommitClaim(lock,'fixture',lock));void modern.catch(()=>{}).finally(ready.resolve);
    await ready.promise;
    const legacy=await Promise.allSettled([mainClaims.acquireCommitClaim(lock,'fixture',lock)]);
    resume.resolve();results=[...legacy,...await Promise.allSettled([modern])];
  } finally {resume.resolve();Object.assign(fs,original);syncBuiltinESMExports();}
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'main must not enter while a new reclaimer holds G');
  for(const r of results)if(r.status==='fulfilled')await releaseCommitClaim(lock,r.value);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('main can recover a crashed new claim and ignores an unpublished preparation', {timeout:10000}, async t => {
  for (const phase of ['held','before-link']) {
    const {dir,lock}=await fixture(t,'');await fs.unlink(lock);
    const child=fork(new URL('./fixtures/commit-claim-crash.ts',import.meta.url),[lock,phase],{
      execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],
    });
    t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
    const message=await Promise.race([
      once(child,'message').then(([message])=>message as {checkpoint:string}),
      once(child,'exit').then(([code])=>{throw new Error('child exited before gate: '+code);}),
    ]);
    assert.equal(message.checkpoint,phase==='held'?'held':'prepared');
    if(phase==='held')assert.equal(await mainClaims.claimIsAbandoned(lock),false);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const old=await mainClaims.acquireCommitClaim(lock,'fixture',lock);
    await mainClaims.releaseCommitClaim(lock,old);
    const modern=await acquireCommitClaim(lock,'fixture',lock);
    await releaseCommitClaim(lock,modern);
    assert.deepEqual(await fs.readdir(dir),[],'new retry retires its dead preparation; rollback stayed writable');
  }
});

test('release preserves a fresh foreign reservation and canonical marker', {timeout:5000}, async t => {
  const {dir,lock}=await fixture(t,'');await fs.unlink(lock);
  const phase=join(`${lock}.recovery`,'0000000000000000');
  const fresh=join(phase,`${Date.now()}-${process.pid}-00000000-0000-0000-0000-000000000001`);
  await fs.mkdir(fresh,{recursive:true});
  const marker=`${lock}.reclaim-0000000000000000`;
  await fs.writeFile(marker,JSON.stringify({token:'foreign',pid:process.pid,host:hostname(),ts:Date.now()}));
  const token=await acquireCommitClaim(lock,'fixture',lock);
  // A stale own pointer must not authorize deleting someone else's new token.
  const raw=JSON.parse(await fs.readFile(lock,'utf8')) as Record<string,unknown>;
  await fs.writeFile(lock,JSON.stringify({...raw,reclaimed_from:'0000000000000000'}));
  await releaseCommitClaim(lock,token);
  assert.ok((await fs.lstat(fresh)).isDirectory());
  assert.equal((JSON.parse(await fs.readFile(marker,'utf8')) as {token:string}).token,'foreign');
  await fs.unlink(marker);await fs.rmdir(fresh);await fs.rmdir(phase);await fs.rmdir(`${lock}.recovery`);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('observable legacy marker loss fails closed before claim replacement', {timeout:5000}, async t => {
  const raw=JSON.stringify({pid:1,host:'foreign-fixture',ts:0,token:'old'});
  const {lock}=await fixture(t,raw);
  const marker=`${lock}.reclaim-${createHash('sha256').update(raw).digest('hex').slice(0,16)}`;
  const readFile=fs.readFile;let injected=false;
  fs.readFile=(async (...args:any[])=>{
    if(args[0]===marker&&!injected){
      injected=true;
      // The old takeReclaimMark can perform these exact operations after a
      // cached stale stat: delete our fresh marker, publish its empty marker.
      await fs.unlink(marker);await fs.writeFile(marker,'',{flag:'wx'});
    }
    return Reflect.apply(readFile,fs,args);
  }) as typeof fs.readFile;syncBuiltinESMExports();
  try {await assert.rejects(acquireCommitClaim(lock,'fixture',lock),/another save/);}
  finally {fs.readFile=readFile;syncBuiltinESMExports();}
  assert.ok(injected);
  assert.equal(await fs.readFile(lock,'utf8'),raw);
  assert.equal(await fs.readFile(marker,'utf8'),'','foreign canonical marker is preserved');
});

test('a second takeover retires the first dead owner’s earlier canonical marker', {timeout:10000}, async t => {
  for (const rollback of [false,true]) {
  const raw=JSON.stringify({pid:1,host:'foreign-fixture',ts:0,token:'old'});
  const {dir,lock}=await fixture(t,raw);
  const child=fork(new URL('./fixtures/commit-claim-crash.ts',import.meta.url),[lock,'after-link'],{
    execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],
  });
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const message=await Promise.race([
    once(child,'message').then(([m])=>m as {checkpoint:string}),
    once(child,'exit').then(([code])=>{throw new Error('child exited before gate: '+code);}),
  ]);
  assert.equal(message.checkpoint,'published');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  if(rollback){const old=await mainClaims.acquireCommitClaim(lock,'fixture',lock);await mainClaims.releaseCommitClaim(lock,old);}
  const token=await acquireCommitClaim(lock,'fixture',lock);
  await releaseCommitClaim(lock,token);
  assert.deepEqual(await fs.readdir(dir),[],'both canonical generations and the dead preparation must be retired');
  }
});
