/** Response boundary for action-specific gate reservations. HTTP finish is a
 * transport receipt, never proof that the assistant read or followed a rule. */
import {AsyncLocalStorage} from "node:async_hooks";
import type {ServerResponse} from "node:http";
type Receipt=(delivered:boolean)=>Promise<void>;
interface Delivery {register(receipt:Receipt,deadline:number):void;}
const currentDelivery=new AsyncLocalStorage<Delivery>();
export async function confirmLaneDelivery(receipt:Receipt,deadline:number):Promise<void>{
 const current=currentDelivery.getStore();if(current){current.register(receipt,deadline);return;}
 // In-process callers observe the returned lane document directly.
 await receipt(Date.now()<deadline);
}
export function createLaneDelivery(res:ServerResponse){
 const callbacks:Array<{receipt:Receipt;deadline:number}>=[];let completed:boolean|undefined,denied=false;
 const invoke=(entry:{receipt:Receipt;deadline:number},ok:boolean)=>{void entry.receipt(ok&&Date.now()<entry.deadline).catch(()=>{});};
 const settle=(ok:boolean)=>{if(completed!==undefined)return;completed=ok&&denied;for(const entry of callbacks)invoke(entry,completed);callbacks.length=0;};
 res.once("finish",()=>settle(true));res.once("close",()=>{if(!res.writableFinished)settle(false);});
 const scope:Delivery={register(receipt,deadline){const entry={receipt,deadline};if(completed===undefined)callbacks.push(entry);else invoke(entry,completed);}};
 return {
  run<T>(operation:()=>Promise<T>):Promise<T>{return currentDelivery.run(scope,operation);},
  answer(body:string){
   if(res.destroyed||res.writableEnded){settle(false);return;}
   try{denied=JSON.parse(body).hookSpecificOutput?.permissionDecision==="deny";}catch{denied=false;}
   res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});res.end(body);
  },
 };
}
