/** Private, hook-owned endpoints. Transcript metadata, never prompt wording,
 * establishes activity. Unknown/newer clients block fallback to an older chat. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, realpath, readFile, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { withPathLock } from './path-lock.js';
import { codexChatRequest } from './task-chat-codex.js';

export interface ChatSession {
  sessionId: string; client: string; generation: string; registeredAt: number; expiresAt: number;
  transcriptPath: string; transcriptDev: number; transcriptIno: number; generationOffset: number; offset: number;
  socketPath?: string; socketDev?: number; socketIno?: number; token?: string;
  lastHumanAt?: number; lastUnknownAt?: number; closed?: boolean; unread?: boolean;
  receiveBlocked?: boolean; configDir?: string; cwd?: string;
  codexBridge?: boolean;
}
export interface ChatRegistryOptions { dir?: string; now?: number; activeMinutes?: number }
const MAX_READ = 2 * 1024 * 1024;
const LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 256;
const MAX_HISTORY = 4096;
const uid = () => process.getuid?.();
export function chatSessionsPath(): string {
  if (process.env.BASTRA_CHAT_SESSIONS_PATH) return process.env.BASTRA_CHAT_SESSIONS_PATH;
  if (process.env.NODE_TEST_CONTEXT) return join(tmpdir(), `bastra-test-chat-${process.pid}`);
  return join(process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(),'AppData','Local'), 'Bastra') : join(homedir(), '.bastra'), 'chat-sessions');
}
const key = (client:string,id:string) => createHash('sha256').update(JSON.stringify([client,id])).digest('hex')+'.json';
function owned(s: Stats): boolean { return uid() === undefined || s.uid === uid(); }
async function privateDir(dir:string): Promise<void> {
  const check=(value:string)=>{
    if(/^(?:\\\\|\/\/)/u.test(value)||/(?:^|[\\/])(?:CloudStorage|Google Drive|GoogleDrive[^\\/]*|Dropbox|OneDrive[^\\/]*|Mobile Documents)(?:[\\/]|$)/iu.test(value))throw new Error('chat registry must stay outside sync storage');
    const vault=process.env.BASTRA_VAULT_PATH??process.env.NEXUS_VAULT_PATH;
    if(vault&&(resolve(value)===resolve(vault)||resolve(value).startsWith(resolve(vault)+'/')))throw new Error('chat registry must stay outside the vault');
  };
  check(dir);let ancestor=resolve(dir);
  while(true)try {
    const entry=await lstat(ancestor);
    if(ancestor===resolve(dir)&&entry.isSymbolicLink())throw new Error('unsafe registry symlink');
    check(await realpath(ancestor));break;
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const parent=dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;
  }
  await mkdir(dir,{recursive:true,mode:0o700}); const s=await lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || !owned(s) || (s.mode & 0o077)!==0) throw new Error('unsafe chat registry');
}
async function readRecord(path:string): Promise<ChatSession|null> {
  try {
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const s=await handle.stat(); if(!s.isFile() || !owned(s) || (s.mode & 0o077)!==0 || s.size>16384)return null;
      const r=JSON.parse(await handle.readFile('utf8')) as ChatSession;
      if(typeof r.sessionId!=='string'||typeof r.generation!=='string'||typeof r.client!=='string'||typeof r.transcriptPath!=='string'||!Number.isFinite(r.offset)||!Number.isFinite(r.generationOffset)||!Number.isFinite(r.registeredAt)||!Number.isFinite(r.expiresAt))return null;
      return r;
    } finally {await handle.close();}
  } catch {return null;}
}
async function writeRecord(dir:string,r:ChatSession): Promise<void> {
  const dest=join(dir,key(r.client,r.sessionId)); const temp=dest+'.'+randomUUID()+'.tmp';
  const h=await open(temp,'wx',0o600); try {await h.writeFile(JSON.stringify(r)); await h.sync();} finally {await h.close();}
  await rename(temp,dest);
}
async function safeFile(path:string,kind:'file'|'socket') {
  if(!isAbsolute(path))throw new Error('relative endpoint');
  const s=await lstat(path);
  if(s.isSymbolicLink() || !owned(s) || (kind==='file'?!s.isFile():!s.isSocket()))throw new Error('unsafe endpoint');
  // Resolve platform aliases (/var, /tmp) once; retain the actual leaf identity.
  const canonical=join(await realpath(dirname(path)),path.slice(path.lastIndexOf('/')+1));
  const parent=await lstat(dirname(canonical));
  if(kind==='socket' && (!owned(parent) || (parent.mode & 0o022)!==0))throw new Error('unsafe inbox directory');
  return {path:canonical,stat:s};
}

/** Called only by our command hook. SessionStart always rotates the generation;
 * a fork starts at EOF, never inherits the source session's human activity. */
