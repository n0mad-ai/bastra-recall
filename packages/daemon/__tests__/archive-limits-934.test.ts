/**
 * #934: the archive's limits are the user's to set — a total cap
 * (`archive.cap`, default 10 GB) and an optional per-target limit
 * (`archive.max-item`, default none).
 *
 * Runs against a temp HOME and a temp archive: the developer's own settings
 * and archive are never touched.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/archive-limits-934.test.ts
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CAP_BYTES,
  archiveCap,
  archiveMaxItem,
  formatSize,
  manifestRows,
  parseSize,
  reconcilePlan,
  runRmShim,
  shimRewrite,
} from "../src/rm-archive.js";
import { runBashPreLane } from "../src/bash-pre-lane.js";
import { cmdArchive } from "../src/cli/archive-cmd.js";
import { cmdConfig } from "../src/cli/config-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { collectFeatureState, featureLines } from "../src/cli/features-note.js";

const RM = "r" + "m";
const GB = 2 ** 30;
const quiet = { out: () => {}, err: () => {} };

function sandbox(extra: NodeJS.ProcessEnv = {}): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "archive-limits-")));
  // Outside every temp root: the test-run root is under /tmp.
  const env: NodeJS.ProcessEnv = { ...process.env, BASTRA_RM_TEMP_ROOTS: "", BASTRA_ARCHIVE_DIR: join(dir, "_archive"), BASTRA_RM_CALL: "call-1", ...extra };
  delete env.BASTRA_ARCHIVE_CAP;
  if (!("BASTRA_ARCHIVE_MAX_ITEM" in extra)) delete env.BASTRA_ARCHIVE_MAX_ITEM;
  return { dir, env };
}

/** A temp HOME plus the given process env for the duration of `run`. */
async function withHome<T>(vars: Record<string, string | undefined>, run: (home: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "archive-limits-home-")));
  const all: Record<string, string | undefined> = { BASTRA_ARCHIVE_CAP: undefined, BASTRA_ARCHIVE_MAX_ITEM: undefined, ...vars, HOME: home };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

const config = (...argv: string[]) => cmdConfig(parseArgs(["config", ...argv]));
const settings = (home: string) => JSON.parse(readFileSync(join(home, ".bastra", "cli-settings.json"), "utf8"));

/**
 * The text written to stdout/stderr and console while `run` runs. Only
 * strings are taken: under `node --test` the runner's own result frames go
 * through the same stdout as binary chunks, and swallowing those loses tests.
 */
