/** #1407: execute the shipped panel against a small deterministic DOM fixture. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
class Element {
 children:Element[]=[];handlers:Record<string,Function>={};id="";value="";textContent="";disabled=false;validityMessage="";focused=false;
 append(...nodes:Element[]){this.children.push(...nodes);}replaceChildren(){this.children=[];}setAttribute(){}showModal(){}close(){}
 addEventListener(name:string,fn:Function){this.handlers[name]=fn;}setCustomValidity(text:string){this.validityMessage=text;}reportValidity(){return !this.validityMessage;}focus(){this.focused=true;}
}
const all=(node:Element):Element[]=>[node,...node.children.flatMap(all)];
async function panel(){
 const nodes=new Map<string,Element>();const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)!;};
 const model={entries:[{key:"test.json",label:"JSON",kind:"json",area:"general",value:[],default:[],effective:[],envOverride:[]}],oauthClients:[]};
 const writes:any[]=[];
 const source=await readFile(new URL("../webui/js/settings.js",import.meta.url),"utf8");
 runInNewContext(source.replace("export function","function")+"\ncreateSettingsPanel();",{document:{getElementById:(id:string)=>all(get("settings-fields")).find(n=>n.id===id)??get(id),createElement:()=>new Element()},fetch:async(path:string,options:any)=>{if(path==="/ui/settings"&&options.method==="POST")writes.push(JSON.parse(options.body));return{ok:true,json:async()=>path.endsWith("/session")?{csrf:"fixture"}:model};}});
 await get("settings-open").handlers.click();
 return{get,writes,input:()=>all(get("settings-fields")).find(n=>n.id==="setting-test-json")!};
}
test("#1407 invalid replacement blocks stale JSON save and focuses editor until corrected",async()=>{
 const p=await panel();let input=p.input();input.value='["earlier"]';input.handlers.change();input.value="[broken";input.handlers.change();
 await p.get("settings-save").handlers.click();assert.equal(p.writes.length,0);assert.equal(p.input().value,"[broken");assert.ok(p.input().focused);assert.equal(p.get("settings-save").disabled,false);
 input=p.input();input.value='["corrected"]';input.handlers.change();await p.get("settings-save").handlers.click();assert.deepEqual(p.writes,[{changes:{"test.json":["corrected"]}}]);
});
test("#1407 invalid draft survives navigation and reset explicitly clears it",async()=>{
 const p=await panel();p.input().value='["earlier"]';p.input().handlers.change();p.input().value="{";p.input().handlers.change();
 const nav=p.get("settings-nav");nav.children[1].handlers.click();await p.get("settings-save").handlers.click();assert.equal(p.writes.length,0);assert.equal(p.input().value,"{");assert.ok(p.input().focused);
 all(p.get("settings-fields")).find(n=>n.textContent==="Standard")!.handlers.click();await p.get("settings-save").handlers.click();assert.deepEqual(p.writes,[{changes:{"test.json":null}}]);
});
test("#1407 invalid-only edits block restart until explicitly corrected or reset",async()=>{
 const p=await panel();p.input().value="{";p.input().handlers.change();await p.get("settings-restart").handlers.click();
 assert.equal(p.get("settings-status").textContent,"Änderungen zuerst speichern.");
});
