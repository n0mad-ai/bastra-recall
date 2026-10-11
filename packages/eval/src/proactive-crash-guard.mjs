/** Measurement-only deterministic SIGKILL injection in the actual child daemon. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, relative } from 'node:path';
const rename=fs.renameSync;
fs.renameSync=function(from,to){
  const controlPath=process.env.BASTRA_MEASUREMENT_CRASH_PATH;
  let control;try{if(controlPath)control=JSON.parse(fs.readFileSync(controlPath,'utf8'));}catch{}
  if(!control?.armed)return rename(from,to);
  const root=fs.realpathSync(process.env.BASTRA_MEASUREMENT_ROOT);
  if(relative(root,resolve(to)).startsWith('..'))throw new Error('crash fixture target escaped temp root');
  const crash=()=>{fs.writeFileSync(controlPath,JSON.stringify({...control,armed:false}),{mode:0o600});process.kill(process.pid,'SIGKILL');};
  if(to===control.target){
    if(control.stage==='before'||control.stage==='recovery')crash();
    const value=rename(from,to);
    fs.appendFileSync(controlPath+'.writes',JSON.stringify({target:to,stage:control.stage})+'\n',{mode:0o600});
    if(control.stage==='after')crash();return value;
  }
  if(control.stage==='recovery-commit'&&to===control.store){
    const pending=JSON.parse(fs.readFileSync(from,'utf8'));
    if(pending.receipts.some(r=>r.intent_id===control.intent_id))crash();
  }
  return rename(from,to);
};
syncBuiltinESMExports();