async function captured(run: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const orig = { out: process.stdout.write, err: process.stderr.write, log: console.log, error: console.error };
  const take = (stream: NodeJS.WriteStream, write: typeof process.stdout.write) =>
    ((s: unknown, ...rest: unknown[]): boolean =>
      typeof s === "string" ? (chunks.push(s), true) : (write as (...a: unknown[]) => boolean).call(stream, s, ...rest)) as typeof process.stdout.write;
  process.stdout.write = take(process.stdout, orig.out);
  process.stderr.write = take(process.stderr, orig.err);
  console.log = (...a: unknown[]) => void chunks.push(a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void chunks.push(a.join(" ") + "\n");
  try {
    await run();
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    console.log = orig.log;
    console.error = orig.error;
  }
  return chunks.join("");
}

/** `bastra config …` for its exit code, its output kept off the test runner's stdout. */
async function configRc(...argv: string[]): Promise<number> {
  let code = -1;
  await captured(async () => void (code = await config(...argv)));
  return code;
}

describe("#934 — sizes", () => {
  it("parses the forms a person types, in binary multiples", () => {
    assert.equal(parseSize("5GB"), 5 * GB);
    assert.equal(parseSize("500MB"), 500 * 2 ** 20);
    assert.equal(parseSize(" 1.5 gb "), 1.5 * GB);
    assert.equal(parseSize("2g"), 2 * GB);
    assert.equal(parseSize("64kb"), 64 * 1024);
    assert.equal(parseSize("1TB"), 2 ** 40);
    assert.equal(parseSize("4096B"), 4096);
  });

  it("rejects garbage, a bare number, a negative and a zero size", () => {
    for (const bad of ["", "big", "5", "5 gigs", "-1GB", "GB", "0GB", "1e3MB", "5GB 2"]) assert.equal(parseSize(bad), null, bad);
  });

  it("formats bytes the way it reads them", () => {
    assert.equal(formatSize(DEFAULT_CAP_BYTES), "10 GB");
    assert.equal(formatSize(1.5 * GB), "1.5 GB");
    assert.equal(formatSize(500 * 2 ** 20), "500 MB");
    assert.equal(formatSize(512), "512 B");
    assert.equal(parseSize(formatSize(7 * GB).replace(" ", "")), 7 * GB);
  });

  it("the cap: 10 GB, then the stored value, then the env — which wins", () => {
    // Revert-check: swap env and stored in archiveCap → the stored 5GB wins over the env's 2GB.
    assert.equal(archiveCap({}), 10 * GB);
    assert.equal(archiveCap({}, "5GB"), 5 * GB);
    assert.equal(archiveCap({ BASTRA_ARCHIVE_CAP: "2GB" }, "5GB"), 2 * GB);
    assert.equal(archiveCap({ BASTRA_ARCHIVE_CAP: "lots" }, "5GB"), 5 * GB, "a malformed env value does not win");
    assert.equal(archiveCap({ BASTRA_ARCHIVE_CAP: "lots" }), 10 * GB);
  });

  it("the per-target limit: none, then the stored value, then the env — and `off` there lifts it", () => {
    assert.equal(archiveMaxItem({}), null);
    assert.equal(archiveMaxItem({}, "2GB"), 2 * GB);
    assert.equal(archiveMaxItem({ BASTRA_ARCHIVE_MAX_ITEM: "500MB" }, "2GB"), 500 * 2 ** 20);
    assert.equal(archiveMaxItem({ BASTRA_ARCHIVE_MAX_ITEM: "off" }, "2GB"), null);
    assert.equal(archiveMaxItem({ BASTRA_ARCHIVE_MAX_ITEM: "nope" }, "2GB"), 2 * GB);
  });
});

describe("#934 — the total cap is configurable", () => {
  /** Two junk targets and a user one, 4 KB each, archived in one call. */
  function archived(): { dir: string; env: NodeJS.ProcessEnv; junk: string[]; user: string } {
    const { dir, env } = sandbox();
    const junk = [join(dir, "a", "node_modules"), join(dir, "b", "node_modules")];
    for (const j of junk) {
      mkdirSync(j, { recursive: true });
      writeFileSync(join(j, "x.js"), "x".repeat(4096));
    }
    const user = join(dir, "draft.md");
    writeFileSync(user, "u".repeat(4096));
    assert.equal(runRmShim(["-r", ...junk, user], { env, cwd: dir, ...quiet }), 0);
    return { dir, env, junk, user };
  }

  it("eviction honours the configured cap, in the same order: junk first, never a fresh user entry", () => {
    // Revert-check: pass DEFAULT_CAP_BYTES instead of the configured cap → nothing is dropped.
    const { env, junk } = archived();
    const now = new Date();
    assert.deepEqual(reconcilePlan(now, archiveCap(env), env), [], "12 KB under the default 10 GB");
    const tight = reconcilePlan(now, archiveCap({ BASTRA_ARCHIVE_CAP: "10KB" }), env);
    assert.deepEqual(tight.map((d) => [d.why, d.kind]), [["archive size cap", "junk"]], "one junk target brings it under 10 KB");
    assert.ok(junk.includes(tight[0].orig));
    const none = reconcilePlan(now, archiveCap({}, "1KB"), env);
    assert.deepEqual(none.map((d) => d.kind), ["junk", "junk"], "the user entry is younger than its retention and stays");
  });

  it("`bastra archive reconcile` reads the stored cap, and the env wins over it", async () => {
    // Revert-check: put the literal 10 * 2 ** 30 back into archive-cmd.ts → "archive is fine" both times.
    const { env } = archived();
    await withHome({ BASTRA_ARCHIVE_DIR: env.BASTRA_ARCHIVE_DIR }, async () => {
      assert.match(await captured(() => cmdArchive(parseArgs(["archive", "reconcile"]))), /archive is fine/);
      await captured(() => config("set", "archive.cap", "10KB"));
      const plan = await captured(() => cmdArchive(parseArgs(["archive", "reconcile"])));
      assert.equal(plan.match(/would remove .*node_modules  \(archive size cap\)/g)?.length, 1, plan);
      process.env.BASTRA_ARCHIVE_CAP = "1GB";
      assert.match(await captured(() => cmdArchive(parseArgs(["archive", "reconcile"]))), /archive is fine/);
    });
  });
});

describe("#934 — the per-target limit", () => {
  /** A directory of ten 600-byte files (6000 bytes). */
  function tree(dir: string): string {
    const target = join(dir, "build-output");
    mkdirSync(target);
    for (let i = 0; i < 10; i++) writeFileSync(join(target, `f${i}.bin`), "x".repeat(600));
    return target;
  }

  it("a target over the limit is refused and left in place; the message names the limit and the ways out", () => {
    // Revert-check: drop the maxItem check in runRmShim → exit 0 and the target sits in the archive.
    const { dir, env } = sandbox({ BASTRA_ARCHIVE_MAX_ITEM: "1KB" });
    const target = tree(dir);
    const errs: string[] = [];
    assert.equal(runRmShim(["-rf", target], { env, cwd: dir, out: () => {}, err: (s) => errs.push(s) }), 1);
    assert.equal(readdirSync(target).length, 10, "nothing was archived or deleted");
    const said = errs.join("\n");
    assert.match(said, /not removed — it is over the per-target archive limit of 1 KB \(counted 1\.2 KB and stopped\)/);
    assert.match(said, /Not archived, not deleted/);
    assert.match(said, /\/bin\/rm/);
    assert.match(said, /bastra config set archive\.max-item <size>/);
    const [row] = manifestRows(env);
    assert.equal(row.action, "refused");
    assert.match(row.reason ?? "", /per-target archive limit of 1 KB/);
    // The walk stops once the limit is exceeded: two of the ten files were counted.
    assert.equal(row.bytes, 1200);
    assert.deepEqual(readdirSync(join(dir, "_archive")).filter((n) => n !== "manifest.jsonl"), []);
  });

  it("a single file over the limit is refused with its real size", () => {
    const { dir, env } = sandbox({ BASTRA_ARCHIVE_MAX_ITEM: "1KB" });
    const image = join(dir, "disk.img");
    writeFileSync(image, "x".repeat(5120));
    const errs: string[] = [];
    assert.equal(runRmShim([image], { env, cwd: dir, out: () => {}, err: (s) => errs.push(s) }), 1);
    assert.ok(existsSync(image));
    assert.match(errs.join("\n"), /counted 5 KB and stopped/);
  });

  it("a target under the limit is archived as before, with its exact size in the manifest", () => {
    const { dir, env } = sandbox({ BASTRA_ARCHIVE_MAX_ITEM: "8KB" });
    const target = tree(dir);
    assert.equal(runRmShim(["-rf", target], { env, cwd: dir, ...quiet }), 0);
    assert.equal(existsSync(target), false);
    const [row] = manifestRows(env);
    assert.equal(row.action, "archived");
    assert.equal(row.bytes, 6000);
  });

  it("one call with a small and a large target: the small one goes, the large one stays, exit 1", () => {
    const { dir, env } = sandbox({ BASTRA_ARCHIVE_MAX_ITEM: "1KB" });
    const big = tree(dir);
    const small = join(dir, "note.txt");
    writeFileSync(small, "n");
    assert.equal(runRmShim(["-rf", small, big], { env, cwd: dir, ...quiet }), 1);
    assert.equal(existsSync(small), false);
    assert.ok(existsSync(big));
    assert.deepEqual(manifestRows(env).map((r) => r.action), ["archived", "refused"]);
  });

  it("no limit set: today's behaviour, whatever the size", () => {
    const { dir, env } = sandbox();
    const target = tree(dir);
    assert.equal(runRmShim(["-rf", target], { env, cwd: dir, ...quiet }), 0);
    assert.equal(manifestRows(env)[0].action, "archived");
  });

  it("temp ground is still really deleted, over the limit or not", () => {
    const { dir, env } = sandbox({ BASTRA_ARCHIVE_MAX_ITEM: "1KB" });
    const target = tree(dir);
    assert.equal(runRmShim(["-rf", target], { env: { ...env, BASTRA_RM_TEMP_ROOTS: dir }, cwd: dir, ...quiet }), 0);
    assert.equal(existsSync(target), false);
    assert.equal(manifestRows(env)[0].action, "deleted");
  });

  it("the lane hands the limit to the shim in the rewritten command — only when there is one", async () => {
    // Revert-check: drop the fourth argument at the shimRewrite call in bash-pre-lane.ts → no BASTRA_ARCHIVE_MAX_ITEM in the command.
    assert.match(shimRewrite("x", "c", false, 2048), / BASTRA_NODE='[^']*' BASTRA_ARCHIVE_MAX_ITEM=2048B\nx$/);
    assert.doesNotMatch(shimRewrite("x", "c"), /BASTRA_ARCHIVE_MAX_ITEM/);
    const pre = async (): Promise<string> => {
      const stdout = await runBashPreLane(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `${RM} -rf build`, description: "d" }, session_id: "s", tool_use_id: "toolu_1", bastra_client: "claude-code" } as never,
        "http://127.0.0.1:1",
      );
      return JSON.parse(stdout || "{}").hookSpecificOutput?.updatedInput?.command ?? "";
    };
    await withHome({ BASTRA_RM_ARCHIVES: "1", BASTRA_RM_SHIM: undefined }, async () => {
      assert.match(await pre(), /BASTRA_NODE='[^']*'\n/, "no limit stored: the command is as before");
      await captured(() => config("set", "archive.max-item", "2GB"));
      assert.match(await pre(), new RegExp(` BASTRA_ARCHIVE_MAX_ITEM=${2 * GB}B\\n`));
      process.env.BASTRA_ARCHIVE_MAX_ITEM = "1GB";
      assert.match(await pre(), new RegExp(` BASTRA_ARCHIVE_MAX_ITEM=${GB}B\\n`), "the daemon's env wins over the file");
    });
  });
});

