import { assistantAddressStatus, changeAssistantName, setupAssistantAddress, removeAssistantAddress, notifyAssistantAddressDaemon, addressRemovalNeedsConsent, openAssistantAddress, type AssistantAddressOptions } from "../assistant-address.js";
import { normalizeAssistantName, assistantUrls } from "../assistant-address-name.js";
import { confirm } from "./prompt.js";
import type { ParsedArgs } from "./types.js";
export async function cmdAddress(args:ParsedArgs,options?:AssistantAddressOptions):Promise<number>{
 options??={};
 try{
  const action=args.surface??"status",value=args.positional[2];
  if(action==="status"){const s=await assistantAddressStatus(options);process.stdout.write(args.json?JSON.stringify(s)+"\n":`${s.name??"Kein Assistentenname gesetzt"}\n${s.urls?`${s.urls.local}\n${s.urls.bare}\n`:""}${s.ready?"Adresse erreichbar":"Adresse noch nicht eingerichtet oder Dienst nicht erreichbar"}\n${s.bareNameNotice}\n${s.repair??""}\n`);return 0;}
  if(!["setup","remove"].includes(action))throw new Error("bastra address status | setup [name] [--yes] | remove [--yes]");
  if(args.dryRun){if(value)normalizeAssistantName(value);process.stdout.write(`Würde lokale Adresse ${action==="remove"?"entfernen":"einrichten"}: ${value?JSON.stringify(assistantUrls(value)):"gespeicherter Name"}. hosts und eigener Socket-Helfer brauchen Systemfreigabe; nur eigene Firefox-Prefs werden verändert.\n`);return 0;}
  const needs=action==="setup"||await addressRemovalNeedsConsent(options);
  const allowed=!needs||args.yes||(process.stdin.isTTY&&process.stdout.isTTY&&await confirm("Lokalen Assistentennamen, eigenen Adress-Helfer und Firefox-Eintrag ändern? macOS fragt einmal nach Administratorrechten. Keine fremden Einträge werden überschrieben."));
  if(!allowed)throw new Error("Nicht bestätigt; nichts geändert. Nach Prüfung mit --yes ausführen.");
  if(action==="setup"){const result=await setupAssistantAddress({...options,name:value,systemConsent:true,openBrowser:options.openBrowser??openAssistantAddress});if(result.warning)process.stdout.write(result.warning+"\n");}else await removeAssistantAddress({...options,systemConsent:!!allowed});
  await notifyAssistantAddressDaemon();process.stdout.write(action==="setup"?"Lokale Adresse eingerichtet. Adresse einmal im Browser öffnen; Firefox ggf. neu starten. Ein purer Name bleibt browserabhängig.\n":"Eigene Adresse und Browser-Einträge entfernt.\n");return 0;
 }catch(e){process.stderr.write(`${(e as Error).message}\n`);return 1;}
}
export async function configureAssistantName(value:string):Promise<void>{
 try{await changeAssistantName(value);}catch(e){if(/consent|Zustimmung/i.test((e as Error).message)&&process.stdin.isTTY&&process.stdout.isTTY&&await confirm("Eigene Systemadresse für den neuen Namen ändern? macOS fragt nach Administratorrechten."))await changeAssistantName(value,{systemConsent:true,openBrowser:openAssistantAddress});else throw e;}
 await notifyAssistantAddressDaemon();
}