export async function registerChatHook(payload:unknown, env:NodeJS.ProcessEnv=process.env, opts:ChatRegistryOptions={}): Promise<void> {
  if(!payload || typeof payload!=='object')return;
  const p=payload as Record<string,unknown>;
  if(p.agent_id || typeof p.session_id!=='string' || !p.session_id || p.session_id.length>256)return;
  const marker=p.bastra_client??env.BASTRA_HOOK_CLIENT;
  const client=typeof marker==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(marker)?marker:null;
  if(!client)return;
  if(p.hook_event_name!=='SessionStart'&&p.hook_event_name!=='SessionEnd'&&!(p.hook_event_name==='UserPromptSubmit'&&client!=='claude-code'))return;
  const dir=opts.dir??chatSessionsPath();const now=opts.now??Date.now();await privateDir(dir);
  const path=join(dir,key(client,p.session_id));
  await withPathLock(path,async()=>{
    const old=await readRecord(path);
    // The bridge owns its generation and provenance journal. Ordinary hooks
    // cannot replace it with rollout metadata or count inbound task messages.
    if(client==='codex' && old?.codexBridge && !old.closed && old.token && env.BASTRA_CODEX_CHAT_TOKEN===old.token)return;
    if(p.hook_event_name==='UserPromptSubmit' && client!=='claude-code') {
      // This hook does not establish human provenance. Nevertheless an input
      // in an unsupported host must block fallback, even without SessionStart.
      const barrier:ChatSession=old??{sessionId:p.session_id as string,client,generation:randomUUID(),registeredAt:now,expiresAt:now+LEASE_MS,
        transcriptPath:'',transcriptDev:-1,transcriptIno:-1,generationOffset:0,offset:0,closed:true};
      barrier.lastUnknownAt=now;await writeRecord(dir,barrier);return;
    }
    if(p.hook_event_name==='SessionEnd') {
      if(old?.token && env.CLAUDE_CODE_MESSAGING_TOKEN!==old.token)return;
      if(old) {old.closed=true; await writeRecord(dir,old);} return;
    }
    if(p.hook_event_name!=='SessionStart' || typeof p.transcript_path!=='string')return;
    let file:Awaited<ReturnType<typeof safeFile>>;
    try {file=await safeFile(p.transcript_path,'file');}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT' || !isAbsolute(p.transcript_path))return;
      file={path:resolve(p.transcript_path),stat:{dev:-1,ino:-1,size:0} as Stats};
    }
    const r:ChatSession={sessionId:p.session_id as string,client,generation:randomUUID(),registeredAt:now,expiresAt:now+LEASE_MS,
      transcriptPath:file.path,transcriptDev:file.stat.dev,transcriptIno:file.stat.ino,generationOffset:file.stat.size,offset:file.stat.size};
    if(old?.lastUnknownAt!==undefined)r.lastUnknownAt=old.lastUnknownAt;
    if(old && p.source==='resume' && old.transcriptPath===r.transcriptPath)r.lastHumanAt=old.lastHumanAt;
    if(client==='claude-code' && env.CLAUDE_CODE_MESSAGING_SOCKET)try {
      const socket=await safeFile(env.CLAUDE_CODE_MESSAGING_SOCKET.replace(/^uds:/,''),'socket');
      r.socketPath=socket.path;r.socketDev=socket.stat.dev;r.socketIno=socket.stat.ino;
      if(env.CLAUDE_CODE_MESSAGING_TOKEN)r.token=env.CLAUDE_CODE_MESSAGING_TOKEN;
    }catch {/* An unsupported endpoint still blocks older chats after human activity. */}
    r.configDir=env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude');
    if(typeof p.cwd==='string')r.cwd=p.cwd;
    r.receiveBlocked=r.configDir!==join(homedir(),'.claude');
    if(typeof p.cwd==='string')for(const name of ['settings.json','settings.local.json'])try{
      const settings=JSON.parse(await readFile(join(p.cwd,'.claude',name),'utf8'));
      if(settings.crossSessionInbound==='hold'||settings.crossSessionInbound==='refuse')r.receiveBlocked=true;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')r.receiveBlocked=true;}
    await writeRecord(dir,r);
  },{crossProcess:true,strictLocal:true});
}

