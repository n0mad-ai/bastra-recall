import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error — plain .mjs script, no declarations
import { dropCallerGitEnv } from "../../../scripts/caller-git-env.mjs";

// #1669: started without test-env.mjs, this file's git must still not reach a caller's GIT_DIR/GIT_WORK_TREE.
dropCallerGitEnv();

const cwd = resolve(import.meta.dirname, "../../..");
const harness = "packages/eval/src/replaced-claim-advisory.ts";
const marker = "sensitive-fixture-marker-643";
function run(args: string[], preload = true) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(BASTRA|NEXUS)_/.test(k) && !["NODE_OPTIONS", "NODE_TEST_CONTEXT"].includes(k)
    )
  );
  // Choose an isolated place even before test-env. Never point a child at operator state.
  const home = mkdtempSync(join(tmpdir(), "eval643-child-home-"));
  mkdirSync(join(home, ".bastra"));
  const sentinel = join(home, ".bastra", "operator-state-sentinel");
  writeFileSync(sentinel, marker);
  env.BASTRA_DB_PATH = env.BASTRA_VAULT_ROOTS_PATH = sentinel;
  env.HOME = env.USERPROFILE = home;
  // #1488: the harness records the repository state (git rev-parse/status). A throwaway
  // repository gives it one, so the test also holds in a copy of this code without `.git`.
  const repo = join(home, "repo");
  mkdirSync(repo);
  const gitContext = {
    GIT_DIR: join(repo, ".git"),
    GIT_WORK_TREE: repo,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  Object.assign(env, gitContext);
  // #1668: this child is the first process to load test-env.mjs, which drops a caller's
  // GIT_* variables. The throwaway repository is therefore handed over after it, too.
  const gitPreload = join(home, "git-context.mjs");
  writeFileSync(gitPreload, `Object.assign(process.env, ${JSON.stringify(gitContext)});\n`);
  for (const args of [
    ["init", "--quiet"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "t"],
  ]) {
    const git = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", timeout: 5000 });
    assert.equal(git.status, 0, git.stdout + git.stderr);
  }
  try {
    return spawnSync(
      process.execPath,
      [
        ...(preload ? ["--import", "./scripts/test-env.mjs"] : []),
        "--import",
        pathToFileURL(gitPreload).href,
        "--import",
        "tsx",
        harness,
        ...args,
      ],
      { cwd, env, encoding: "utf8", timeout: 60_000 }
    );
  } finally {
    assert.equal(readFileSync(sentinel, "utf8"), marker);
    rmSync(home, { recursive: true, force: true });
  }
}
function setup() {
  const root = mkdtempSync(join(realpathSync("/tmp"), "bastra-eval643-copy-"));
  const vault = join(root, "vault");
  mkdirSync(vault, { mode: 0o700 });
  return { root, vault, out: join(root, "aggregate.json"), stop: () => rmSync(root, { recursive: true, force: true }) };
}
function note(id: string, next?: string, sensitivity = "team") {
  return `---\nid: ${id}\ntitle: Synthetic relay queue capacity\ntype: project-fact\nsummary: The relay queue capacity is 500 messages per batch.\ntopic_path: [relay, capacity]\ntags: [relay-capacity]\nscope: relay\nrecall_when: [tuning the relay queue capacity]\ncreated: '2026-11-01'\nupdated: '2026-11-01'\nsensitivity: ${sensitivity}\n${next ? `superseded_by: ${next}\n` : ""}---\n\nThe relay queue capacity is 500 messages per batch.\n`;
}

test("copy reader uses stored links, preserves source bytes, and exports aggregates without IDs", () => {
  const s = setup();
  try {
    const notes = new Map([
      ["old.md", note(`${marker}-old`, `${marker}-middle`)],
      ["middle.md", note(`${marker}-middle`, `${marker}-head`)],
      ["head.md", note(`${marker}-head`)],
      ["missing.md", note(`${marker}-missing`, `${marker}-absent`)],
      ["cycle.md", note(`${marker}-cycle`, `${marker}-cycle`)],
      ["private.md", note(`${marker}-private`, undefined, "private")],
    ]);
    for (const [p, text] of notes) writeFileSync(join(s.vault, p), text);
    const child = run(["--vault-copy", s.vault, "--out", s.out]);
    assert.equal(child.status, 0, child.stderr);
    const raw = readFileSync(s.out, "utf8"),
      result = JSON.parse(raw);
    assert.equal(result.corpus_mode, "existing-copy");
    assert.equal(result.inventory.loaded, 6);
    assert.equal(result.inventory.complete_predecessor_paths, 2);
    assert.equal(result.inventory.distinct_chain_heads, 1);
    assert.equal(result.inventory.missing_targets, 1);
    assert.equal(result.inventory.cycles, 1);
    assert.equal(result.inventory.private_memories, 1);
    assert.equal(result.probes.predecessor_replay.executed, 2);
    assert.equal(result.probes.head_restatement.executed, 2);
    assert.equal(result.probes.overwrite.executed, 1);
    assert.equal(result.probes.edit.executed, 1);
    assert.equal(result.probes.predecessor_replay.names_head, 2);
    assert.equal(result.precision, undefined);
    assert.equal(result.recall, undefined);
    assert.ok(!raw.includes(marker));
    assert.ok(!child.stdout.includes(marker));
    assert.ok(!child.stderr.includes(marker));
    for (const [p, text] of notes) assert.equal(readFileSync(join(s.vault, p), "utf8"), text);
  } finally {
    s.stop();
  }
});

