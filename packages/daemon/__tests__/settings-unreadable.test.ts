/**
 * A settings file that exists but cannot be read is never written over — by
 * any setter, not only the model answers.
 *
 * Second counter-review of the model-recommendation notice (PR #1118, on
 * 1fc5ad07); its reproduction kept as a test. No Ollama, only invented files.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/settings-unreadable.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { cmdModels, modelNoticeAfterCommand } from "../src/cli/models-cmd.js";
import { recordModelAnswer } from "../src/model-recommendation.js";
import { readSettings, setUpdateMode } from "../src/settings.js";
import { settingsFileState } from "../src/settings-file.js";
import { ARGS, ORIGINAL, cannotRevokeRead, deps, quiet, withDir } from "./fixtures/model-decision-helpers.js";
// ── P1: a file that cannot be read is not a file without settings ────────────

test("P1 unreadable settings: a model answer refuses, and the file keeps every setting", { skip: cannotRevokeRead }, async () => {
  await withDir(async (_dir, path) => {
    for (const argv of [["later", "fixture-rec"], ["dismiss", "fixture-rec"], ["switch", "fixture-rec", "new:4b"]]) {
      await chmod(path, 0o200);
      const enable = (async () => { throw new Error("must not reach the switch"); }) as never;
      const { result, out } = await quiet(() => cmdModels({ sub: argv[0], positional: ["models", ...argv], settingsPath: path, deps: deps(path, argv[0] === "switch" ? {} : { enable }) }));
      await chmod(path, 0o600);
      assert.equal(result, 1, argv.join(" "));
      assert.match(out, /cannot be read \(EACCES\)|Ollama isn't running/, out);
      assert.match(out, /Nothing was changed/);
      assert.equal(await readFile(path, "utf8"), ORIGINAL, `${argv[0]}: generation, embedding and the API token are still there`);
    }
  });
});

test("P1 unreadable settings: the catch-up question is not put and nothing is written", { skip: cannotRevokeRead }, async () => {
  await withDir(async (_dir, path) => {
    await chmod(path, 0o200);
    // Unreadable means defaults for a reader — the notice may or may not be
    // due; what matters is that no note is written over the file.
    await quiet(() => modelNoticeAfterCommand(ARGS, deps(path, { interactive: true, ask: async () => "l", shownPath: join(path, "..", "shown.txt") })));
    await chmod(path, 0o600);
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
  });
});

test("P1 unreadable settings: the shared write path refuses for every setter — a missing file is still created", async () => {
  await withDir(async (dir, path) => {
    assert.equal(await settingsFileState(path), "ok");
    assert.equal(await settingsFileState(join(dir, "absent.json")), "missing");
    assert.equal(await settingsFileState(join(path, "below-a-file.json")), "missing", "ENOTDIR is 'not there' as well");
    // A directory where the file should be: readable by nobody as a file, on every platform.
    const asDir = join(dir, "is-a-directory.json");
    await mkdir(asDir);
    assert.deepEqual(await settingsFileState(asDir), { unreadable: "EISDIR" });
    await assert.rejects(setUpdateMode("auto", asDir), /exists but cannot be read \(EISDIR\)/);
    // The ordinary cases are untouched: a missing file is created, a present one updated.
    const fresh = join(dir, "fresh.json");
    await setUpdateMode("auto", fresh);
    assert.equal((await readSettings(fresh)).update.mode, "auto");
    await setUpdateMode("off", path);
    const s = await readSettings(path);
    assert.equal(s.update.mode, "off");
    assert.equal(s.api?.token, "invented-token");
  });
});

test("P1 unreadable settings: `bastra config`-style setters no longer replace the file either", { skip: cannotRevokeRead }, async () => {
  await withDir(async (_dir, path) => {
    await chmod(path, 0o200);
    await assert.rejects(setUpdateMode("auto", path), /exists but cannot be read \(EACCES\)/);
    await chmod(path, 0o600);
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
  });
});

test("a corrupt file: ordinary setters still repair it (unchanged), model answers refuse", async () => {
  await withDir(async (_dir, path) => {
    const CORRUPT = '{"api":{"token":"invented-token"},BROKEN';
    await writeFile(path, CORRUPT);
    assert.equal(await settingsFileState(path), "corrupt");
    await assert.rejects(quiet(() => recordModelAnswer("fixture-rec", "later", path)), /not valid JSON/);
    assert.equal(await readFile(path, "utf8"), CORRUPT);
    await quiet(() => setUpdateMode("auto", path));
    assert.equal((await quiet(() => readSettings(path))).result.update.mode, "auto");
  });
});

// ── the write path reads the file once ───────────────────────────────────────

/** Runs `fn` with every read of `path` after the first one going through `later`. */
async function withLaterReads<T>(path: string, later: (read: () => Promise<unknown>) => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  const realRead = fs.readFile;
  let reads = 0;
  fs.readFile = (async (p: never, ...args: never[]) => {
    const read = () => (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...args);
    return p === path && ++reads > 1 ? later(read) : read();
  }) as typeof fs.readFile;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fs.readFile = realRead;
    syncBuiltinESMExports();
  }
}

