import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRAPHIFY_PIN,
  GRAPHIFY_PACKAGE,
  FORBIDDEN_SUBCOMMANDS,
  assertNoInstaller,
  installArgv,
  graphifyEnv,
  bastraGraphifyPath,
  bastraToolDir,
  platformSupported,
  probeTool,
} from "../src/code-graph/graphify-tool.js";

/** A fake `graphify` that reports a version, so the probe can be tested
 *  without installing anything. */
async function fakeGraphify(home: string, version: string): Promise<void> {
  const bin = join(bastraToolDir(home), "bin");
  await mkdir(bin, { recursive: true });
  const path = join(bin, "graphify");
  await writeFile(path, `#!/bin/sh\necho "graphify ${version}"\n`, "utf8");
  await chmod(path, 0o755);
}

describe("graphify tool: the pin", () => {
  it("pins an exact version, never a range", () => {
    // Six releases in six days, and one relicensing (MIT -> Apache-2.0).
    assert.match(GRAPHIFY_PIN, /^\d+\.\d+\.\d+$/);
    assert.equal(GRAPHIFY_PIN, "0.9.63");
  });

  it("installs the pinned version into Recall's own tool directory", () => {
    const home = "/home/someone";
    const { file, args, env } = installArgv(home);
    assert.equal(file, "uv");
    assert.deepEqual(args, ["tool", "install", `${GRAPHIFY_PACKAGE}==${GRAPHIFY_PIN}`]);
    // Scoped, so a uv tool the user installed themselves is untouched.
    assert.equal(env.UV_TOOL_DIR, join(home, ".bastra", "tools"));
    assert.equal(env.UV_TOOL_BIN_DIR, join(home, ".bastra", "tools", "bin"));
  });

  it("never passes --upgrade or a bare package name", () => {
    const { args } = installArgv("/home/someone");
    assert.ok(args.includes(`${GRAPHIFY_PACKAGE}==${GRAPHIFY_PIN}`));
    assert.ok(!args.some((a) => a === GRAPHIFY_PACKAGE));
    assert.ok(!args.some((a) => a.startsWith("--upgrade")));
  });
});

describe("graphify tool: never its own installers (#573 acceptance)", () => {
  for (const [sub, why] of FORBIDDEN_SUBCOMMANDS) {
    it(`refuses \`graphify ${sub}\` — it ${why}`, () => {
      assert.throws(() => assertNoInstaller([sub, "."]), /refusing to run/);
    });
  }

  it("allows the one subcommand family Recall actually uses", () => {
    assert.doesNotThrow(() => assertNoInstaller(["extract", ".", "--code-only"]));
    assert.doesNotThrow(() => assertNoInstaller(["--version"]));
  });

  it("does not choke on an empty argv", () => {
    assert.doesNotThrow(() => assertNoInstaller([]));
  });
});

describe("graphify tool: the call environment", () => {
  it("disables Graphify's own query log", () => {
    // Otherwise every query lands in ~/.cache/graphify-queries.log, outside
    // Recall's retention rules.
    assert.equal(graphifyEnv({}).GRAPHIFY_QUERY_LOG_DISABLE, "1");
  });

  it("fixes the hash seed so community ids are reproducible", () => {
    assert.equal(graphifyEnv({}).PYTHONHASHSEED, "0");
  });

  it("keeps the surrounding environment", () => {
    assert.equal(graphifyEnv({ PATH: "/usr/bin" }).PATH, "/usr/bin");
  });
});

describe("graphify tool: platform scope (C-094)", () => {
  it("covers macOS and Linux", () => {
    assert.equal(platformSupported("darwin"), true);
    assert.equal(platformSupported("linux"), true);
  });

  it("reports Windows as out of scope rather than half-working", async () => {
    // fcntl locking is a no-op there, `nice` is not portable, and `.git` in a
    // worktree is a file. Promised only once Windows CI covers all of it.
    assert.equal(platformSupported("win32"), false);
    const status = await probeTool({ platform: "win32" });
    assert.equal(status.reason, "unsupported-platform");
    assert.equal(status.usable, null);
  });
});

describe("graphify tool: probing", () => {
  it("reports not-installed when Recall has no copy", async () => {
    const home = await mkdtemp(join(tmpdir(), "bastra-tool-"));
    try {
      const status = await probeTool({
        home,
        platform: "darwin",
        lookupExternal: async () => null,
      });
      assert.equal(status.reason, "not-installed");
      assert.equal(status.usable, null);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses Recall's own binary by absolute path when it matches the pin", async () => {
    const home = await mkdtemp(join(tmpdir(), "bastra-tool-"));
    try {
      await fakeGraphify(home, GRAPHIFY_PIN);
      const status = await probeTool({
        home,
        platform: "darwin",
        lookupExternal: async () => null,
      });
      assert.equal(status.reason, "ok");
      assert.ok(status.usable);
      assert.equal(status.usable!.origin, "bastra");
      assert.equal(status.usable!.pinned, true);
      // Absolute path, never a bare name resolved through PATH.
      assert.equal(status.usable!.path, bastraGraphifyPath(home));
      assert.ok(status.usable!.path.startsWith("/"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a binary that reports a different version", async () => {
    const home = await mkdtemp(join(tmpdir(), "bastra-tool-"));
    try {
      await fakeGraphify(home, "0.9.62");
      const status = await probeTool({
        home,
        platform: "darwin",
        lookupExternal: async () => null,
      });
      // Refused, not used with a warning: the parser and the relation
      // allowlist are tied to a specific release.
      assert.equal(status.reason, "version-mismatch");
      assert.equal(status.usable, null);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a pre-existing external install without using or touching it", async () => {
    const home = await mkdtemp(join(tmpdir(), "bastra-tool-"));
    try {
      await fakeGraphify(home, GRAPHIFY_PIN);
      // A Graphify the user installed themselves, at a different version.
      const theirs = join(home, "their-graphify");
      await writeFile(theirs, `#!/bin/sh\necho "graphify 0.9.40"\n`, "utf8");
      await chmod(theirs, 0o755);

      const status = await probeTool({
        home,
        platform: "darwin",
        lookupExternal: async () => theirs,
      });

      assert.ok(status.external, "the external install must be reported");
      assert.equal(status.external!.version, "0.9.40");
      assert.equal(status.external!.pinned, false);
      // Recall still uses its own.
      assert.equal(status.usable!.path, bastraGraphifyPath(home));
      assert.notEqual(status.usable!.path, theirs);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
