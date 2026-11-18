/**
 * #1650 (rest of #1538) — the size note's I/O stays inside its deadline.
 *
 * Settings: a settings database that never answers (a FIFO in its place, the
 * stand-in for a stalled disk) must not stall the process; the note is
 * skipped and the caller gets its answer on time.
 *
 * File: only regular files are opened, and at most MAX_BYTES real bytes are
 * read — not the whole input first, and not decoded characters instead of
 * bytes. Oversized files and devices behind a symlink leave no read running
 * after the answer.
 *
 * The blocking cases run in child processes: on the old code they stall the
 * whole event loop or keep reading after the answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSizeNote } from "../src/file-size-check.js";

const SIZE_CHECK = new URL("../src/file-size-check.ts", import.meta.url).href;
const posixOnly = process.platform === "win32" ? "named pipes and /dev/zero are POSIX-only" : false;

/** Runs `code` as an ES module file in a child; resolves with its first
 * stdout line, or "timeout" when nothing arrives in `ms`. `onLine` runs
 * before the child is awaited, so a test can release what the child might
 * still be blocked on. A file, not `-e`: like the daemon, the child must be
 * able to start its settings worker (see settings-record-thread.ts). */
async function childLine(
  dir: string,
  code: string,
  ms: number,
  onLine: () => Promise<void> = async () => {}
): Promise<string> {
  const script = join(dir, "child.mts");
  await writeFile(script, code);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    let settled = false;
    const finish = async (line: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await onLine();
      if (line === "timeout") child.kill("SIGKILL");
      resolve(line);
    };
    const timer = setTimeout(() => void finish("timeout"), ms);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const nl = out.indexOf("\n");
      if (nl >= 0) void finish(out.slice(0, nl));
    });
  });
}

test("#1650: a settings database that never answers does not stall the note past its deadline", async (t) => {
  if (posixOnly) return t.skip(posixOnly);
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-settings-fifo-"));
  const fifo = join(dir, "recall.db");
  execFileSync("mkfifo", [fifo]);
  const file = join(dir, "big.ts");
  await writeFile(file, "export const x = 1;\n".repeat(900));
  const release = async () => {
    await (await open(fifo, constants.O_RDWR | constants.O_NONBLOCK)).close();
  };
  try {
    const line = await childLine(
      dir,
      `import { fileSizeNote } from ${JSON.stringify(SIZE_CHECK)};
       const started = Date.now();
       const note = await fileSizeNote(${JSON.stringify(file)}, ${JSON.stringify(join(dir, "cli-settings.json"))},
         ${JSON.stringify(dir)}, started + 150);
       console.log(JSON.stringify({ note, ms: Date.now() - started }));
       process.exit(0);`,
      5000,
      release
    );
    assert.notEqual(line, "timeout", "the settings read stalled the child's event loop");
    const { note, ms } = JSON.parse(line) as { note: string | null; ms: number };
    assert.equal(note, null, "no note without settings");
    assert.ok(ms < 1000, `note took ${ms} ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1650: oversized files and devices leave no read running after the answer", async (t) => {
  if (posixOnly) return t.skip(posixOnly);
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-bounded-read-"));
  const big = join(dir, "big.ts");
  await writeFile(big, "");
  await truncate(big, 512 * 1024 * 1024); // sparse: no disk space, 512 MiB of reads
  const zero = join(dir, "zero.ts");
  await symlink("/dev/zero", zero);
  try {
    const line = await childLine(
      dir,
      `import { fileSizeNote } from ${JSON.stringify(SIZE_CHECK)};
       const before = process.memoryUsage().rss;
       const notes = [];
       for (const f of ${JSON.stringify([big, zero])})
         notes.push(await fileSizeNote(f, ${JSON.stringify(join(dir, "none.json"))}, ${JSON.stringify(dir)}, Date.now() + 150));
       await new Promise((r) => setTimeout(r, 400));
       console.log(JSON.stringify({ notes, grownMiB: (process.memoryUsage().rss - before) / 1048576 }));
       process.exit(0);`,
      15000
    );
    assert.notEqual(line, "timeout");
    const { notes, grownMiB } = JSON.parse(line) as { notes: (string | null)[]; grownMiB: number };
    assert.deepEqual(notes, [null, null]);
    assert.ok(grownMiB < 128, `memory grew by ${grownMiB.toFixed(0)} MiB after the notes returned`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1650: the byte limit counts bytes, not decoded characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-bytes-"));
  const file = join(dir, "wide.ts");
  // 1,000 code lines of two-byte characters: ~2.6 MB of bytes, ~1.3 M characters.
  await writeFile(file, `export const s = "${"ä".repeat(1300)}";\n`.repeat(1000));
  try {
    assert.equal(await fileSizeNote(file, join(dir, "none.json"), dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1650: a file that grows after the descriptor check is still cut at the byte limit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-grown-"));
  const file = join(dir, "grown.ts");
  await writeFile(file, "export const x = 1;\n".repeat(150_000)); // ~3 MB
  // The descriptor reports the size it had at inspection time: small.
  const probe = await open(file);
  const handleProto = Object.getPrototypeOf(probe) as { stat: (...args: unknown[]) => Promise<object> };
  await probe.close();
  const realStat = handleProto.stat;
  t.mock.method(handleProto, "stat", async function (this: unknown, ...args: unknown[]) {
    const info = await Reflect.apply(realStat, this, args);
    return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { size: 100 });
  });
  try {
    assert.equal(await fileSizeNote(file, join(dir, "none.json"), dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1650: bounded normal input gives the same note as before", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-normal-"));
  const file = join(dir, "normal.ts");
  await writeFile(file, "export const x = 1;\n".repeat(900));
  try {
    const note = await fileSizeNote(file, join(dir, "none.json"), dir, Date.now() + 5000);
    assert.equal(
      note,
      '<file-size-check file="normal.ts" lines="900" level="critical">over the ~800 code-line review threshold (comments and blank lines excluded) — review whether coherent responsibilities should become separate modules before substantial growth; explain why splitting or keeping this file is appropriate. This is a review prompt, not a growth ban.</file-size-check>'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
