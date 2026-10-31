#!/usr/bin/env python3
"""Real pinned Codex CLI, isolated config, synthetic local Responses provider only."""
import struct,zlib,base64,http.server,json,os,pathlib,shlex,shutil,subprocess,tempfile,threading
REPO=pathlib.Path(__file__).resolve().parents[3]
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='bastra-codex-gate-probe-'))
VERSION=subprocess.check_output(['codex','--version'],text=True).strip()
assert VERSION=='codex-cli 0.166.0',VERSION
HOOK=ROOT/'gate.mts'
HOOK.write_text(r'''
import {appendFile,writeFile} from 'node:fs/promises';
const root=process.env.PROBE_ROOT!;
process.env.BASTRA_HOOK_STATE_DIR=root+'/state';
process.env.BASTRA_LOG_PATH=root+'/logs';
process.env.BASTRA_TELEMETRY='0';
let raw='';for await(const b of process.stdin)raw+=b;
const native=JSON.parse(raw);
let out='{}';
if(process.env.PROBE_MODE==='deny')out=JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'SYNTHETIC_GATE_DENIED'}});
if(process.env.PROBE_MODE==='bastra'){
 const {mutateSessionState}=await import('__REPO__/packages/daemon/src/session-state.ts');
 const {runGateLane}=await import('__REPO__/packages/daemon/src/gate-lane.ts');
 await mutateSessionState(native.session_id,s=>{
  if(!s.constants?.probeSeeded){(s.constants??={}).probeSeeded='1';s.pendingMustLoad=[{id:'invented-probe-rule',block:'probe',at:Date.now()}];}
 });
 out=await runGateLane({...native,bastra_client:'codex',bastra_codex_version:'0.166.0'},{reflexPool:()=>[]});
}
await appendFile(root+'/payloads.jsonl',JSON.stringify({native,returned:JSON.parse(out)})+'\n');
process.stdout.write(out);
'''.replace('__REPO__',str(REPO)))

def tool_names(obj):
 out=[]
 if isinstance(obj,dict):
  if obj.get('type')=='function' and isinstance(obj.get('name'),str):out.append(obj['name'])
  for x in obj.values():out+=tool_names(x)
 elif isinstance(obj,list):
  for x in obj:out+=tool_names(x)
 return out

