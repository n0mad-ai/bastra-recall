#!/usr/bin/env node
// External existing playwright-core can be selected without installing dependencies.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg, platform, release } from 'node:os';
import { execFileSync } from 'node:child_process';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const durationMs=Number(process.env.DURATION_MS||3000);
const repeats=Number(process.env.REPEATS||3);
if(!Number.isFinite(durationMs)||durationMs<=0)throw Error('DURATION_MS must be positive and finite');
if(!Number.isInteger(repeats)||repeats<1)throw Error('REPEATS must be a positive integer');
const output=resolve(process.env.OUTPUT||'scripts/mindspace-perf/results.json');
const quantile=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.ceil(p*a.length)-1]:null;
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const path=resolve(root,'.'+(pathname==='/'?'/scripts/mindspace-perf/page.html':pathname));
  if(!path.startsWith(root+sep))throw Error('outside root');
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css'})[extname(path)]||'text/plain');
  res.end(await readFile(path));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
const report={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),timestamp:new Date().toISOString(),platform:platform(),release:release(),cpu:cpus()[0].model,logicalCpus:cpus().length,startLoad:loadavg(),durationMs,repeats,viewport:{width:1280,height:800,deviceScaleFactor:1},rows:[]};
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',ignoreDefaultArgs:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 report.browser=browser.version();
 const browserCDP=await browser.newBrowserCDPSession();
 const cpuSnapshot=async()=> (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo;
 const cpuDelta=(before,after)=>{
  const old=new Map(before.map(p=>[p.id,p.cpuTime]));
  const byType={};
  for(const p of after){if(!old.has(p.id))continue;byType[p.type]=(byType[p.type]||0)+Math.max(0,p.cpuTime-old.get(p.id));}
  return byType;
 };
 for(let repeat=1;repeat<=repeats;repeat++)for(const nodes of [1000,5000,10000])for(const view of ['clouds','orbit']){
  const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1});
  const page=await context.newPage();
  page.on('pageerror',error=>{throw error;});
  await page.goto(`http://127.0.0.1:${server.address().port}/?nodes=${nodes}&view=${view}`);
  await page.waitForFunction(n=>window.bench?.warmup>=n,view==='orbit'?90:30,{timeout:120000});
  const pageCDP=await context.newCDPSession(page);
  await pageCDP.send('Performance.enable');
  const taskDuration=async()=> (await pageCDP.send('Performance.getMetrics')).metrics.find(m=>m.name==='TaskDuration').value;
  for(const mode of (view==='clouds'?['busy','idle','synthetic-hidden','native-background']:['idle','synthetic-hidden','native-background'])){
   if(mode==='idle'){
    await page.evaluate(()=>bench.settle());
    const warmup=await page.evaluate(()=>bench.warmup);
    await page.waitForFunction(n=>bench.warmup>=n+30,warmup,{timeout:120000});
   }
   if(mode==='synthetic-hidden')await page.evaluate(()=>bench.syntheticHidden());
   if(mode==='native-background'){
    await page.evaluate(()=>{delete document.hidden;delete document.visibilityState;});
    const cover=await context.newPage();await cover.goto('about:blank');await cover.bringToFront();
    // Verify native visibility; do not label a still-visible headless page as hidden.
    const hidden=await page.evaluate(()=>document.hidden);
    if(!hidden){report.rows.push({repeat,nodes,view,mode,skipped:'Headless browser did not expose native hidden state'});await cover.close();continue;}
   }
   await page.evaluate(()=>bench.begin());
   const beforeCPU=await cpuSnapshot(),beforeTask=await taskDuration(),start=performance.now();
   await new Promise(r=>setTimeout(r,durationMs));
   const afterTask=await taskDuration(),afterCPU=await cpuSnapshot(),elapsedMs=performance.now()-start;
   const samples=await page.evaluate(()=>bench.end());
   const cpuSeconds=cpuDelta(beforeCPU,afterCPU);
   const row={repeat,nodes,view,edges:nodes*2,mode,elapsedMs,hidden:samples.hidden,visibilityState:samples.visibilityState,draws:samples.draws,frameSamples:samples.frames.length,frameP50:quantile(samples.frames,0.5),frameP95:quantile(samples.frames,0.95),callbackP50:quantile(samples.costs,0.5),callbackP95:quantile(samples.costs,0.95),mainThreadTaskPercent:100*(afterTask-beforeTask)/(elapsedMs/1000),browserProcessCPUPercent:100*Object.values(cpuSeconds).reduce((a,b)=>a+b,0)/(elapsedMs/1000),cpuSecondsByType:cpuSeconds,load:loadavg(),raw:samples};
   report.rows.push(row);
   await writeFile(output,JSON.stringify(report,null,2)+'\n');
   console.log(JSON.stringify({...row,raw:undefined}));
  }
  await context.close();
 }
 report.endLoad=loadavg();
 await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(`Saved ${output}`);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
