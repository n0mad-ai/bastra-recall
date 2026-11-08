/** #1397: the first list_rules page follows the project of the session index. */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseMemory, memoryRevision, type VaultEvent} from '@bastra-recall/core';
import {beginRulebookRound} from '../src/rulebook-check.js';
import {cachedRulebookCatalog, listRulesHandler, rulebookCursor} from '../src/rulebook-catalog.js';
import {callerSessionStore} from '../src/caller-session.js';

const memory = (id:string, scope:string, body='Invented body', extra='') => {
 const raw=`---\nid: ${id}\ntitle: Invented\nsummary: Invented summary\ntype: workflow\nscope: ${scope}\nwrite_origin: user-directed\nrulebook: on-demand\napplies_when: Invented situation\n${extra}tags: [fixture]\ntopic_path: [fixture]\nrecall_when: [fixture]\n---\n${body}`;
 return {...parseMemory(raw, `/unreadable/${id}`, 0),revision:memoryRevision(raw)};
};
function fixture() {
 let all=[memory('global-rule','all-projects'),memory('project-a-rule','project-a'),memory('project-b-rule','project-b')];
 const listeners=new Set<(event:VaultEvent)=>void>();
 const vault={list:()=>all,get:(id:string)=>all.find(m=>m.fm.id===id),on:(fn:(event:VaultEvent)=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}};
 return {vault,deps:{vault} as never,update(next:typeof all){all=next;for(const fn of listeners)fn({kind:'change',memory:all[0]});}};
}
let root:string;
const oldState=process.env.BASTRA_HOOK_STATE_DIR;
before(async()=>{root=await mkdtemp(join(tmpdir(),'rulebook-list-project-'));process.env.BASTRA_HOOK_STATE_DIR=root;});
after(async()=>{if(oldState===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=oldState;await rm(root,{recursive:true,force:true});});
const ids=(page:Awaited<ReturnType<typeof listRulesHandler>>)=>page.rules.map(r=>r.id).sort();

test('the first page uses the indexed session project instead of the server project',async()=>{
 const f=fixture(),sid='first-project';
 const index=await cachedRulebookCatalog(f.vault,{project:'project-a',active:[]});
 await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},index);
 const page=await listRulesHandler(f.deps,{}, {sessionId:sid,project:'project-b'});
 assert.deepEqual(ids(page),['global-rule','project-a-rule']);
 assert.equal(page.catalog_hash,index.catalog_hash);
});

test('an explicitly global indexed project is not replaced by the server project',async()=>{
 const f=fixture(),sid='global-project';
 const index=await cachedRulebookCatalog(f.vault,{project:null,active:[]});
 await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},index);
 assert.deepEqual(ids(await listRulesHandler(f.deps,{}, {sessionId:sid,project:'project-a'})),['global-rule']);
});

test('the MCP caller session supplies the indexed project when no explicit session is passed',async()=>{
 const f=fixture(),sid='caller-project';
 await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},await cachedRulebookCatalog(f.vault,{project:'project-a',active:[]}));
 const page=await callerSessionStore.run(sid,()=>listRulesHandler(f.deps,{}, {project:'project-b'}));
 assert.deepEqual(ids(page),['global-rule','project-a-rule']);
});

test('missing indexed project metadata retains the caller-project fallback',async()=>{
 const f=fixture(),sid='legacy-project';
 await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},{entries:[],omitted:0});
 for(const sessionId of [undefined,sid])assert.deepEqual(ids(await listRulesHandler(f.deps,{}, {sessionId,project:'project-b'})),['global-rule','project-b-rule']);
});

test('a continuation cursor keeps its original project after the session index changes',async()=>{
 const f=fixture(),sid='cursor-project';
 const index=await cachedRulebookCatalog(f.vault,{project:'project-a',active:[]});
 const cursor=rulebookCursor(index,1);
 await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},await cachedRulebookCatalog(f.vault,{project:'project-b',active:[]}));
 const page=await listRulesHandler(f.deps,{cursor},{sessionId:sid,project:'project-b'});
 assert.equal(page.offset,1);assert.equal(page.restarted,undefined);assert.equal(page.catalog_hash,index.catalog_hash);
 assert.deepEqual(page.rules.map(r=>r.id),index.entries.slice(1).map(r=>r.id));
});

test('cursor restart still uses current revisions and excludes private rules in its bound project',async()=>{
 const f=fixture(),sid='cursor-current';
 const index=await cachedRulebookCatalog(f.vault,{project:'project-a',active:[]});
 await beginRulebookRound({session_id:sid,bastra_client:'claude-code'},index);
 const updated=memory('project-a-rule','project-a','Changed body');
 f.update([memory('global-rule','all-projects','Private now','sensitivity: private\n'),updated,memory('project-b-rule','project-b')]);
 const page=await listRulesHandler(f.deps,{cursor:rulebookCursor(index,1)},{sessionId:sid,project:'project-b'});
 assert.equal(page.restarted,true);assert.equal(page.offset,0);assert.notEqual(page.catalog_hash,index.catalog_hash);
 assert.deepEqual(ids(page),['project-a-rule']);assert.equal(page.rules[0].revision,updated.revision);
});
