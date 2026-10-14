/** #1207: seeded recovery contention, 20 × 6 × 30 writes (POSIX).
 * node --import tsx --import ./scripts/test-env.mjs tools/probes/path-lock-recovery-load.mts
 * Each worker attempts to plant a dead guard before 10% of its writes using
 * wx (never overwriting a real guard). An independent wx sentinel detects
 * overlapping callbacks. Each round has a 15 s watchdog.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = await mkdtemp(join(tmpdir(), "bastra-recovery-load-"));
const worker = join(dir, "worker.mts");
const rounds = 20, processes = 6, writes = 30;
await writeFile(worker, `
  import { withPathLock } from ${JSON.stringify(new URL("../../packages/daemon/src/path-lock.ts", import.meta.url).href)};
  import { readFile, writeFile, open, unlink } from 'node:fs/promises';
  import { hostname } from 'node:os';
  import { setTimeout as delay } from 'node:timers/promises';
  const [state, id, count, seed] = process.argv.slice(2);
  let rng = Number(seed), planted = 0;
  function random() { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; }
  process.send('ready');
  await new Promise(resolve => process.once('message', resolve));
  for (let i = 0; i < Number(count); i++) {
    if (random() < 0.1) {
      let fd;
      try { fd = await open(state+'.lock.mutation','wx',0o600); }
      catch (err) { if(err.code !== 'EEXIST') throw err; }
      if (fd) {
        try { await fd.writeFile(JSON.stringify({pid:2147483647,host:hostname(),ts:Date.now(),token:'dead-'+id+'-'+i})); planted++; }
        finally { await fd.close(); }
      }
    }
    await withPathLock(state, async () => {
      let active;
      try { active = await open(state+'.active','wx',0o600); }
      catch(err) { if(err.code==='EEXIST') process.send({overlap:1}); throw err; }
      try {
        const rows = JSON.parse(await readFile(state, 'utf8'));
        await delay(1);
        rows.push(id+':'+i);
        await writeFile(state,JSON.stringify(rows));
      } finally { await active.close(); await unlink(state+'.active'); }
    }, {crossProcess:true,requireLock:true});
  }
  process.send({planted});
`);
let planted = 0, simultaneousHolders = 0, hangingRounds = 0, failedRounds = 0, lostWrites = 0, leftovers = 0;
try {
  for (let round = 0; round < rounds; round++) {
    const state = join(dir, `round-${round}.json`);
    await writeFile(state, "[]");
    const children = Array.from({ length: processes }, (_, id) => {
      const child = spawn(process.execPath, ["--import", "tsx", worker, state, String(id), String(writes), String(1207 + round * processes + id)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";
      child.stderr!.on("data", c => { stderr += c; });
      child.on("message", (msg: any) => { if (msg?.planted) planted += msg.planted; if(msg?.overlap) simultaneousHolders += msg.overlap; });
      const ready = new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve()); child.once("error", reject);
        child.once("exit", () => reject(new Error(`startup: ${stderr}`)));
      });
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve() : reject(new Error(`round ${round}, worker ${id}: ${stderr}`)));
      });
      void done.catch(() => {}); void ready.catch(() => {});
      return { child, ready, done };
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await Promise.all(children.map(c => c.ready));
          for (const c of children) c.child.send("start");
          await Promise.all(children.map(c => c.done));
        })(),
        new Promise<never>((_, reject) => { watchdog = setTimeout(() => { hangingRounds++; reject(new Error(`round ${round} timed out`)); }, 15_000); }),
      ]);
    } catch (err) { failedRounds++; console.error(String(err)); }
    finally {
      clearTimeout(watchdog);
      for (const c of children) if (c.child.exitCode === null) c.child.kill("SIGKILL");
      await Promise.allSettled(children.map(c => c.done));
    }
    const rows = JSON.parse(await readFile(state, "utf8")) as string[];
    lostWrites += processes * writes - new Set(rows).size;
  }
  leftovers = (await readdir(dir)).filter(name => name !== "worker.mts" && !/^round-\d+\.json$/.test(name)).length;
  console.log(JSON.stringify({ rounds, processes, writesPerProcess: writes, writes: rounds * processes * writes, plantProbability: 0.1, planted, hangingRounds, simultaneousHolders, failedRounds, lostWrites, leftovers }));
  if (hangingRounds || simultaneousHolders || failedRounds || lostWrites || leftovers) process.exitCode = 1;
} finally { await rm(dir, { recursive: true, force: true }); }