export interface CodexChatRegistration {
  sessionId:string; generation:string; socketPath:string; token:string; transcriptPath:string; source?:string;
}
/** Only the local launcher invokes this, for its own connected terminal UI. */
export async function registerCodexChat(input:CodexChatRegistration,opts:ChatRegistryOptions={}):Promise<void> {
  if(!input.sessionId||input.sessionId.length>256||!input.generation||input.generation.length>256||!input.token)throw new Error('invalid_codex_registration');
  const dir=opts.dir??chatSessionsPath(),now=opts.now??Date.now();await privateDir(dir);
  const socket=await safeFile(input.socketPath,'socket'),transcript=await safeFile(input.transcriptPath,'file');
  if((transcript.stat.mode&0o077)!==0)throw new Error('unsafe_codex_journal');
  const path=join(dir,key('codex',input.sessionId));
  await withPathLock(path,async()=>{
    const old=await readRecord(path);
    const r:ChatSession={sessionId:input.sessionId,client:'codex',codexBridge:true,generation:input.generation,registeredAt:now,expiresAt:now+LEASE_MS,
      socketPath:socket.path,socketDev:socket.stat.dev,socketIno:socket.stat.ino,token:input.token,
      transcriptPath:transcript.path,transcriptDev:transcript.stat.dev,transcriptIno:transcript.stat.ino,generationOffset:transcript.stat.size,offset:transcript.stat.size};
    if(old?.lastUnknownAt!==undefined)r.lastUnknownAt=old.lastUnknownAt;
    if(input.source==='resume')r.lastHumanAt=old?.lastHumanAt;
    await writeRecord(dir,r);
  },{crossProcess:true,strictLocal:true});
}
export async function closeCodexChat(input:Pick<CodexChatRegistration,'sessionId'|'generation'>,opts:ChatRegistryOptions={}):Promise<void> {
  // Preserve an unread last human turn as a closed-chat barrier, even if the
  // UI exits before the daemon's next registry poll.
  await refreshChatRegistry(opts);
  const dir=opts.dir??chatSessionsPath(),path=join(dir,key('codex',input.sessionId));
  await withPathLock(path,async()=>{const r=await readRecord(path);if(r?.codexBridge&&r.generation===input.generation){r.closed=true;await writeRecord(dir,r);}}, {crossProcess:true,strictLocal:true});
}

