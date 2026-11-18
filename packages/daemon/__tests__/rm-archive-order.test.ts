/**
 * #1532: characterization of the order in which the archiving `rm` writes,
 * moves and deletes, pinned before rm-archive.ts was split. A move is recorded
 * only after it happened, the manifest line is the last write, a temp target is
 * deleted before its line, and a refused target is never touched. The fs calls
 * are observed through node:fs itself, the same way the #695 disk-full tests
 * fail them.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveRoot, runRmShim } from "../src/rm-archive.js";

const WATCHED = ["mkdirSync", "renameSync", "rmSync", "rmdirSync", "appendFileSync", "chmodSync", "unlinkSync"];

function sandbox(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rm-order-")));
  return {
    dir,
    env: { ...process.env, BASTRA_RM_TEMP_ROOTS: "", BASTRA_ARCHIVE_DIR: join(dir, "_archive"), BASTRA_RM_CALL: "c" },
  };
}

/** Run `fn` with every watched node:fs mutation recorded as `name path [path]`, relative to `dir`. */
function recordFs(dir: string, fn: () => void): string[] {
  type Fs = Record<string, (...a: unknown[]) => unknown>;
  const fs = createRequire(import.meta.url)("node:fs") as Fs;
  const calls: string[] = [];
  const short = (p: unknown): string => String(p).split(dir).join("<dir>");
  const originals = new Map(WATCHED.map((name) => [name, fs[name]]));
  for (const [name, orig] of originals)
    fs[name] = (...args: unknown[]) => {
      const paths = args.filter((a) => typeof a === "string").slice(0, name === "renameSync" ? 2 : 1);
      calls.push([name, ...paths.map(short)].join(" "));
      return orig(...args);
    };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    for (const [name, orig] of originals) fs[name] = orig;
    syncBuiltinESMExports();
  }
  return calls;
}

/** The dated `<date>/<HHMMSS>-<pid>` segments vary per run; the full path follows them. */
const stable = (calls: string[]): string[] =>
  calls.map((c) => c.replace(/\/\d{4}-\d{2}-\d{2}\/\d{6}-\d+</g, "/<date>/<time-pid><"));

const quiet = { out: () => {}, err: () => {} };

describe("#1532 — the archiving rm's write and delete order", () => {
  it("archive: the archive root first, then the dated directory, the move, and the manifest line last", () => {
    const { dir, env } = sandbox();
    const target = join(dir, "notes.txt");
    writeFileSync(target, "keep\n");
    const calls = stable(recordFs(dir, () => assert.equal(runRmShim([target], { env, cwd: dir, ...quiet }), 0)));
    assert.deepEqual(calls, [
      "mkdirSync <dir>/_archive",
      "mkdirSync <dir>/_archive/<date>/<time-pid><dir>",
      "renameSync <dir>/notes.txt <dir>/_archive/<date>/<time-pid><dir>/notes.txt",
      "appendFileSync <dir>/_archive/manifest.jsonl",
    ]);
  });

  it("temp: the target is deleted, then its manifest line is written; nothing is moved", () => {
    const { dir, env } = sandbox();
    const scratch = join(dir, "scratch");
    mkdirSync(join(scratch, "junk"), { recursive: true });
    const calls = recordFs(dir, () =>
      assert.equal(
        runRmShim(["-rf", join(scratch, "junk")], {
          env: { ...env, BASTRA_RM_TEMP_ROOTS: scratch },
          cwd: dir,
          ...quiet,
        }),
        0
      )
    );
    assert.deepEqual(calls, [
      "mkdirSync <dir>/_archive",
      "rmSync <dir>/scratch/junk",
      "appendFileSync <dir>/_archive/manifest.jsonl",
    ]);
  });

  it("refused: only the manifest line is written, the target is not touched", () => {
    const { dir, env } = sandbox();
    archiveRoot(env);
    const calls = recordFs(dir, () =>
      assert.equal(runRmShim(["-rf", join(dir, "_archive")], { env, cwd: dir, ...quiet }), 1)
    );
    assert.deepEqual(calls, ["mkdirSync <dir>/_archive", "appendFileSync <dir>/_archive/manifest.jsonl"]);
    assert.match(readFileSync(join(dir, "_archive", "manifest.jsonl"), "utf8"), /"action":"refused"/);
  });
});
