/** Manual visual fixture. All state is created below a fresh temporary root.
 * Run from repository root with node --import tsx --import ./scripts/test-env.mjs.
 * The restart button only records a request in this fixture; no daemon is restarted. */
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root=await mkdtemp(join(os.tmpdir(),"bastra-settings-ui-"));
os.homedir=()=>root;syncBuiltinESMExports();
Object.assign(process.env,{BASTRA_DB_PATH:join(root,".bastra","recall.db"),BASTRA_TELEMETRY:"off",BASTRA_UPDATE_CHECK:"off",BASTRA_HOOK_STATE_DIR:join(root,"hooks"),BASTRA_FLOORS_PATH:join(root,".bastra","floors.json"),BASTRA_SKILLS_PATH:join(root,".bastra","skills.json"),BASTRA_OAUTH_PATH:join(root,".bastra","oauth.json"),BASTRA_LOG_PATH:join(root,"logs")});
const {Vault,SearchIndex}=await import("@bastra-recall/core");
const {startHttpServer}=await import("../../src/http.js");
const {mutateSettings,settingsFilePath}=await import("../../src/settings.js");
const {Telemetry}=await import("../../src/telemetry.js");
const {registerClient}=await import("../../src/oauth-store.js");
await mutateSettings(settingsFilePath(),settings=>({...settings,ui:{enabled:true},language:{primary:"de"},api:{token:"invented-fixture-token"}}));
await registerClient({client_name:"Beispiel-Client",redirect_uris:["http://localhost/callback"]});
const vaultDir=join(root,"vault");await mkdir(vaultDir);const vault=new Vault(vaultDir);await vault.init();const search=new SearchIndex(vault);search.start();const telemetry=new Telemetry({logDir:join(root,"logs")});
const handle=await startHttpServer({port:0,vault,search,telemetry,version:"settings-fixture",toolDeps:{vault,search,telemetry,vaultPath:vaultDir},documentWriteEnabled:false,embedding:{on:false,providerId:null,source:"none"},settingsUi:{restart:async()=>{await writeFile(join(root,"restart-requested"),"fixture request only\n");}}});
process.stderr.write(`Settings fixture: http://127.0.0.1:${handle.port}/ui/\nTemporary root: ${root}\n`);
process.on("SIGTERM",async()=>{await handle.close();search.stop();await vault.stop();process.exit(0);});
