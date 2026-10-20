import { bastraDataDir } from "../platform-paths.js";
/** A selected work root is not permission to overwrite control, key or vault state. */
import {realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {tasksPath} from "../task-store.js";
import {taskTargetSchema,readApprovalRegistry} from "../task-approval-keys.js";
import {resolveVault} from "./helpers.js";
const inside=(parent:string,path:string)=>{const r=relative(parent,path);return r===""||(!r.startsWith("..")&&!isAbsolute(r));};
const canonical=async(path:string)=>realpath(resolve(path)).catch(()=>resolve(path));
function invalid(reason:string):never{throw Object.assign(new Error("Target registration refused"),{code:"validation",reason});}
export async function normalizedOwnerTarget(input:unknown){
 const target=taskTargetSchema.parse(input);let root:string,absolute:string;
 try{root=await realpath(resolve(target.root));absolute=resolve(root,target.path);if(await realpath(absolute)!==absolute)invalid("target_boundary");}catch(e){if((e as any)?.reason)throw e;invalid("target_path_missing");}
 const path=relative(root,absolute);if(path.startsWith("..")||isAbsolute(path)||!path)invalid("target_boundary");
 const home=await canonical(homedir()),vault=await resolveVault({} as any),registry=await readApprovalRegistry();
 const protectedRoots=await Promise.all([dirname(tasksPath()),bastraDataDir(home),join(home,".claude"),join(home,".codex"),join(home,".cursor"),join(home,".config"),join(home,".ssh"),join(home,".gnupg"),join(home,"Library","LaunchAgents"),join(home,"Library","LaunchDaemons"),"/etc","/private/etc","/System","/Library",...(registry?.key_storage_roots??[]),...("path"in vault?[vault.path]:[])].map(canonical));
 if(protectedRoots.some(p=>inside(p,absolute)||inside(p,root)||inside(root,p)))invalid("target_protected");
 const components=absolute.split(sep).map(p=>p.toLowerCase()),dangerousDirs=new Set([".git",".husky",".bastra",".claude",".codex",".cursor",".config",".ssh",".gnupg",".gemini",".continue",".vscode",".cmuxterm","launchagents","launchdaemons"]);
 const shell=new Set([".zshrc",".zprofile",".zshenv",".zlogin",".zlogout",".bashrc",".bash_profile",".bash_login",".bash_logout",".profile","config.fish","profile","bash.bashrc"]);
 const controls=new Set([".envrc",".npmrc",".claude.json",".mcp.json","mcp.json","task-approval-keys.json","task-auth.json","task-owner-token.json","task-hook-token.json","owner-key.json","approval-key.json"]);
 if(components.some(p=>dangerousDirs.has(p))||components.some((p,i)=>p===".github"&&components[i+1]==="workflows")||shell.has(basename(absolute).toLowerCase())||controls.has(basename(absolute).toLowerCase())||basename(absolute).toLowerCase().endsWith(".plist"))invalid("target_protected");
 return {...target,root,path,execution_warning:basename(absolute).toLowerCase()==="package.json" ? "WARNUNG: package.json kann Install-/Test-/Start-Skripte definieren, die später Code ausführen. Exakte Skriptänderungen vor der Freigabe prüfen." : undefined,outside_current_workdir:!inside(await canonical(process.cwd()),root)};
}
