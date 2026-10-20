/**
 * The Bash lane's coverage rewrite (#629): off by default and silent, on only
 * for a test command in an enabled repository, and then nothing but
 * NODE_V8_COVERAGE in front of the command the agent wrote.
 */
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME first: the settings file and the enabled list resolve under it, and
// this test enables a repository — that must not land in ~/.bastra.
const home = await mkdtemp(join(tmpdir(), "bastra-coverage-lane-home-"));
process.env.HOME = home;
process.env.BASTRA_HOOK_STATE_DIR = join(home, "hook-state");
process.env.BASTRA_TELEMETRY = "off";
delete process.env.BASTRA_COVERAGE_MAP;
delete process.env.BASTRA_CODE_AWARENESS;

const { coverageRewrite } = await import("../src/bash-pre-coverage.js");
const { runBashPreLane } = await import("../src/bash-pre-lane.js");
const { setRepoEnabled } = await import("../src/code-graph/enabled-repos.js");
const { setCoverageMapEnabled } = await import("../src/code-graph/coverage-map-settings.js");
const { coverageRawDirOf } = await import("../src/code-graph/coverage-map.js");

const repo = join(home, "repo");
const other = join(home, "other");

before(async () => {
  for (const r of [repo, other]) await mkdir(join(r, ".git"), { recursive: true });
});
after(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const payload = (command: string, cwd = repo, client: string | null = "claude-code") => ({
  ...(client === null ? {} : { bastra_client: client }),
  session_id: "s-cov",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "run tests" },
});

describe("bash-pre lane: coverage rewrite (#629)", () => {
  it("switch off (the default): the lane answers {} and creates nothing, even in an enabled repository", async () => {
    await setRepoEnabled(repo, true);
    assert.equal(await coverageRewrite("npm test", repo), null);
    assert.equal(await runBashPreLane(payload("npm test"), "http://127.0.0.1:1"), "{}");
    await assert.rejects(stat(join(repo, ".bastra-coverage")));
  });

  it("switch on: a test command in an enabled repository is rewritten, and only the command changes", async () => {
    await setRepoEnabled(repo, true);
    await setCoverageMapEnabled(true);
    const out = JSON.parse(await runBashPreLane(payload("cd packages/core && npm test"), "http://127.0.0.1:1")) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision?: string; updatedInput: Record<string, unknown> };
    };
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined, "no auto-approval rides along");
    assert.deepEqual(out.hookSpecificOutput.updatedInput, {
      command: `export NODE_V8_COVERAGE='${coverageRawDirOf(repo)}'; cd packages/core && npm test`,
      description: "run tests",
    });
    assert.equal(await readFile(join(repo, ".bastra-coverage/.gitignore"), "utf8"), "*\n");
    await stat(coverageRawDirOf(repo));
  });

  it("switch on: a command that is not a test run, or a repository without code awareness, runs as written", async () => {
    await setCoverageMapEnabled(true);
    await setRepoEnabled(repo, true);
    assert.equal(await runBashPreLane(payload("npm run build"), "http://127.0.0.1:1"), "{}");
    assert.equal(await coverageRewrite("npm test", other), null);
    assert.equal(await coverageRewrite("npm test", join(home, "nowhere")), null);
    assert.equal(await coverageRewrite("npm test", undefined), null);
    await assert.rejects(stat(join(other, ".bastra-coverage")));
  });

  it("switch on: a call that does not prove it is Claude Code (Codex, unmarked) runs as written", async () => {
    await setRepoEnabled(repo, true);
    await setCoverageMapEnabled(true);
    assert.equal(await runBashPreLane(payload("npm test", repo, "codex"), "http://127.0.0.1:1"), "{}");
    assert.equal(await runBashPreLane(payload("npm test", repo, null), "http://127.0.0.1:1"), "{}");
  });

  it("BASTRA_COVERAGE_MAP=off wins over the stored switch", async () => {
    await setRepoEnabled(repo, true);
    await setCoverageMapEnabled(true);
    process.env.BASTRA_COVERAGE_MAP = "off";
    try {
      assert.equal(await coverageRewrite("npm test", repo), null);
    } finally {
      delete process.env.BASTRA_COVERAGE_MAP;
    }
  });
});
