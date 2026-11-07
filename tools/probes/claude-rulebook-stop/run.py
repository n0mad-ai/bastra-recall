#!/usr/bin/env python3
"""Isolated Claude Stop protocol fixture; no real model/account or installed hooks.
Run: nice -n 15 python3 tools/probes/claude-rulebook-stop/run.py
Requires a locally installed Claude Code CLI. Raw artifacts stay in a temp directory.
"""
import json, os, pathlib, subprocess, tempfile, threading, http.server
root=pathlib.Path(tempfile.mkdtemp(prefix="claude-stop-1370-"))
requests=[]
version=subprocess.check_output(['claude','--version'],text=True).strip()
print('VERSION',version)
class H(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers.get("content-length","0"))))
  if not self.path.endswith("/messages") and "/messages?" not in self.path:
   d=json.dumps({"input_tokens":100}).encode(); self.send_response(200);self.send_header("content-type","application/json");self.end_headers();self.wfile.write(d);return
  requests.append(b)
  case=(root/"case").read_text(); n=sum(1 for r in requests if r.get("_case")==case)+1; b["_case"]=case
  content=[{"type":"text","text":"PROBE_FIRST" if n==1 else "PROBE_CHECKED"}]
  stop="end_turn"
  if n==2:
   content=[{"type":"tool_use","id":"call_check","name":"mcp__probe__rulebook_check","input":{"applicable":[]}}];stop="tool_use"
  msg={"id":"msg_probe","type":"message","role":"assistant","model":"probe-fixture","content":content,"stop_reason":stop,"stop_sequence":None,"usage":{"input_tokens":10,"output_tokens":5}}
  self.send_response(200)
  if not b.get("stream"):
   self.send_header("content-type","application/json");self.end_headers();self.wfile.write(json.dumps(msg).encode());return
  self.send_header("content-type","text/event-stream");self.end_headers()
  def emit(event,data): self.wfile.write(("event: "+event+"\ndata: "+json.dumps(data)+"\n\n").encode());self.wfile.flush()
  emit("message_start",{"type":"message_start","message":{**msg,"content":[],"stop_reason":None}})
  for i,c in enumerate(content):
   initial={**c,"text":""} if c["type"]=="text" else {**c,"input":{}}
   emit("content_block_start",{"type":"content_block_start","index":i,"content_block":initial})
   delta={"type":"text_delta","text":c["text"]} if c["type"]=="text" else {"type":"input_json_delta","partial_json":json.dumps(c["input"])}
   emit("content_block_delta",{"type":"content_block_delta","index":i,"delta":delta});emit("content_block_stop",{"type":"content_block_stop","index":i})
  emit("message_delta",{"type":"message_delta","delta":{"stop_reason":stop,"stop_sequence":None},"usage":{"output_tokens":5}});emit("message_stop",{"type":"message_stop"})
server=http.server.ThreadingHTTPServer(("127.0.0.1",0),H);threading.Thread(target=server.serve_forever,daemon=True).start()
hook=root/"hook.py"
hook.write_text("import json,sys,pathlib\np=json.load(sys.stdin);r=pathlib.Path(__file__).parent\nwith (r/'events.jsonl').open('a') as f:f.write(json.dumps({'case':(r/'case').read_text(),'active':p.get('stop_hook_active')})+'\\n')\nif not p.get('stop_hook_active'):\n c=(r/'case').read_text(); text='Call mcp__probe__rulebook_check before finishing.'\n print(json.dumps({'decision':'block','reason':text} if c=='block' else {'hookSpecificOutput':{'hookEventName':'Stop','additionalContext':text}}))\n")
mcp=root/"mcp.py"
mcp.write_text("import json,sys,pathlib\nr=pathlib.Path(__file__).parent\nfor line in sys.stdin:\n p=json.loads(line);m=p.get('method');i=p.get('id')\n if i is None:continue\n result={}\n if m=='initialize':result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'probe','version':'1'}}\n elif m=='tools/list':result={'tools':[{'name':'rulebook_check','description':'Record check','inputSchema':{'type':'object','properties':{'applicable':{'type':'array','items':{'type':'string'}}},'required':['applicable']}}]}\n elif m=='tools/call':\n  with (r/'checks.jsonl').open('a') as f:f.write(json.dumps({'case':(r/'case').read_text(),'params':p.get('params')})+'\\n')\n  result={'content':[{'type':'text','text':'ok'}]}\n print(json.dumps({'jsonrpc':'2.0','id':i,'result':result}),flush=True)\n")
settings=root/"settings.json";settings.write_text(json.dumps({'hooks':{'Stop':[{'hooks':[{'type':'command','command':'python3 '+str(hook),'timeout':5}]}]}}))
env={k:v for k,v in os.environ.items() if k in ['PATH','TMPDIR','LANG','LC_ALL','SYSTEMROOT']}
env.update(CLAUDE_CONFIG_DIR=str(root/'config'),ANTHROPIC_BASE_URL='http://127.0.0.1:'+str(server.server_port),ANTHROPIC_API_KEY='probe-not-a-secret',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
for case in ['block','context']:
 (root/'case').write_text(case)
 args=['claude','-p','Say PROBE_FIRST.','--setting-sources','','--settings',str(settings),'--strict-mcp-config','--mcp-config',json.dumps({'mcpServers':{'probe':{'command':'python3','args':[str(mcp)]}}}),'--tools','','--allowedTools','mcp__probe__rulebook_check','--model','probe-fixture','--system-prompt','You are a deterministic protocol fixture.','--no-session-persistence','--output-format','stream-json','--verbose']
 try:
  run=subprocess.run(args,cwd=root,env=env,text=True,capture_output=True,timeout=45)
  (root/(case+'.stdout')).write_text(run.stdout);(root/(case+'.stderr')).write_text(run.stderr)
  print(case,'return',run.returncode,'requests',len([r for r in requests if r.get('_case')==case]))
 except subprocess.TimeoutExpired as e:
  print(case,'timeout');(root/(case+'.stdout')).write_text(e.stdout.decode() if isinstance(e.stdout,bytes) else e.stdout or '')
(root/'requests.json').write_text(json.dumps(requests,indent=2)); print('ARTIFACTS',root)
server.shutdown()
events=[json.loads(line) for line in (root/'events.jsonl').read_text().splitlines()]
checks=[json.loads(line) for line in (root/'checks.jsonl').read_text().splitlines()]
summary={'version':version,'cases':{},'limits':'Deterministic local provider, not semantic-model compliance or interactive TUI certification.'}
for case in ['block','context']:
 count=len([r for r in requests if r.get('_case')==case])
 flags=[e['active'] for e in events if e['case']==case]
 calls=[c for c in checks if c['case']==case]
 notifications=[json.loads(line) for line in (root/(case+'.stdout')).read_text().splitlines() if line.startswith('{')]
 errors=[n for n in notifications if n.get('key')=='stop-hook-error']
 assert count==3,(case,count)
 assert flags==[False,True],(case,flags)
 assert len(calls)==1 and calls[0]['params']['name']=='rulebook_check',(case,calls)
 assert bool(errors)==(case=='block'),(case,errors)
 summary['cases'][case]={'provider_requests':count,'stop_hook_active':flags,'rulebook_check_calls':len(calls),'error_notifications':len(errors)}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
