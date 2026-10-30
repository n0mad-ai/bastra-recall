/** Same-origin UI setting and explicitly consented system setup. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getUiEnabled } from "./settings.js";
import { sendJson, readJsonBody } from "./http-util.js";
import { changeAssistantName, setupAssistantAddress, assistantAddressStatus, openAssistantAddress, type AssistantAddressOptions } from "./assistant-address.js";
const change=z.strictObject({name:z.string().min(1),systemConsent:z.boolean().optional()});
const consent=z.strictObject({systemConsent:z.literal(true)});
export async function handleAssistantAddressUi(req:IncomingMessage,res:ServerResponse,method:string,path:string,options:AssistantAddressOptions,refresh:()=>Promise<{port?:number}>) {
 if(path!=="/ui/assistant-address/refresh"&&!await getUiEnabled(options.settingsPath)){sendJson(res,404,{error:"UI is disabled"});return;}
 try{
  if(method==="POST"){
   const body=await readJsonBody(req,4096);
   if(path==="/ui/assistant-address/setup"){
    const input=consent.parse(body);await setupAssistantAddress({...options,systemConsent:input.systemConsent,openBrowser:options.openBrowser??openAssistantAddress});
   }else if(path==="/ui/assistant-address"){
    const input=change.parse(body);await changeAssistantName(input.name,{...options,systemConsent:input.systemConsent,openBrowser:options.openBrowser??openAssistantAddress});
   }else if(path==="/ui/assistant-address/refresh"){z.strictObject({}).parse(body);}
   else{sendJson(res,404,{error:"not found"});return;}
  }else if(method!=="GET"||path!=="/ui/assistant-address"){sendJson(res,405,{error:"method not allowed"});return;}
  const listener=await refresh();
  sendJson(res,200,{...await assistantAddressStatus({...options,gatewayPort:listener.port??options.gatewayPort}),fallbackUrl:`${options.daemonUrl}/ui/`});
 }catch(e){const error=(e as Error).message,needsConsent=/consent|Zustimmung/i.test(error);sendJson(res,needsConsent?409:400,{error,code:needsConsent?"system_consent_required":"address_setup_failed"});}
}
