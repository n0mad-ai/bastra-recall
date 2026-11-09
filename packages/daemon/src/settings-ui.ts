/** Local browser session + CSRF for the complete settings surface. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isLoopback, isLoopbackHost, hasForwardingHeaders, gateLocalPost, safeEqual } from "./http-auth.js";
import { readJsonBody, sendJson } from "./http-util.js";
import { getUiEnabled, mutateSettings, readSettings, settingsFilePath } from "./settings.js";
import { settingEntries, storedSetting, applySettingChanges } from "./settings-registry.js";
import { effectiveSetting } from "./settings-effective.js";
import { listClients, revokeClient } from "./oauth-store.js";
const sessions = new Map<string,{csrf:string;expires:number;path:string;host:string}>();
const ttl = 15*60_000, cookieName = "bastra_settings_session";
const cookie = (id:string,age:number) => `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/ui/settings; Max-Age=${age}`;
export interface SettingsUiOptions { path?: string; oauthPath?: string; restart?: () => Promise<void>; }
function failure(status:number):never { throw Object.assign(new Error("Settings request denied"),{status}); }
async function snapshot(path:string,options:SettingsUiOptions) {
  const settings = await readSettings(path);
  return {
    entries: settingEntries().map(entry => {
      const stored=storedSetting(settings,entry), effective=effectiveSetting(entry,settings), mask=(value:unknown)=>entry.secret?(value===undefined||value===null?null:"••••••••"):value;
      return {key:entry.key,label:entry.label,area:entry.area,kind:entry.kind,choices:entry.choices,default:mask(entry.default),value:mask(stored??entry.default),effective:mask(effective.value),isSet:stored!==undefined,secret:!!entry.secret,readonly:!!entry.readonly,managed:entry.key==="assistant.name",restartRequired:!!entry.restartRequired,
        envOverride:effective.envNames.map(name=>({name,value:entry.secret?"••••••••":process.env[name]}))};
    }),
    oauthClients: (await listClients(options.oauthPath ?? (options.path ? join(dirname(path), "oauth.json") : undefined))).map(client=>({id:client.client_id,name:client.client_name,grants:client.grants,lastUsedAt:client.last_used_at})),
    restartAvailable:!!options.restart,
  };
}
export function dispatchSettingsUi(req:IncomingMessage,res:ServerResponse,method:string,url:string,options:SettingsUiOptions={}):boolean {
  if(url!=="/ui/settings"&&!url.startsWith("/ui/settings/"))return false;
  void (async()=>{
    try {
      res.setHeader("Cache-Control","no-store");
      if(!isLoopback(req)||!isLoopbackHost(req.headers.host,[])||hasForwardingHeaders(req))failure(403);
      const path=resolve(options.path??settingsFilePath());
      if(!await getUiEnabled(path))failure(404);
      if(method==="POST"&&gateLocalPost({origin:req.headers.origin,host:req.headers.host,contentType:req.headers["content-type"],path:url})!==200)failure(403);
      for(const[id,session]of sessions)if(session.expires<=Date.now())sessions.delete(id);
      if(url==="/ui/settings/session"&&method==="POST") {
        const body=await readJsonBody(req,256);if(Object.keys(body).length)failure(400);
        if(sessions.size>=100)failure(429);
        const id=randomBytes(32).toString("base64url"),csrf=randomBytes(32).toString("base64url");
        sessions.set(id,{csrf,expires:Date.now()+ttl,path,host:req.headers.host!});
        res.setHeader("Set-Cookie",cookie(id,ttl/1000));sendJson(res,200,{csrf,expiresIn:ttl/1000});return;
      }
      const id=req.headers.cookie?.split(";").map(c=>c.trim()).find(c=>c.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
      const session=id?sessions.get(id):undefined;
      if(!session||session.path!==path||session.host!==req.headers.host)failure(401);
      if(method==="GET"&&url==="/ui/settings") {sendJson(res,200,await snapshot(path,options));return;}
      if(method!=="POST")failure(405);
      const csrf=req.headers["x-bastra-settings-csrf"];if(typeof csrf!=="string"||!safeEqual(csrf,session.csrf))failure(403);
      const body=await readJsonBody(req,128*1024);
      if(url==="/ui/settings") {
        if(Object.keys(body).some(k=>k!=="changes")||!body.changes||typeof body.changes!=="object"||Array.isArray(body.changes))failure(400);
        const changes=body.changes as Record<string,unknown>;
        // Name/address edits retain the existing native system-consent transaction.
        if(Object.hasOwn(changes,"assistant.name"))failure(400);
        await mutateSettings(path,current=>applySettingChanges(current,changes),{refuseCorrupt:true,requireLock:true});
        sendJson(res,200,await snapshot(path,options));return;
      }
      if(url==="/ui/settings/oauth/revoke") {
        if(Object.keys(body).some(k=>k!=="clientId")||typeof body.clientId!=="string")failure(400);
        await revokeClient(body.clientId,options.oauthPath ?? (options.path ? join(dirname(path), "oauth.json") : undefined));sendJson(res,200,await snapshot(path,options));return;
      }
      if(url==="/ui/settings/restart") {
        if(Object.keys(body).length)failure(400);if(!options.restart)failure(409);
        sendJson(res,202,{restarting:true});setImmediate(()=>void options.restart!().catch(()=>{}));return;
      }
      if(url==="/ui/settings/logout") {sessions.delete(id!);res.setHeader("Set-Cookie",cookie("",0));sendJson(res,200,{loggedOut:true});return;}
      failure(404);
    } catch(error) {
      const status=(error as {status?:number}).status??400;
      // Neither parser errors, SQLite errors nor supplied values leave this endpoint.
      sendJson(res,status,{error:status===401?"Einstellungssitzung erforderlich":status===403?"Zugriff nicht erlaubt":"Einstellungen konnten nicht verarbeitet werden"});
    }
  })();return true;
}
