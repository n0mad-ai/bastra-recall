/** #1330: parse Bash syntax, never execute it. Grammar is pinned, portable WASM.
 * Only command nodes (plus known exec wrappers) become action candidates;
 * quoted prose and literal heredoc bodies are not command nodes. */
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Parser,Language,type Node} from "web-tree-sitter";
let parserPromise:Promise<Parser>|undefined;
function parser(){return parserPromise??= (async()=>{
 const [bytes,raw]=await Promise.all([readFile(new URL("../vendor/tree-sitter-bash.wasm",import.meta.url)),readFile(new URL("../vendor/tree-sitter-bash.json",import.meta.url),"utf8")]);
 if(createHash("sha256").update(bytes).digest("hex")!==JSON.parse(raw).sha256)throw Error("Bash grammar checksum mismatch");
 await Parser.init();const p=new Parser();p.setLanguage(await Language.load(bytes));return p;
})();}
function literal(node:Node):string|null{
 if(node.type==="command_name")return node.namedChildren.length===1?literal(node.namedChildren[0]):null;
 if(node.type==="raw_string")return node.text.slice(1,-1);
 if(node.type==="string"){
  if(node.namedChildren.some(c=>!["string_content","escape_sequence"].includes(c.type)))return null;
  return node.text.slice(1,-1).replace(/\\(["$`\\\n])/g,"$1");
 }
 if(node.type==="concatenation"){
  const pieces=node.namedChildren.map(literal);return pieces.some(p=>p===null)?null:pieces.join("");
 }
 if(["word","number","string_content","escape_sequence"].includes(node.type)&&node.namedChildren.length===0)return node.text.replace(/\\(.)/gs,"$1");
 return null; // dynamic expansion is not a known executable/option value
}
const base=(s:string|null|undefined)=>s?.split("/").pop()??"";
const SHELLS=new Set(["bash","sh","zsh","dash","ksh"]);
const WRAPPER_VALUES:Record<string,Set<string>>={
 sudo:new Set(["-u","-g","-h","-p","-C","-T","-R","-D","--user","--group","--host","--prompt","--close-from","--command-timeout","--chroot","--chdir"]),
 nice:new Set(["-n","--adjustment"]),time:new Set(["-o","--output"]),env:new Set(["-u","--unset","-C","--chdir"]),
 xargs:new Set(["-a","-d","-E","-I","-L","-n","-P","-s","--arg-file","--delimiter","--eof","--replace","--max-lines","--max-args","--max-procs","--max-chars"]),
 timeout:new Set(["-k","--kill-after","-s","--signal"]),watch:new Set(["-n","--interval"]),
 command:new Set(),exec:new Set(["-a"]),nohup:new Set(),
};
const GH_VALUES=new Set(["-b","--body","-t","--title","-F","--body-file","-l","--label","--add-label","--remove-label","-m","--milestone","-R","--repo","-B","--base","-H","--head","-a","--assignee","-r","--reviewer","--author","--project","--add-project","--remove-project"]);
function hasHelp(args:Array<string|null>,values:Set<string>):boolean{
 for(let i=0;i<args.length;i++){
  const a=args[i];if(a==="--")return false;if(a==="--help"||a==="-h")return true;
  if(a&&values.has(a))i++;
 }return false;
}
function ghAction(args:Array<string|null>):string|null{
 let i=0;
 while(args[i]?.startsWith("-")){
  const a=args[i++];if(a==="--help"||a==="-h")return null;
  if(a==="-R"||a==="--repo"||a==="--hostname")i++;
  else if(!/^(?:-R.+|--(?:repo|hostname)=)/.test(a??""))return null;
 }
 const resource=args[i++],verb=args[i++];
 if(resource==="issue"||resource==="pr"){
  if(!["create","edit","comment",...(resource==="pr"?["review"]:[])].includes(verb??"")||hasHelp(args.slice(i),GH_VALUES))return null;
  return `gh ${resource} ${verb}`;
 }
 if(resource!=="api")return null;
 const all=[verb??null,...args.slice(i)],values=new Set(["-X","--method","-H","--header","-f","--raw-field","-F","--field","--input","--hostname","-q","--jq","-t","--template","--cache","--preview"]);
 if(hasHelp(all,values))return null;
 let method:string|undefined,endpoint:string|null=null,body=false;
 for(let n=0;n<all.length;n++){
  const a=all[n];if(a===null)continue;
  if(a==="-X"||a==="--method"){method=all[++n]?.toUpperCase();continue;}
  if(a.startsWith("--method=")){method=a.slice(9).toUpperCase();continue;}
  if(a.startsWith("-X")&&a.length>2){method=a.slice(2).toUpperCase();continue;}
  if(a==="-f"||a==="-F"||a==="--field"||a==="--raw-field"||a==="--input")body=true;
  if(/^(?:-[fF].+|--(?:field|raw-field|input)=)/.test(a))body=true;
  if(values.has(a)){n++;continue;}
  if(!a.startsWith("-")&&endpoint===null)endpoint=a;
 }
 method??=body?"POST":"GET";
 if(!["POST","PATCH","PUT","DELETE"].includes(method)||!endpoint)return null;
 const match=/(?:^|\/)(issues|pulls)(?:\/|\?|$)/.exec(endpoint);if(!match)return null;
 const target=match[1]==="issues"?"issue":"pr";
 const action=method==="POST"?(endpoint.split("?")[0].endsWith(match[1])?"create":"comment"):"edit";
 return `gh ${target} ${action} via gh api ${method}`;
}
export async function githubWriteActions(source:string):Promise<string[]>{
 if(source.length>65536||!source.includes("gh"))return [];
 try{
  const p=await parser(),actions=new Set<string>(),deadline=Date.now()+50;let visited=0;
  const parse=(text:string,depth:number)=>{
   if(depth>8||Date.now()>=deadline)throw Error("shell parse budget");
   const tree=p.parse(text,null,{progressCallback:()=>Date.now()>=deadline});if(!tree)throw Error("shell parse cancelled");
   try{
    if(tree.rootNode.hasError)throw Error("unsupported shell syntax");
    const definitions=new Map<string,Node>();
    for(const n of tree.rootNode.namedChildren)if(n.type==="function_definition"){const name=n.childForFieldName("name"),body=n.childForFieldName("body");if(name&&body)definitions.set(name.text,body);}
    const visit=(node:Node,level:number)=>{
     if(++visited>20000||level>128||Date.now()>=deadline)throw Error("shell traversal budget");
     if(node.type==="function_definition")return;
     if(node.type==="command"){
      const name=node.childForFieldName("name"),nodes=name?[name,...node.childrenForFieldName("argument")]:[];
      const words=nodes.map(literal);let i=0,wrapper=base(words[i]);
      while(Object.hasOwn(WRAPPER_VALUES,wrapper)){
       const kind=wrapper,values=WRAPPER_VALUES[wrapper];let execMode=false,readOnly=false;i++;
       if(wrapper==="command"&&(words[i]==="-v"||words[i]==="-V"))return;
       while(i<words.length){
        const a=words[i];if(a===null)break;
        if(wrapper==="env"&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)){i++;continue;}
        if(a==="--"){i++;break;}if(!a.startsWith("-"))break;
        if(a==="--help"||a==="--version"){readOnly=true;break;}
        if(kind==="watch"&&(a==="--exec"||a==="-x"))execMode=true;
        i++;if(values.has(a))i++;
       }
       if(readOnly){wrapper="";break;}
       if(kind==="timeout"){if(!/^(?:\d+(?:\.\d+)?)(?:[smhd])?$/.test(words[i]??""))break;i++;}
       if(kind==="watch"&&!execMode){const script=words.slice(i);if(script.every(w=>w!==null))parse(script.join(" "),depth+1);wrapper="";break;}
       wrapper=base(words[i]);
      }
      if(wrapper==="gh"){const action=ghAction(words.slice(i+1));if(action)actions.add(action);}
      else if(wrapper==="eval"){const script=words.slice(i+1);if(script[0]==="--")script.shift();if(!script[0]?.startsWith("-")&&script.every(w=>w!==null))parse(script.join(" "),depth+1);}
      else if(SHELLS.has(wrapper)){
       const at=words.findIndex((w,n)=>n>i&&w!==null&&/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
       if(at>=0&&words[at+1]!==null&&words[at+1]!==undefined)parse(words[at+1]!,depth+1);
       // A shell reading a literal heredoc executes it; cat/tee/gh do not.
       if(at<0&&node.parent?.type==="redirected_statement")for(const redirect of node.parent.childrenForFieldName("redirect")){
        const body=redirect.namedChildren.find(c=>c.type==="heredoc_body");if(body)parse(body.text,depth+1);
       }
      }else if(words[i]&&definitions.has(words[i]!))visit(definitions.get(words[i]!)!,level+1);
     }
     for(const child of node.namedChildren)visit(child,level+1);
    };
    visit(tree.rootNode,0);
   }finally{tree.delete();}
  };
  try{parse(source,0);}finally{p.reset();}
  return [...actions];
 }catch{return [];} // parse errors, missing assets and time budgets never block the shell
}

/** Technical command-effect classification only; never decides rule applicability.
 * Unknown/dynamic commands stay opaque and potentially mutating. */
export async function shellIsReadOnly(source: string): Promise<boolean> {
 if (!source || source.length > 65536) return false;
 try {
  const p = await parser(), tree = p.parse(source); if (!tree) return false;
  try {
   if (tree.rootNode.hasError) return false;
   let commands = 0;
   const visit = (node: Node): boolean => {
    if (["command_substitution", "process_substitution", "function_definition", "variable_assignment", "file_redirect", "heredoc_redirect"].includes(node.type)) return false;
    if (node.type === "command") {
     commands++;
     const name = node.childForFieldName("name");
     const words = name ? [name, ...node.childrenForFieldName("argument")].map(literal) : [];
     if (!words.length || words.some(w => w === null)) return false;
     const [head, ...args] = words as string[];
     if (["cat", "head", "tail", "wc", "printf", "echo", "pwd", "ls", "stat", "readlink", "uname", "uptime", "which", "true", "false"].includes(head)) return true;
     if (["rg", "grep", "egrep", "fgrep"].includes(head)) return !args.some(a => /^(?:--pre(?:=|$)|--hostname-bin(?:=|$))/.test(a));
     if (head === "sed") return args[0] === "-n" && args.length >= 2 && /^\d+(?:,\d+)?p$/.test(args[1]) && !args.slice(2).some(a => a.startsWith("-"));
     if (head === "git") return ["status", "log", "diff", "show", "rev-parse", "ls-files"].includes(args[0]) && !args.some(a => /^(?:--output(?:=|$)|--ext-diff|--textconv)/.test(a));
     return false;
    }
    return node.namedChildren.every(visit);
   };
   return visit(tree.rootNode) && commands > 0;
  } finally { tree.delete(); }
 } catch { return false; }
}
