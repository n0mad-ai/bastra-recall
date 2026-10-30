#!/usr/bin/env python3
"""Exercise the real Codex CLI Stop protocol against a local scripted SSE server.
No model/API key/network provider, no copied credentials or modified user config.
Only event metadata and synthetic output are retained in the result.
"""
import http.server, json, os, pathlib, shlex, shutil, subprocess, tempfile, threading, tomllib

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length',0))) # never retain context
        self.server.responses += 1
        n=self.server.responses
        text='PROBE_FIRST' if n==1 else 'PROBE_CONTINUED'
        item={'id':f'msg_{n}','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':text,'annotations':[]}]}
        response={'id':f'resp_{n}','object':'response','created_at':1,'status':'completed','output':[item], 'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
        events=[('response.created',{'response':{**response,'status':'in_progress','output':[]}}),
          ('response.output_item.added',{'output_index':0,'item':{**item,'status':'in_progress','content':[]}}),
          ('response.content_part.added',{'item_id':item['id'],'output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}}),
          ('response.output_text.delta',{'item_id':item['id'],'output_index':0,'content_index':0,'delta':text}),
          ('response.output_text.done',{'item_id':item['id'],'output_index':0,'content_index':0,'text':text}),
          ('response.content_part.done',{'item_id':item['id'],'output_index':0,'content_index':0,'part':item['content'][0]}),
          ('response.output_item.done',{'output_index':0,'item':item}),('response.completed',{'response':response})]
        body=''.join('event: '+kind+'\ndata: '+json.dumps({'type':kind,**data})+'\n\n' for kind,data in events).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

version=subprocess.check_output(['codex','--version'],text=True).strip()
if version != 'codex-cli 0.162.1': raise SystemExit('This evidence probe is pinned to codex-cli 0.162.1; found '+version)
root=pathlib.Path(tempfile.mkdtemp(prefix='bastra-codex-stop-probe-'))
(root/'.codex').mkdir()
(root/'.codex'/'config.toml').write_text('')
subprocess.run(['git','init','--quiet',str(root)],check=True)
hook=root/'hook.py'
hook.write_text('''import json,pathlib,sys
root=pathlib.Path(__file__).parent
p=json.load(sys.stdin)
with (root/'events.jsonl').open('a') as f: f.write(json.dumps({k:p.get(k) for k in ['hook_event_name','session_id','turn_id','agent_id','stop_hook_active']})+'\\n')
if p.get('hook_event_name')!='Stop': print('{}')
elif (root/'halt').exists(): print(json.dumps({'continue':False,'decision':'block','reason':'DO_NOT_CONTINUE'}))
elif not (root/'blocked').exists():
 (root/'blocked').touch()
 print(json.dumps({'decision':'block','reason':'Reply with PROBE_CONTINUED and then finish.'}))
else: print('{}')
''')
repo=pathlib.Path(__file__).resolve().parents[3]
source_hook=root/'bastra-hook.mts'
source_hook.write_text(r"""
import { appendFile } from 'node:fs/promises';
const repo = __REPO__;
const root = process.argv[2];
process.env.BASTRA_HOOK_STATE_DIR = root + '/state';
process.env.BASTRA_LOG_PATH = root + '/logs';
process.env.BASTRA_TELEMETRY = 'on';
process.env.BASTRA_PENDING_SUGGESTIONS_PATH = root + '/pending.json';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const p = { ...JSON.parse(raw), bastra_client:'codex', bastra_codex_version:'0.162.1', transcript_path:undefined,
 transcript:[{role:'user',content:'¿Puedes enviar el contrato?'}] };
await appendFile(root + '/events.jsonl', JSON.stringify(Object.fromEntries(['hook_event_name','session_id','turn_id','agent_id','stop_hook_active'].map(k=>[k,p[k]??null])))+'\n');
const c = {entries:[{id:'invented-correspondence',title:'Invented correspondence',group:'explicit',revision:null,updated:null,
 stale_status:'unknown',body:'',rulebook:'on-demand',applies_when:'When a message from another person is pasted.'}],omitted:0};
let out = '{}';
if(p.hook_event_name === 'UserPromptSubmit') {
 const { beginRulebookRound } = await import(repo + '/packages/daemon/src/rulebook-check.ts');
 const text = await beginRulebookRound(p,c);
 out=JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:text}});
} else {
 const {runStopLane} = await import(repo + '/packages/daemon/src/stop-lane.ts');
 out=await runStopLane(p,'http://127.0.0.1:1',{kernel:async()=>c});
}
process.stdout.write(out);
""".replace('__REPO__',json.dumps(str(repo))))
source_command=shlex.join([shutil.which('node'),'--import',str(repo/'node_modules/tsx/dist/loader.mjs'),'--import',str(repo/'scripts/test-env.mjs'),str(source_hook),str(root)])
command=f'/usr/bin/python3 {hook}'
(root/'.codex'/'hooks.json').write_text(json.dumps({'hooks':{name:[{'hooks':[{'type':'command','command':command,'timeout':5}]}] for name in ['Stop','UserPromptSubmit']}}))
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.responses=0
threading.Thread(target=server.serve_forever,daemon=True).start()
# Suppress configured MCP clients without inspecting or exposing credentials.
probe_config_root=pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home()/'.codex')
if not probe_config_root.is_absolute(): raise SystemExit('The probe requires an absolute Codex config root.')
try: config=tomllib.loads((probe_config_root/'config.toml').read_text())
except FileNotFoundError: config={}
overrides=['-c',f'projects.{json.dumps(str(root))}.trust_level="trusted"','-c','features.apps=false']
# Never bypass trust while unrelated installed hooks could run. A clean Codex
# account/config is required; no user configuration is moved or rewritten.
global_hooks=probe_config_root/'hooks.json'
try: configured_hooks=json.loads(global_hooks.read_text()).get('hooks',{})
except FileNotFoundError: configured_hooks={}
inline_hooks=config.get('hooks',{})
if any(configured_hooks.values()) or any(v for k,v in inline_hooks.items() if k!='state' and isinstance(v,list)):
    raise SystemExit('Refusing to run with installed hooks. Use a clean Codex account/config with no unrelated or managed hooks; do not remove your active hooks for this test.')
for name in config.get('plugins',{}): overrides.extend(['-c',f'plugins.{json.dumps(name)}.enabled=false'])
for name in config.get('mcp_servers',{}): overrides.extend(['-c',f'mcp_servers.{name}.enabled=false'])
for event in ['Stop','UserPromptSubmit']:
    overrides.extend(['-c',f'hooks.{event}=[{{hooks=[{{type="command",command={json.dumps(command)},timeout=5}}]}}]'])
(root/'.codex'/'hooks.json').unlink()
args=['codex','exec','--cd',str(root),'--skip-git-repo-check','--sandbox','read-only','--dangerously-bypass-hook-trust','--ephemeral',
 '-c','model_provider="stop_probe"','-c','model="stop-probe-fixture"',
 '-c','model_providers.stop_probe.name="Local deterministic protocol fixture"',
 '-c',f'model_providers.stop_probe.base_url="http://127.0.0.1:{server.server_port}"',
 '-c','model_providers.stop_probe.wire_api="responses"','-c','model_providers.stop_probe.requires_openai_auth=false',*overrides]
results=[]
try:
    for case in ['block_once','continue_false','bastra_rulebook']:
        halt=case=='continue_false'
        server.responses=0
        (root/'blocked').unlink(missing_ok=True)
        (root/'halt').unlink(missing_ok=True)
        if halt:(root/'halt').touch()
        invocation=[a.replace(command,source_command) for a in args] if case=='bastra_rulebook' else args
        prompt='¿Puedes enviar el contrato?' if case=='bastra_rulebook' else 'Reply with PROBE_FIRST, without using any tools.'
        out=subprocess.run([*invocation,prompt],env={**os.environ,'BASTRA_DAEMON_URL':'http://127.0.0.1:1','BASTRA_HTTP_URL':'http://127.0.0.1:1','BASTRA_LOG_PATH':str(root/'transport-logs'),'BASTRA_HOOK_STATE_DIR':str(root/'transport-state')},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=90)
        events=[json.loads(s) for s in (root/'events.jsonl').read_text().splitlines()] if (root/'events.jsonl').exists() else []
        results.append({'case':case,'exit':out.returncode,'responses':server.responses,'events':events,'continued': 'PROBE_CONTINUED' in out.stdout,'installed_startup_hooks_ran':'hook: SessionStart' in out.stderr,
          'diagnostic':[line for line in out.stderr.splitlines() if any(key in line.lower() for key in ['hook:', 'untrusted', 'project config', 'error:', 'warning:', 'disabled'])][-15:] if not events or out.returncode else []})
        (root/'events.jsonl').unlink(missing_ok=True)
    report={'version':version,'results':results,'artifact_dir':str(root)}
    print(json.dumps(report,indent=2))
    assert not any(r['installed_startup_hooks_ran'] for r in results), 'Installed startup hooks must be disabled during the probe'
    assert results[0]['exit']==0 and results[0]['responses']==2 and results[0]['continued'], 'Stop block continuation not established'
    assert results[1]['exit']==0 and results[1]['responses']==1, 'continue:false precedence not established'
    assert results[2]['exit']==0 and results[2]['responses']==2 and results[2]['continued'], 'Real Bastra rulebook Stop continuation not established'
finally: server.shutdown()
