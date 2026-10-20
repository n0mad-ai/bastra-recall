#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
const data=JSON.parse(await readFile(process.argv[2]||new URL('./results.json',import.meta.url),'utf8'));
const rows=data.rows.filter(r=>!r.skipped);
const q=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
const pair=(values)=>values.length?`${q(values,0.5).toFixed(1)} / ${q(values,0.95).toFixed(1)}`:'n/a';
console.log(`# Mindspace performance baseline (#324)\n\nSource: \`${data.commit}\`; ${data.timestamp}. ${data.cpu}, ${data.logicalCpus} logical CPUs, ${data.platform} ${data.release}, Chrome ${data.browser}. Dark theme, 1280×800, DPR 1; seeded synthetic graph (ten clusters, 2N edges); real production RAF/physics/interactions/renderer/minimap and orbit universe tick/decor. ${data.repeats} repetitions, ${data.durationMs/1000} s per phase.\n`);
console.log('Frame/callback percentiles below pool the raw samples from all repetitions. Task and CPU columns are arithmetic means of the measurement windows; CPU ranges are their min–max. 100% Chromium CPU means one logical core.\n');
console.log('| View | Nodes | State | RAF p50 / p95 ms | Callback p50 / p95 ms | Main-thread task % | Chromium CPU % (range) | Draws/s |');
console.log('|---|---:|---|---:|---:|---:|---:|---:|');
for(const view of ['clouds','orbit'])for(const nodes of [1000,5000,10000])for(const mode of ['busy','idle','synthetic-hidden','native-background']){
 const group=rows.filter(r=>r.view===view&&r.nodes===nodes&&r.mode===mode);if(!group.length)continue;
 const cpu=group.map(r=>r.browserProcessCPUPercent);
 console.log(`| ${view} | ${nodes.toLocaleString('en-US')} | ${mode} | ${pair(group.flatMap(r=>r.raw.frames))} | ${pair(group.flatMap(r=>r.raw.costs))} | ${mean(group.map(r=>r.mainThreadTaskPercent)).toFixed(1)} | ${mean(cpu).toFixed(1)} (${Math.min(...cpu).toFixed(1)}–${Math.max(...cpu).toFixed(1)}) | ${mean(group.map(r=>r.draws/(r.elapsedMs/1000))).toFixed(1)} |`);
}
const loads=[data.startLoad[0],...rows.map(r=>r.load[0]),...(data.endLoad?[data.endLoad[0]]:[])];
console.log(`\nLoad-1 ranged ${Math.min(...loads).toFixed(2)}–${Math.max(...loads).toFixed(2)}. Load is context, not CPU utilization; unrelated host activity can affect comparisons. Native-background attempts: ${data.rows.filter(r=>r.mode==='native-background'&&r.skipped).length} skips because headless Chrome did not report a hidden document after another tab was activated. Synthetic hidden sets document.hidden/visibilityState and dispatches visibilitychange; native RAF stays active. It tests application gating, **not native background-tab CPU/throttling**.\n`);
console.log('CPU is cumulative OS CPU time across this isolated Chromium instance, including its renderer/GPU/browser processes, via CDP SystemInfo; Node is excluded. Main-thread task % is CDP TaskDuration occupancy, not OS CPU. Callback timing excludes asynchronous GPU/compositor completion. See README.md for fixture, methodology and full limitations. No performance marks/observers and no product code changes.');