describe("#934 — bastra config and bastra doctor", () => {
  it("config set stores a valid size, get shows it, and names an env override", async () => {
    await withHome({}, async (home) => {
      assert.match(await captured(() => config("get", "archive.cap")), /^10 GB {2}\(default\)\n$/);
      assert.match(await captured(() => config("get", "archive.max-item")), /unset — no per-target limit/);
      assert.equal(await configRc("set", "archive.cap", "5GB"), 0);
      assert.equal(await configRc("set", "archive.max-item", "500MB"), 0);
      assert.deepEqual(settings(home).archive, { cap: "5GB", maxItem: "500MB" });
      assert.equal(await captured(() => config("get", "archive.cap")), "5 GB\n");
      assert.equal(await captured(() => config("get", "archive.max-item")), "500 MB\n");
      process.env.BASTRA_ARCHIVE_CAP = "1GB";
      assert.match(await captured(() => config("get", "archive.cap")), /BASTRA_ARCHIVE_CAP=1GB \(env\) overrides/);
    });
  });

  it("garbage is rejected with exit 2, a message that shows the form, and nothing written", async () => {
    // Revert-check: store the value without parseSize → exit 0 and `cap: "plenty"` in the file.
    await withHome({}, async (home) => {
      for (const [key, value] of [["archive.cap", "plenty"], ["archive.cap", "0GB"], ["archive.cap", "5"], ["archive.max-item", "huge"]]) {
        let code = 0;
        const said = await captured(async () => void (code = await config("set", key, value)));
        assert.equal(code, 2, `${key} ${value}`);
        assert.match(said, new RegExp(`error: ${key.replace(".", "\\.")} is a size above zero, e\\.g\\. \\dGB or 500MB .* got '${value}'`));
      }
      assert.equal(await configRc("set", "archive.cap"), 2);
      assert.equal(existsSync(join(home, ".bastra", "cli-settings.json")), false);
    });
  });

  it("archive.max-item off removes the limit and keeps the other archive settings", async () => {
    await withHome({}, async (home) => {
      await captured(async () => {
        await config("set", "archive.enabled", "on");
        await config("set", "archive.max-item", "2GB");
        await config("set", "archive.max-item", "off");
      });
      assert.deepEqual(settings(home).archive, { enabled: true });
    });
  });

  it("doctor shows the effective cap and limit when the archive is on, and nothing about them when it is off", async () => {
    await withHome({ BASTRA_DAEMON_URL: "http://127.0.0.1:1", BASTRA_RM_ARCHIVES: undefined }, async (home) => {
      const vault = join(home, "vault");
      mkdirSync(vault);
      const line = async (env: NodeJS.ProcessEnv = {}): Promise<string> =>
        featureLines(await collectFeatureState([], vault, env)).find((l) => l.includes("archiving rm")) ?? "";
      assert.doesNotMatch(await line(), /cap|limit/, "off: only the hint how to turn it on");
      await captured(() => config("set", "archive.enabled", "on"));
      assert.match(await line(), /cap 10 GB, per-target limit off; bastra archive list/);
      await captured(async () => {
        await config("set", "archive.cap", "5GB");
        await config("set", "archive.max-item", "2GB");
      });
      assert.match(await line(), /cap 5 GB, per-target limit 2 GB;/);
      assert.match(await line({ BASTRA_ARCHIVE_CAP: "1GB", BASTRA_ARCHIVE_MAX_ITEM: "off" }), /cap 1 GB, per-target limit off;/, "the env wins");
    });
  });
});