test("P1 one read: a read that fails AFTER the first one cannot empty the file — ordinary setter and model answer", async () => {
  // The counter-review's second pass: the state was checked with one read and
  // the settings taken from a second. A transient error on that second read
  // gave the writer defaults, and they were written back.
  for (const code of ["EAGAIN", "EBUSY", "ETIMEDOUT", "EIO"]) {
    for (const kind of ["ordinary setter", "model answer"] as const) {
      await withDir(async (_dir, path) => {
        const fail = async () => { throw Object.assign(new Error("injected: later read failed"), { code }); };
        // Whether the write goes through or is refused, the settings survive.
        await withLaterReads(path, fail, () =>
          quiet(() => (kind === "ordinary setter" ? setUpdateMode("off", path) : recordModelAnswer("fixture-rec", "later", path))).catch(() => undefined),
        );
        const stored = JSON.parse(await readFile(path, "utf8"));
        assert.equal(stored.generation?.model, "old:4b", `${code}, ${kind}: generation.model`);
        assert.equal(stored.embedding?.provider, "ollama", `${code}, ${kind}: embedding.provider`);
        assert.equal(stored.api?.token, "invented-token", `${code}, ${kind}: api.token`);
      });
    }
  }
});

test("P1 one read: a file that turns corrupt right after it was read is not answered with defaults", async () => {
  await withDir(async (_dir, path) => {
    // Every later read would see broken JSON. The one read the writer makes saw
    // the valid file, and that snapshot is what it changes and writes.
    const corruptNow = async (read: () => Promise<unknown>) => { await writeFile(path, '{"api":{"token":"invented-token"},BROKEN'); return read(); };
    await withLaterReads(path, corruptNow, () => quiet(() => recordModelAnswer("fixture-rec", "later", path)).catch(() => undefined));
    const stored = JSON.parse(await readFile(path, "utf8"));
    assert.equal(stored.api?.token, "invented-token");
    assert.equal(stored.generation?.model, "old:4b");
    assert.equal(stored.modelRecommendation?.answer, "later");
  });
});

test("P1 one read: a transient error on the one read refuses the write and leaves the file alone", async () => {
  await withDir(async (_dir, path) => {
    const realRead = fs.readFile;
    fs.readFile = (async (p: never, ...args: never[]) => {
      if (p === path) throw Object.assign(new Error("injected: read failed"), { code: "EIO" });
      return (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...args);
    }) as typeof fs.readFile;
    syncBuiltinESMExports();
    try {
      await assert.rejects(setUpdateMode("off", path), /exists but cannot be read \(EIO\)/);
      await assert.rejects(recordModelAnswer("fixture-rec", "later", path), /exists but cannot be read \(EIO\)/);
    } finally {
      fs.readFile = realRead;
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
  });
});