async function readEvents(r:ChatSession,from:number): Promise<{events:Record<string,unknown>[];offset:number}> {
  const h=await open(r.transcriptPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const s=await h.stat();if(!s.isFile()||!owned(s)||s.size<from)throw new Error('transcript changed');
    if(r.transcriptDev===-1&&r.transcriptIno===-1){r.transcriptDev=s.dev;r.transcriptIno=s.ino;}
    if(s.dev!==r.transcriptDev||s.ino!==r.transcriptIno)throw new Error('transcript changed');
    const bytes=Math.min(MAX_READ,s.size-from);const buffer=Buffer.alloc(bytes);
    await h.read(buffer,0,bytes,from); const last=buffer.lastIndexOf(10);
    if(last<0)return {events:[],offset:from};
    const events:Record<string,unknown>[]=[];
    for(const line of buffer.subarray(0,last).toString('utf8').split('\n'))try {const v=JSON.parse(line);if(v&&typeof v==='object'&&!Array.isArray(v))events.push(v);}catch{/* partial/corrupt record supplies no evidence */}
    return {events,offset:from+last+1};
  } finally {await h.close();}
}
export function chatHumanTimestamp(client:string,e:Record<string,unknown>,now:number): number|null {
  if(e.agent_id || e.isSidechain===true || e.isMeta===true)return null;
  const origin=e.origin as Record<string,unknown>|undefined;
  const claude=client==='claude-code' && e.type==='user' && origin?.kind==='human' && e.turnOrigin==='human' && e.promptSource==='typed';
  const at=typeof e.timestamp==='string'?Date.parse(e.timestamp):NaN;
  return claude&&Number.isFinite(at)&&at<=now&&at>=0?at:null;
}
async function registryNames(dir:string): Promise<{names:string[];complete:boolean}> {
  const names:string[]=[];
  for await(const entry of await opendir(dir))if(/^[a-f0-9]{64}\.json$/.test(entry.name)) {
    if(names.length===MAX_HISTORY)return {names,complete:false};
    names.push(entry.name);
  }
  return {names,complete:true};
}
async function retireRecord(path:string,r:ChatSession,now:number,activeMinutes:number): Promise<boolean> {
  // Keep recent human/unknown barriers and the 24-hour processing-receipt
  // window, including for ended chats. Unread transcripts are never discarded.
  const keepSince=now-Math.max(LEASE_MS,activeMinutes*60000);
  if(Math.max(r.registeredAt,r.lastHumanAt??0,r.lastUnknownAt??0)>=keepSince)return false;
  if(!r.closed) {
    if(r.expiresAt>now)return false;
    try {
      const s=await lstat(r.transcriptPath);
      if(!s.isFile()||s.isSymbolicLink()||!owned(s)||s.dev!==r.transcriptDev||s.ino!==r.transcriptIno||s.size!==r.offset)return false;
    }catch{return false;}
  }
  await unlink(path);return true;
}
export async function refreshChatRegistry(opts:ChatRegistryOptions={}): Promise<ChatSession[]> {
  const dir=opts.dir??chatSessionsPath(),now=opts.now??Date.now();
  try {await privateDir(dir);}catch{return [];}
  const records:ChatSession[]=[];
  const {names,complete}=await registryNames(dir);
  // Inspect only small private records during history retirement. The existing
  // bound on transcript work still applies after this cheap first pass.
  const retained:string[]=[];
  for(const name of names) {
    const path=join(dir,name);
    await withPathLock(path,async()=>{
      const r=await readRecord(path);
      if(r&&!await retireRecord(path,r,now,opts.activeMinutes??30))retained.push(name);
    },{crossProcess:true,strictLocal:true});
  }
  // An incomplete sweep may retire old records but can never choose a chat.
  if(!complete||retained.length>MAX_SESSIONS)return [];
  for(const name of retained) {
    const path=join(dir,name);
    await withPathLock(path,async()=>{
      const r=await readRecord(path);if(!r)return;
      if(!r.closed)try {
        const {events,offset}=await readEvents(r,r.offset);
        let newestHuman:number|undefined;
        for(const e of events) {
          const at=chatHumanTimestamp(r.client==='codex'&&r.codexBridge?'claude-code':r.client,e,now);if(at!==null&&at>=r.registeredAt) {
            r.lastHumanAt=Math.max(r.lastHumanAt??0,at);
            newestHuman=Math.max(newestHuman??0,at);
          }
          const eventBody=e.payload as Record<string,unknown>|undefined;
          const origin=e.origin as Record<string,unknown>|undefined;
          const content=(e.message as {content?:unknown}|undefined)?.content;
          const toolResult=Array.isArray(content)&&content.length>0&&content.every(c=>c&&typeof c==='object'&&c.type==='tool_result');
          if(at===null && ((e.type==='user' && !toolResult && origin?.kind!=='peer' && !e.agent_id && e.isSidechain!==true && e.isMeta!==true) || (r.client==='codex'&&e.type==='event_msg'&&eventBody?.type==='user_message'))) {
            const unknownAt=typeof e.timestamp==='string'?Date.parse(e.timestamp):now;
            if(Number.isFinite(unknownAt)&&unknownAt>=r.registeredAt&&unknownAt<=now)r.lastUnknownAt=Math.max(r.lastUnknownAt??0,unknownAt);
          }
        }
        // A transcript turn can renew only this still-current endpoint;
        // a replaced socket never inherits the old generation's lease.
        if(newestHuman!==undefined&&r.socketPath)try {
          const {stat}=await safeFile(r.socketPath,'socket');
          if(stat.dev===r.socketDev&&stat.ino===r.socketIno)r.expiresAt=Math.max(r.expiresAt,newestHuman+LEASE_MS);
        }catch{/* Keep the old lease; delivery validation fails closed. */}
        r.offset=offset;r.unread=(await lstat(r.transcriptPath)).size>offset;await writeRecord(dir,r);
      }catch(error) {
        if((error as NodeJS.ErrnoException).code!=='ENOENT'||r.transcriptDev!==-1)r.closed=true;
        r.unread=true;await writeRecord(dir,r);
      }
      records.push(r);
    },{crossProcess:true,strictLocal:true});
  }
  return records;
}
export async function latestChatTarget(opts:ChatRegistryOptions={}): Promise<ChatSession|null> {
  const now=opts.now??Date.now();
  const all=await refreshChatRegistry(opts);
  if(all.some(r=>r.unread && !r.closed))return null;
  const newest=all.filter(r=>r.lastHumanAt!==undefined).sort((a,b)=>b.lastHumanAt!-a.lastHumanAt! || b.registeredAt-a.registeredAt);
  const target=newest[0];
  // Equal activity times across distinct chats are ambiguous, never guessed.
  if(!target || all.some(r=>(r.lastUnknownAt??0)>=target.lastHumanAt!) || (newest[1] && newest[1].lastHumanAt===target.lastHumanAt) || target.closed || target.receiveBlocked || target.expiresAt<=now || !(target.client==='claude-code'||target.client==='codex'&&target.codexBridge) || !target.socketPath || now-target.lastHumanAt!>(opts.activeMinutes??30)*60000)return null;
  return await validateChatTarget(target,opts)?target:null;
}
export async function validateChatTarget(target:ChatSession,opts:ChatRegistryOptions={}): Promise<boolean> {
  const dir=opts.dir??chatSessionsPath();
  try {
    await privateDir(dir);const r=await readRecord(join(dir,key(target.client,target.sessionId)));
    if(!r || r.closed || r.receiveBlocked || r.generation!==target.generation || r.expiresAt<=(opts.now??Date.now()) || !r.socketPath || r.socketPath!==target.socketPath)return false;
    // A pathname registered by two current generations cannot prove which
    // session owns it, even if the OS has recycled the socket inode.
    const {names,complete}=await registryNames(dir);
    if(!complete||names.length>MAX_SESSIONS)return false;
    for(const name of names) {
      const other=await readRecord(join(dir,name));
      if(other && !other.closed && other.expiresAt>(opts.now??Date.now()) && other.socketPath===r.socketPath
        && (other.sessionId!==r.sessionId || other.generation!==r.generation))return false;
    }
    if(r.client==='claude-code'&&r.cwd)for(const name of ['settings.json','settings.local.json'])try {
      const settings=JSON.parse(await readFile(join(r.cwd,'.claude',name),'utf8'));
      if(settings.crossSessionInbound==='hold'||settings.crossSessionInbound==='refuse')return false;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return false;}
    const {stat}=await safeFile(r.socketPath,'socket');
    if(!(stat.dev===target.socketDev && stat.ino===target.socketIno && r.socketDev===target.socketDev && r.socketIno===target.socketIno))return false;
    if(r.client==='codex')return !!r.codexBridge&&r.token===target.token&&await codexChatRequest(r,'validate');
    return true;
  }catch{return false;}
}
export async function invalidateChatTarget(target:ChatSession,opts:ChatRegistryOptions={}): Promise<void> {
  const dir=opts.dir??chatSessionsPath(),path=join(dir,key(target.client,target.sessionId));
  await withPathLock(path,async()=>{const r=await readRecord(path);if(r?.generation===target.generation){r.closed=true;await writeRecord(dir,r);}}, {crossProcess:true,strictLocal:true});
}
export async function readChatTranscriptEvents(target:ChatSession,opts:ChatRegistryOptions={}): Promise<Record<string,unknown>[]> {
  const r=await readRecord(join(opts.dir??chatSessionsPath(),key(target.client,target.sessionId)));
  if(!r || r.generation!==target.generation)return [];
  try {
    const size=(await lstat(r.transcriptPath)).size;
    const from=Math.max(r.generationOffset,size-MAX_READ);
    // A cut through a large first line is ignored by JSON parsing. This helper
    // follows the current tail instead of permanently rereading the first 2MB.
    return (await readEvents(r,from)).events;
  }catch{return [];}
}
export async function readChatPeerEvents(target:ChatSession,opts:ChatRegistryOptions={}): Promise<Record<string,unknown>[]> {
  return (await readChatTranscriptEvents(target,opts)).filter(e=>(e.origin as {kind?:string}|undefined)?.kind==='peer');
}