def images(obj):
 if isinstance(obj,dict):return int(obj.get('type') in ['input_image','image'])+sum(images(x) for x in obj.values())
 if isinstance(obj,list):return sum(images(x) for x in obj)
 return 0
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  request=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
  s=self.server;s.count+=1;n=s.count
  outs=[x for x in request.get('input',[]) if isinstance(x,dict) and x.get('type')=='function_call_output']
  s.requests.append({'request':n,'tool_names':tool_names(request.get('tools',[])),'tool_outputs':outs,'image_count':images(request.get('input',[]))})
  if n <= (2 if s.mode=='bastra' else 1):
   args={'cmd':'printf CODEX_GATE_EXECUTED','max_output_tokens':50} if s.tool=='exec_command' else {'path':str(s.case/'image.png')}
   item={'id':f'fc_{n}','call_id':f'call_probe_{n}','type':'function_call','name':s.tool,'arguments':json.dumps(args),'status':'completed'}
   events=[('response.output_item.added',{'output_index':0,'item':{**item,'arguments':'','status':'in_progress'}}),('response.function_call_arguments.delta',{'item_id':item['id'],'output_index':0,'delta':item['arguments']}),('response.function_call_arguments.done',{'item_id':item['id'],'output_index':0,'arguments':item['arguments']}),('response.output_item.done',{'output_index':0,'item':item})]
  else:
   text='GATE_PROBE_DONE';item={'id':f'msg_{n}','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':text,'annotations':[]}]}
   events=[('response.output_item.added',{'output_index':0,'item':{**item,'content':[],'status':'in_progress'}}),('response.content_part.added',{'item_id':item['id'],'output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}}),('response.output_text.delta',{'item_id':item['id'],'output_index':0,'content_index':0,'delta':text}),('response.output_item.done',{'output_index':0,'item':item})]
  response={'id':f'resp_{n}','object':'response','created_at':1,'status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
  events=[('response.created',{'response':{**response,'status':'in_progress','output':[]}}),*events,('response.completed',{'response':response})]
  data=''.join('event: '+name+'\ndata: '+json.dumps({'type':name,**payload})+'\n\n' for name,payload in events).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
results=[]
try:
 for tool in ['exec_command','view_image']:
  for mode in ['allow','deny','bastra']:
   case=ROOT/(tool+'-'+mode);case.mkdir();home=case/'config';home.mkdir();(home/'config.toml').write_text('')
   def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
   (case/'image.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\0\0'*2)*2))+chunk(b'IEND',b''))
   server.mode=mode;server.tool=tool;server.case=case;server.count=0;server.requests=[]
   command=shlex.join([shutil.which('node'),'--import',str(REPO/'node_modules/tsx/dist/loader.mjs'),str(HOOK)])
   args=['codex','exec','--cd',str(case),'--skip-git-repo-check','--sandbox','read-only','--dangerously-bypass-hook-trust','--ephemeral','-c','features.apps=false','-c','model_provider="probe"','-c','model="native-hook-fixture"','-c','model_providers.probe.name="Isolated local fixture"','-c',f'model_providers.probe.base_url="http://127.0.0.1:{server.server_port}"','-c','model_providers.probe.wire_api="responses"','-c','model_providers.probe.requires_openai_auth=false','-c',f'projects.{json.dumps(str(case))}.trust_level="trusted"','-c',f'hooks.PreToolUse=[{{matcher="*",hooks=[{{type="command",command={json.dumps(command)},timeout=10}}]}}]','Use the provided tool and then finish. Synthetic local protocol probe.']
   env={**os.environ,'CODEX_HOME':str(home),'PROBE_MODE':mode,'PROBE_ROOT':str(case),'BASTRA_DAEMON_URL':'http://127.0.0.1:1','BASTRA_HTTP_URL':'http://127.0.0.1:1'}
   for key in ['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY']:env.pop(key,None)
   out=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=60)
   (case/'cli.stdout').write_text(out.stdout);(case/'cli.stderr').write_text(out.stderr)
   payloads=[json.loads(x) for x in (case/'payloads.jsonl').read_text().splitlines()] if (case/'payloads.jsonl').exists() else []
   results.append({'tool':tool,'mode':mode,'exit':out.returncode,'responses':server.count,'requests':server.requests,'payloads':payloads})
   print(json.dumps({'tool':tool,'mode':mode,'exit':out.returncode,'responses':server.count,'hooks':len(payloads)}),flush=True)
 report={'version':VERSION,'artifact_dir':str(ROOT),'results':results}
 (ROOT/'result.json').write_text(json.dumps(report,indent=2))
 for c in results:
  assert c['exit']==0 and len(c['payloads'])==(2 if c['mode']=='bastra' else 1),c
  native=c['payloads'][0]['native'];assert native['tool_name']==('Bash' if c['tool']=='exec_command' else 'view_image')
  q=c['requests'][1];outputs=json.dumps(q['tool_outputs'])
  if c['mode'] in ['deny','bastra']:
   assert c['payloads'][0]['returned']['hookSpecificOutput']['permissionDecision']=='deny'
   assert 'blocked by PreToolUse hook' in outputs and 'Output:\\nCODEX_GATE_EXECUTED' not in outputs and q['image_count']==0,c
  if c['mode']=='allow' or c['mode']=='bastra':
   q=c['requests'][-1];outputs=json.dumps(q['tool_outputs'])
   if c['tool']=='exec_command':assert 'Output:\\nCODEX_GATE_EXECUTED' in outputs,c
   else:assert q['image_count']>0,c
  if c['mode']=='bastra':assert c['payloads'][1]['returned']=={} and c['responses']==3,c
 print('PASS all native deny/control/Bastra-retry assertions')
 print('ARTIFACTS',ROOT)
finally:server.shutdown()
