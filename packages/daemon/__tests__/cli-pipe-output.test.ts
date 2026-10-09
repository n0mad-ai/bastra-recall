import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { captureDrafts, draftFingerprint, draftId, type Draft } from "../src/draft-store.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = resolve(root, "packages/daemon/dist/cli.js");
const fatal = fileURLToPath(new URL("./fixtures/cli-fatal-output.mjs", import.meta.url));

async function run(args: string[], slow: "stdout" | "stderr" | null = null, imports: string[] = []) {
  const child = spawn(process.execPath, [...imports.flatMap(path => ["--import", path]), cli, ...args], {
    env: { ...process.env, BASTRA_UPDATE_CHECK: "off" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const out: Buffer[] = [], err: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  for (const [name, chunks] of [["stdout", out], ["stderr", err]] as const) {
    const stream = child[name];
    if (name === slow) {
      stream.pause();
      timer = setTimeout(() => stream.resume(), 100);
    }
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (name === slow) {
        stream.pause();
        timer = setTimeout(() => stream.resume(), 2);
      }
    });
  }
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, "finite CLI commands must exit without killing live handles");
    return { code, out: Buffer.concat(out), err: Buffer.concat(err) };
  } finally { clearTimeout(timeout); clearTimeout(timer); child.kill(); }
}

test("real drafts --json emits every byte and Unicode character to a slow pipe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-pipe-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  const now = Date.now();
  try {
    const inputs: Draft[] = Array.from({ length: 300 }, (_, i) => {
      const quote = `Deployment ${i} keeps staging separate. ` + "ä🙂 deployment ".repeat(25);
      const fp = draftFingerprint(quote);
      return { id: draftId(`fixture-${i}`, 0, fp), fp, quote, kind: "typed",
        evidence: [{ session_id: `fixture-${i}`, turn: 0, ts: now }],
        situation: { before: [], after: [], reads: [], lits: [] },
        created: now, last_touched: now, surfaced: [], state: "open" };
    });
    await captureDrafts(inputs, now);
    const baseline = await run(["drafts", "list", "--json"]);
    assert.equal(baseline.code, 0);
    assert.ok(baseline.out.length > 65536, "fixture must exceed the macOS pipe boundary");
    assert.equal(JSON.parse(baseline.out.toString("utf8")).length, 300);
    for (let attempt = 0; attempt < 3; attempt++) {
      const piped = await run(["drafts", "list", "--json"], "stdout");
      assert.equal(piped.code, 0);
      assert.deepEqual(piped.out, baseline.out);
      assert.ok(piped.out.toString("utf8").includes("ä🙂"));
      assert.equal(piped.err.toString("utf8"), "");
    }
  } finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH; else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("usage errors keep exit code 2; fatal stderr drains fully and the CLI releases handles", async () => {
  const usage = await run(["not-a-command"]);
  assert.equal(usage.code, 2);
  assert.match(usage.err.toString("utf8"), /unknown command/);
  const baseline = await run(["help"], null, [fatal]);
  assert.equal(baseline.code, 1);
  assert.ok(baseline.err.length > 65536);
  const slow = await run(["help"], "stderr", [fatal]);
  assert.equal(slow.code, 1);
  assert.deepEqual(slow.err, baseline.err);
  assert.match(slow.err.toString("utf8"), /FATAL-END/);
});

test("real logs follow remains alive until SIGINT/SIGTERM, then drains and exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-follow-"));
  try {
    const file = join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    await writeFile(file, JSON.stringify({ ts: new Date().toISOString(), kind: "fixture_event", status: "ready" }) + "\n");
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const child = spawn(process.execPath, [cli, "logs", "--source", "hook", "--follow"], {
        env: { ...process.env, BASTRA_UPDATE_CHECK: "off", BASTRA_LOG_PATH: dir }, stdio: ["ignore", "pipe", "pipe"],
      });
      const closed = once(child, "close");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      let output = "", error = "";
      child.stderr.on("data", chunk => { error += chunk; });
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.on("data", chunk => {
            output += chunk;
            if (output.includes("following") && output.includes("fixture_event")) resolve();
          });
          child.once("error", reject);
          child.once("close", () => reject(new Error("follow exited before being stopped")));
        });
        // A finite command would have exited here; follow must keep its tail handles alive.
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(child.exitCode, null);
        assert.ok(child.kill(signal));
        const [code, terminated] = await closed;
        assert.equal(terminated, null, "signal should close resources through the handler");
        assert.equal(code, 0);
        assert.match(output, /status=ready/);
        assert.equal(error, "");
      } finally { clearTimeout(timeout); child.kill(); }
    }
    const finite = await run(["logs", "--source", "hook"]);
    assert.equal(finite.code, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('early-closing stdout pipe exits quietly with success',async()=>{
 const child=spawn(process.execPath,[cli,'help'],{env:{...process.env,BASTRA_UPDATE_CHECK:'off'},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',b=>err+=b);const done=once(child,'close');child.stdout.destroy();const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);
 try{const[code,signal]=await done;assert.equal(signal,null);assert.equal(code,0);assert.equal(err,'');}finally{clearTimeout(timeout);child.kill();}
});

test("a failure keeps its exit code when the reader of stdout and stderr is already gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-gone-"));
  const gone = async (args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, BASTRA_UPDATE_CHECK: "off", BASTRA_DRAFTS_PATH: join(dir, "drafts.json") }, stdio: ["ignore", "pipe", "pipe"],
    });
    const done = once(child, "close");
    child.stdout.destroy();
    child.stderr.destroy();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [code, signal] = await done;
      assert.equal(signal, null);
      return code;
    } finally { clearTimeout(timeout); child.kill(); }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(await gone(["drafts", "undo", "d-000000000000"]), 1, "failed command");
      assert.equal(await gone(["not-a-command"]), 2, "unknown command");
      assert.equal(await gone(["drafts", "list", "--no-such-flag"]), 2, "usage error");
      assert.equal(await gone(["help"]), 0, "successful command");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
