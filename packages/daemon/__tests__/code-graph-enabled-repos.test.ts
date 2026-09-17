import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalRepoPath,
  codeAwarenessDisabledByEnv,
  enabledRepos,
  isRepoEnabled,
  setRepoEnabled,
} from "../src/code-graph/enabled-repos.js";

/**
 * Enabling is explicit, per repository, and reversible (#574). The rule these
 * tests hold down is the one that keeps Recall out of directories nobody asked
 * about: an empty list means nothing happens, and that is the default.
 */
async function withSettings<T>(
  initial: unknown,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-enabled-"));
  const path = join(dir, "cli-settings.json");
  if (initial !== undefined) await writeFile(path, JSON.stringify(initial), "utf8");
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("code awareness: which repositories are enabled", () => {
  it("is empty by default — Recall never indexes a directory it merely saw", async () => {
    await withSettings({ update: { mode: "notify" } }, async (path) => {
      assert.deepEqual(await enabledRepos(path, {}, "darwin"), []);
    });
  });

  it("is empty when the settings file does not exist at all", async () => {
    await withSettings(undefined, async (path) => {
      assert.deepEqual(await enabledRepos(path, {}, "darwin"), []);
    });
  });

  it("enables and disables one repository", async () => {
    await withSettings({ update: { mode: "notify" } }, async (path) => {
      assert.equal(await setRepoEnabled("/repos/alpha", true, path), true);
      assert.equal(await isRepoEnabled("/repos/alpha", path, {}, "darwin"), true);

      assert.equal(await setRepoEnabled("/repos/alpha", false, path), true);
      assert.equal(await isRepoEnabled("/repos/alpha", path, {}, "darwin"), false);
    });
  });

  it("reports that nothing changed instead of rewriting the file", async () => {
    await withSettings({ update: { mode: "notify" } }, async (path) => {
      assert.equal(await setRepoEnabled("/repos/alpha", true, path), true);
      // Second enable is a no-op, and the CLI can say so honestly.
      assert.equal(await setRepoEnabled("/repos/alpha", true, path), false);
      // Disabling something that was never enabled likewise.
      assert.equal(await setRepoEnabled("/repos/never", false, path), false);
    });
  });

  it("keeps other repositories untouched when one is disabled", async () => {
    await withSettings({ update: { mode: "notify" } }, async (path) => {
      await setRepoEnabled("/repos/alpha", true, path);
      await setRepoEnabled("/repos/beta", true, path);
      await setRepoEnabled("/repos/alpha", false, path);
      assert.deepEqual(await enabledRepos(path, {}, "darwin"), [canonicalRepoPath("/repos/beta")]);
    });
  });

  it("normalizes paths, so the same repo cannot be enabled twice", async () => {
    await withSettings({ update: { mode: "notify" } }, async (path) => {
      await setRepoEnabled("/repos/alpha", true, path);
      assert.equal(await setRepoEnabled("/repos/alpha/", true, path), false);
      assert.equal(await setRepoEnabled("/repos/beta/../alpha", true, path), false);
      assert.equal((await enabledRepos(path, {}, "darwin")).length, 1);
    });
  });

  it("preserves unrelated settings", async () => {
    await withSettings({ update: { mode: "notify" }, commons: { enabled: true } }, async (path) => {
      await setRepoEnabled("/repos/alpha", true, path);
      const { readFile } = await import("node:fs/promises");
      const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      assert.deepEqual(written.commons, { enabled: true });
      assert.deepEqual(written.update, { mode: "notify" });
    });
  });

  it("survives a malformed list instead of throwing", async () => {
    await withSettings(
      { update: { mode: "notify" }, code: { repos: ["/repos/ok", 42, "", null] } },
      async (path) => {
        assert.deepEqual(await enabledRepos(path, {}, "darwin"), [canonicalRepoPath("/repos/ok")]);
      },
    );
  });
});

describe("code awareness: the off switches", () => {
  it("reads BASTRA_CODE_AWARENESS=off", () => {
    assert.equal(codeAwarenessDisabledByEnv({ BASTRA_CODE_AWARENESS: "off" }), true);
    assert.equal(codeAwarenessDisabledByEnv({ BASTRA_CODE_AWARENESS: "OFF" }), true);
    assert.equal(codeAwarenessDisabledByEnv({}), false);
    assert.equal(codeAwarenessDisabledByEnv({ BASTRA_CODE_AWARENESS: "on" }), false);
  });

  it("returns no repositories while the kill switch is set, without clearing the list", async () => {
    await withSettings({ update: { mode: "notify" } }, async (path) => {
      await setRepoEnabled("/repos/alpha", true, path);
      assert.deepEqual(await enabledRepos(path, { BASTRA_CODE_AWARENESS: "off" }, "darwin"), []);
      // The list itself is untouched: switching the env back restores it.
      assert.deepEqual(await enabledRepos(path, {}, "darwin"), [canonicalRepoPath("/repos/alpha")]);
    });
  });

  it("returns no repositories on an out-of-scope platform (C-094)", async () => {
    await withSettings({ update: { mode: "notify" } }, async (path) => {
      await setRepoEnabled("/repos/alpha", true, path);
      assert.deepEqual(await enabledRepos(path, {}, "win32"), []);
      assert.equal(await isRepoEnabled("/repos/alpha", path, {}, "win32"), false);
    });
  });
});