test("empty copy reports null denominators and no fabricated accuracy", () => {
  const s = setup();
  try {
    const child = run(["--out", s.out, "--vault-copy", s.vault]);
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(readFileSync(s.out, "utf8"));
    assert.equal(r.inventory.loaded, 0);
    assert.equal(r.probes.predecessor_replay.warning_frequency, null);
    assert.equal(r.probes.predecessor_replay.structural_head_routing, null);
  } finally {
    s.stop();
  }
});

test("CLI rejects unknown, duplicate and missing flags before handler imports", () => {
  for (const args of [[], ["--bogus", marker], ["--out"], ["--out", marker, "--out", marker]]) {
    const child = run(args);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /EVAL643_INVALID_ARGUMENTS/);
    assert.ok(!child.stderr.includes(marker));
  }
});

test("copy mode requires isolated test preload and private existing temp paths", () => {
  const s = setup();
  try {
    for (const [args, preload] of [
      [["--vault-copy", s.vault, "--out", s.out], false],
      [["--vault-copy", cwd, "--out", s.out], true],
      [["--vault-copy", s.vault, "--out", join(s.vault, "out.json")], true],
      [["--vault-copy", "relative", "--out", s.out], true],
    ] as Array<[string[], boolean]>) {
      const child = run(args, preload);
      assert.equal(child.status, 1);
      assert.match(child.stderr, /EVAL643_COPY_FAILED/);
      assert.ok(!child.stderr.includes(s.vault));
    }
  } finally {
    s.stop();
  }
});

test("symlink and hardlink readers fail closed without changing external sentinel", () => {
  for (const kind of ["symlink", "hardlink"]) {
    const s = setup();
    try {
      const sentinel = join(s.root, "sentinel.md");
      writeFileSync(sentinel, note(marker));
      if (kind === "symlink") symlinkSync(sentinel, join(s.vault, "linked.md"));
      else linkSync(sentinel, join(s.vault, "linked.md"));
      const child = run(["--vault-copy", s.vault, "--out", s.out]);
      assert.equal(child.status, 1);
      assert.match(child.stderr, /EVAL643_COPY_FAILED/);
      assert.equal(readFileSync(sentinel, "utf8"), note(marker));
      assert.ok(!child.stderr.includes(marker));
    } finally {
      s.stop();
    }
  }
});

test("non-memory copy entries remain explicitly unindexed without disclosing contents", () => {
  const s = setup();
  try {
    writeFileSync(join(s.vault, `${marker}.md`), `---\nid: ${marker}\ntitle: [broken\n---\n`);
    const child = run(["--vault-copy", s.vault, "--out", s.out]);
    assert.equal(child.status, 0, child.stderr);
    const raw = readFileSync(s.out, "utf8"),
      r = JSON.parse(raw);
    assert.equal(r.inventory.loaded, 0);
    assert.equal(r.inventory.unindexed_markdown, 1);
    assert.equal(r.coverage_limited, true);
    assert.ok(!raw.includes(marker));
    assert.ok(!child.stdout.includes(marker));
    assert.ok(!child.stderr.includes(marker));
  } finally {
    s.stop();
  }
});

test("a reader failure exits with a fixed error and cleans up without disclosing paths", () => {
  const s = setup();
  const path = join(s.vault, `${marker}.md`);
  try {
    writeFileSync(path, note(marker));
    chmodSync(path, 0o000);
    const child = run(["--vault-copy", s.vault, "--out", s.out]);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /EVAL643_COPY_FAILED/);
    assert.ok(!child.stderr.includes(marker));
    assert.ok(!child.stderr.includes(s.root));
  } finally {
    chmodSync(path, 0o600);
    assert.equal(readFileSync(path, "utf8"), note(marker));
    s.stop();
  }
});

test("an export failure after probes stops the copy run and preserves input bytes", () => {
  const s = setup();
  const path = join(s.vault, "current.md");
  try {
    writeFileSync(path, note(marker));
    const child = run(["--vault-copy", s.vault, "--out", join(s.root, "x".repeat(300))]);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /EVAL643_COPY_FAILED/);
    assert.ok(!child.stderr.includes(marker));
    assert.ok(!child.stderr.includes(s.root));
    assert.equal(readFileSync(path, "utf8"), note(marker));
  } finally {
    s.stop();
  }
});
