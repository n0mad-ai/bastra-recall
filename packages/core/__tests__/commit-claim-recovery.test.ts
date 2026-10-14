import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
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
 fs.open=(async(...args:any[])=>{const h=await Reflect.apply(open,fs,args);if(args[0]===lock&&args[1]==='r'){const read=h.readFile;h.readFile=(async(...a:any[])=>{const result=await Reflect.apply(read,h,a);await afterRead(lock);return result;}) as typeof h.readFile;}return h;}) as typeof fs.open;syncBuiltinESMExports();
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
 const readFile=fs.readFile,open=fs.open,symlink=fs.symlink;
 const beforeRead=async(p:any)=>{if(p===lock&&actors.getStore()==='B'&&++bReads===2){bChecked.resolve();await cPublished.promise;}};
 fs.readFile=(async(...args:any[])=>{await beforeRead(args[0]);return Reflect.apply(readFile,fs,args);}) as typeof fs.readFile;
 fs.open=(async(...args:any[])=>{const h=await Reflect.apply(open,fs,args);if(args[0]===lock&&args[1]==='r'){const read=h.readFile;h.readFile=(async(...a:any[])=>{await beforeRead(lock);return Reflect.apply(read,h,a);}) as typeof h.readFile;}if(args[0]===lock&&args[1]==='wx'&&actors.getStore()==='C'){const write=h.writeFile;h.writeFile=(async(...a:any[])=>{cPublished.resolve();await cReturn.promise;return Reflect.apply(write,h,a);}) as typeof h.writeFile;}return h;}) as typeof fs.open;
 fs.symlink=(async(...args:any[])=>{const result=await Reflect.apply(symlink,fs,args);if(args[1]===lock&&actors.getStore()==='C'){cPublished.resolve();await cReturn.promise;}return result;}) as typeof fs.symlink;syncBuiltinESMExports();
 let results:PromiseSettledResult<string>[]=[];
 try{const b=actors.run('B',()=>acquireCommitClaim(lock,'fixture',lock));await bChecked.promise;const a=await actors.run('A',()=>acquireCommitClaim(lock,'fixture',lock));await releaseCommitClaim(lock,a);const c=actors.run('C',()=>acquireCommitClaim(lock,'fixture',lock));const rb=await Promise.allSettled([b]);cReturn.resolve();results=[...rb,...await Promise.allSettled([c])];}
 finally{cReturn.resolve();fs.readFile=readFile;fs.open=open;fs.symlink=symlink;syncBuiltinESMExports();}
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
    const token = await acquireCommitClaim(lock, 'fixture', lock);
    await releaseCommitClaim(lock, token);
  } finally {
    fs.unlink = unlink;
    syncBuiltinESMExports();
  }
  assert.ok(injected);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('expired recovery marker and interrupted reservation are retired completely', { timeout: 5000 }, async t => {
  const raw = JSON.stringify({ pid: 1, host: 'foreign-fixture', ts: 0, token: 'old' });
  const { dir, lock } = await fixture(t, raw);
  const phase = join(`${lock}.recovery`, createHash('sha256').update(raw).digest('hex').slice(0, 16));
  await fs.mkdir(phase, { recursive: true });
  const body = JSON.stringify({ token: 'interrupted', ts: Date.now() - 120000 });
  const link = 'bastra-claim-v1-' + Buffer.from(body).toString('base64url');
  await fs.symlink(link, join(phase, 'marker'), 'file');
  const reservation = join(phase, `${Date.now() - 120000}-00000000-0000-0000-0000-000000000001`);
  await fs.mkdir(reservation);
  await fs.symlink(link, join(reservation, 'candidate'), 'file');
  const token = await acquireCommitClaim(lock, 'fixture', lock);
  await assert.rejects(acquireCommitClaim(lock, 'fixture', lock), /another save/);
  await releaseCommitClaim(lock, token);
  assert.deepEqual(await fs.readdir(dir), []);
});
