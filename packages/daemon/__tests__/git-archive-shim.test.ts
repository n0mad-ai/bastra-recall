/**
 * #1527: characterization of `runGitShim` before it is split. Each case pins
 * what the shim does today — which forms it passes through, refuses or acts
 * on, the exit code, what it prints, and that everything it saves is saved
 * before the real git runs. Cases git-archive.test.ts already covers are not
 * repeated here.
 *
 * Every repository is a temp repository with its own git context: no system
 * or global git config, no repository above the temp root, the archive in the
 * temp root.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { manifestRows } from "../src/rm-archive.js";
import { realGit, runGitShim } from "../src/git-archive.js";

const ASK = "Ask the user to run it, or BASTRA_GIT_SHIM=0 for the normal permission prompt.";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-shim-char-")));
  const dir = join(root, "w");
  mkdirSync(dir);
  // The suite runs with the shim switched off (scripts/test-env.mjs); here it is on.
  // No GIT_* of the caller's (GIT_DIR, GIT_WORK_TREE from a hook, say): every
  // git here works on the temp repository only.
  const { BASTRA_GIT_SHIM: _off, ...rest } = process.env;
  const base = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("GIT_")));
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: root,
    BASTRA_ARCHIVE_DIR: join(root, "archive"),
    BASTRA_RM_TEMP_ROOTS: "",
    BASTRA_RM_CALL: "toolu_c",
  };
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(dir, "a"), "one\n");
  writeFileSync(join(dir, "b"), "two\n");
  git("add", "-A");
  git("commit", "-qm", "c1");
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
  const run = (argv: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const rc = runGitShim(argv, {
      env: o.env ?? env,
      cwd: o.cwd ?? dir,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    return { rc, out, err };
  };
  const edit = () => writeFileSync(join(dir, "a"), "unsaved\n");
  const pins = () => git("for-each-ref", "--format=%(refname)", "refs/bastra-archive");
  return { root, dir, env, git, read, run, edit, pins, rows: () => manifestRows(env) };
}

describe("#1527 runGitShim characterization — forms that are not an act", () => {
  it("no git after the shim in PATH: exit 127 and one line, even with the shim switched off", () => {
    const t = fixture();
    const empty = join(t.root, "empty");
    mkdirSync(empty);
    for (const env of [
      { ...t.env, PATH: empty },
      { ...t.env, PATH: empty, BASTRA_GIT_SHIM: "0" },
    ]) {
      t.edit();
      const r = t.run(["reset", "--hard"], { env });
      assert.equal(r.rc, 127);
      assert.deepEqual(r.err, ["bastra: no git found in PATH after bastra's shim — nothing was run"]);
      assert.deepEqual(r.out, []);
      assert.equal(t.read("a"), "unsaved\n");
    }
  });

  it("outside an allowed command: unknown subcommands, rebase, aliases, --git-dir run as the real git, with its exit code", () => {
    const t = fixture();
    const env = { ...t.env, BASTRA_RM_CALL: "" };
    t.git("config", "alias.wipe", "reset -q --hard");
    const cases: Array<[string[], number, () => void]> = [
      [["frobnicate"], 1, () => {}],
      [["rebase", "--abort"], 128, () => {}],
      [["-C", join(t.root, "nowhere"), "reset", "--hard"], 128, () => {}],
      [["wipe"], 0, () => assert.equal(t.read("a"), "one\n", "the alias ran")],
      [
        ["--git-dir", join(t.dir, ".git"), "--work-tree", t.dir, "reset", "-q", "--hard"],
        0,
        () => assert.equal(t.read("a"), "one\n", "the act ran"),
      ],
    ];
    for (const [argv, rc, then] of cases) {
      t.edit();
      const r = t.run(argv, { env });
      assert.equal(r.rc, rc, argv.join(" "));
      assert.deepEqual([r.out, r.err], [[], []], argv.join(" "));
      then();
    }
    assert.equal(t.pins(), "");
    assert.deepEqual(t.rows(), []);
  });

  it("inside an allowed command: the same forms are refused with exit 1 and today's message, nothing run", () => {
    const t = fixture();
    t.git("config", "alias.wipe", "reset -q --hard");
    t.edit();
    for (const argv of [
      ["frobnicate"],
      ["rebase", "main"],
      ["wipe"],
      ["--git-dir", join(t.dir, ".git"), "reset", "--hard"],
      ["reset", "--merge"],
      ["reset", "--keep"],
    ]) {
      const r = t.run(argv);
      assert.equal(r.rc, 1, argv.join(" "));
      assert.deepEqual(
        r.err,
        [
          `bastra: \`git ${argv.join(" ").slice(0, 120)}\` is not an act bastra's allow covers (as the shell expanded it) — not run (nothing changed). ${ASK}`,
        ],
        argv.join(" ")
      );
      assert.deepEqual(r.out, []);
      assert.equal(t.read("a"), "unsaved\n", argv.join(" "));
    }
    // The command shown is cut at 120 characters.
    assert.equal(
      t.run(["frobnicate", "x".repeat(200)]).err[0],
      `bastra: \`git frobnicate ${"x".repeat(109)}\` is not an act bastra's allow covers (as the shell expanded it) — not run (nothing changed). ${ASK}`
    );
    assert.deepEqual(t.rows(), []);
  });
});

describe("#1527 runGitShim characterization — where the act runs", () => {
  it("-C: the act runs in the directory it names, relative to the caller's and chained", () => {
    const t = fixture();
    mkdirSync(join(t.root, "x"));
    for (const argv of [
      ["-C", "w", "reset", "-q", "--hard"],
      ["-C", "x", "-C", "../w", "reset", "-q", "--hard"],
    ]) {
      t.edit();
      const r = t.run(argv, { cwd: t.root });
      assert.equal(r.rc, 0, argv.join(" "));
      assert.equal(t.read("a"), "one\n", argv.join(" "));
    }
    const rows = t.rows();
    assert.deepEqual(
      rows.map((r) => [r.action, r.orig, (r as unknown as { cwd: string }).cwd]),
      [
        ["pinned", t.dir, t.dir],
        ["pinned", t.dir, t.dir],
      ]
    );
  });

  it("not a repository: the real git says so with its exit code; nothing archived", () => {
    const t = fixture();
    const plain = join(t.root, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "u"), "u\n");
    for (const argv of [
      ["reset", "--hard"],
      ["clean", "-f"],
      ["branch", "-D", "x"],
    ]) {
      const r = t.run(argv, { cwd: plain });
      assert.equal(r.rc, 128, argv.join(" "));
      assert.deepEqual([r.out, r.err], [[], []], argv.join(" "));
    }
    assert.equal(readFileSync(join(plain, "u"), "utf8"), "u\n");
    assert.equal(existsSync(join(t.root, "archive")), false, "the archive was not even opened");
  });

  it("a clean tree: nothing to save, no pin, the act runs (exit 0)", () => {
    const t = fixture();
    for (const argv of [
      ["reset", "-q", "--hard"],
      ["checkout", "-q", "--", "a"],
      ["restore", "a"],
      ["stash", "clear"],
    ]) {
      const r = t.run(argv);
      assert.equal(r.rc, 0, argv.join(" "));
      assert.deepEqual([r.out, r.err], [[], []], argv.join(" "));
    }
    assert.equal(t.pins(), "");
    assert.deepEqual(t.rows(), []);
  });
});

describe("#1527 runGitShim characterization — what git decides itself", () => {
  it("a tree, path, branch or stash git cannot find: git's own error and exit code, nothing pinned", () => {
    const t = fixture();
    const cases: Array<[string[], number]> = [
      [["reset", "-q", "--hard", "nosuch"], 128],
      [["checkout", "nosuch", "--", "a"], 128],
      [["restore", "--source=nosuch", "a"], 128],
      [["checkout", "--", "nosuch"], 1],
      [["branch", "-D", "nosuch"], 1],
      [["stash", "drop", "-q", "stash@{5}"], 1],
    ];
    for (const [argv, rc] of cases) {
      t.edit();
      const r = t.run(argv);
      assert.equal(r.rc, rc, argv.join(" "));
      assert.deepEqual([r.out, r.err], [[], []], argv.join(" "));
      assert.equal(t.read("a"), "unsaved\n", argv.join(" "));
    }
    assert.equal(t.pins(), "");
    assert.deepEqual(t.rows(), []);
  });

  it("branch -D of a found and a missing name: the found one is pinned, git's exit code for the missing one", () => {
    const t = fixture();
    t.git("branch", "side");
    const r = t.run(["branch", "-D", "side", "nosuch"]);
    assert.equal(r.rc, 1);
    assert.deepEqual([r.out, r.err], [[], []]);
    assert.deepEqual(
      t.rows().map((x) => [x.action, x.act]),
      [["pinned", "git branch -D side"]]
    );
    assert.throws(() => t.git("rev-parse", "--verify", "-q", "refs/heads/side"));
  });

  it("git clean: a nested repository git skips stays, and only git's removals are printed", () => {
    const t = fixture();
    mkdirSync(join(t.dir, "nested"));
    execFileSync("git", ["init", "-q"], { cwd: join(t.dir, "nested"), env: t.env });
    writeFileSync(join(t.dir, "u"), "u\n");
    const r = t.run(["clean", "-fd"]);
    assert.equal(r.rc, 0);
    assert.deepEqual(r.out, ["Removing u"]);
    assert.deepEqual(r.err, []);
    assert.ok(existsSync(join(t.dir, "nested", ".git")));
    assert.deepEqual(
      t.rows().map((x) => [x.action, x.orig]),
      [["archived", join(t.dir, "u")]]
    );
  });
});

describe("#1527 runGitShim characterization — when saving fails, the act does not run", () => {
  it("an archive that cannot be opened: exit 1 before acting, for every kind of act", () => {
    const t = fixture();
    const env = { ...t.env, BASTRA_ARCHIVE_DIR: join(t.root, "a-file") };
    writeFileSync(join(t.root, "a-file"), "not a directory\n");
    t.git("branch", "side");
    writeFileSync(join(t.dir, "u"), "u\n");
    t.edit();
    for (const argv of [
      ["reset", "--hard"],
      ["clean", "-f"],
      ["branch", "-D", "side"],
      ["stash", "clear"],
    ]) {
      const r = t.run(argv, { env });
      assert.equal(r.rc, 1, argv.join(" "));
      assert.equal(r.err.length, 1, argv.join(" "));
      assert.match(
        r.err[0],
        new RegExp(`^bastra: .+ — \`git ${argv[0]}\` not run \\(nothing changed\\)\\. ${ASK.replace(/\./g, "\\.")}$`),
        argv.join(" ")
      );
      assert.deepEqual(r.out, []);
    }
    assert.equal(t.read("a"), "unsaved\n");
    assert.equal(t.read("u"), "u\n");
    assert.ok(t.git("rev-parse", "side"));
    assert.equal(t.pins(), "");
  });

  it("a pin that cannot be recorded: the ref is let go, exit 1 before acting, today's message per act", () => {
    const t = fixture();
    // The manifest is a directory: the row cannot be appended.
    mkdirSync(join(t.root, "archive", "manifest.jsonl"), { recursive: true, mode: 0o700 });
    chmodSync(join(t.root, "archive"), 0o700);
    t.git("branch", "side");
    writeFileSync(join(t.dir, "a"), "stashed\n");
    t.git("stash", "push", "-q");
    t.edit();
    const cases: Array<[string[], string]> = [
      [["reset", "--hard"], "could not pin the uncommitted changes — `git reset`"],
      [["checkout", "--", "a"], "could not pin the uncommitted changes — `git checkout`"],
      [["restore", "a"], "could not pin the uncommitted changes — `git restore`"],
      [["branch", "-D", "side"], "could not pin side — `git branch`"],
      [["stash", "drop"], "could not pin stash@{0} — `git stash`"],
      [["stash", "clear"], "could not pin stash@{0} — `git stash`"],
    ];
    for (const [argv, why] of cases) {
      const r = t.run(argv);
      assert.equal(r.rc, 1, argv.join(" "));
      assert.deepEqual(r.err, [`bastra: ${why} not run (nothing changed). ${ASK}`], argv.join(" "));
      assert.deepEqual(r.out, []);
    }
    assert.equal(t.read("a"), "unsaved\n");
    assert.ok(t.git("rev-parse", "side"));
    assert.equal(t.git("stash", "list", "--format=%gd"), "stash@{0}");
    assert.equal(t.pins(), "", "the refs made for the failed rows are gone");
  });

  it("an untracked file in the way that cannot be archived: exit 1 before acting, the file stays", () => {
    const t = fixture();
    writeFileSync(join(t.dir, "n"), "tracked later\n");
    t.git("add", "n");
    t.git("commit", "-qm", "c2");
    t.git("checkout", "-q", "-b", "old", "HEAD~1");
    writeFileSync(join(t.dir, "n"), "my notes\n");
    mkdirSync(join(t.root, "archive", "manifest.jsonl"), { recursive: true, mode: 0o700 });
    chmodSync(join(t.root, "archive"), 0o700);
    const errs: string[] = [];
    const rc = runGitShim(["reset", "-q", "--hard", "main"], {
      env: t.env,
      cwd: t.dir,
      out: () => {},
      err: (s) => errs.push(s),
    });
    assert.equal(rc, 1);
    assert.equal(
      errs.at(-1),
      `bastra: could not move ${join(t.dir, "n")} to the archive (git would overwrite it) — \`git reset\` not run (nothing changed). ${ASK}`
    );
    assert.equal(t.read("n"), "my notes\n");
    assert.equal(t.git("rev-parse", "--abbrev-ref", "HEAD"), "old");
  });
});

/** A `git` first in PATH that fails the call matching `when` the way `then`
 *  says (a sh case body), logs every call, and otherwise runs the real git. */
function failing(t: ReturnType<typeof fixture>, when: string, then: string) {
  const real = realGit(process.env);
  assert.ok(real);
  const bin = join(t.root, "failing");
  mkdirSync(bin);
  const log = join(t.root, "calls");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n  ${when}) ${then};;\nesac\nexec '${real}' "$@"\n`
  );
  chmodSync(join(bin, "git"), 0o755);
  return {
    env: { ...t.env, PATH: [bin, t.env.PATH].join(":") },
    calls: () => readFileSync(log, "utf8").trimEnd().split("\n"),
  };
}

describe("#1527 runGitShim characterization — when the shim's own git calls fail: git clean", () => {
  it("git clean: a dry run git refuses hands the act to the real git, with its exit code", () => {
    const t = fixture();
    writeFileSync(join(t.dir, "u"), "u\n");
    const f = failing(t, "*' clean -n'*|'clean -f'", "exit 3");
    const r = t.run(["clean", "-f"], { env: f.env });
    assert.equal(r.rc, 3);
    assert.deepEqual([r.out, r.err], [[], []]);
    assert.equal(f.calls().at(-1), "clean -f", "the act went to the real git");
    assert.equal(t.read("u"), "u\n");
    assert.deepEqual(t.rows(), []);
  });

  it("git clean: a dry-run line the shim cannot read is refused, nothing removed", () => {
    const t = fixture();
    writeFileSync(join(t.dir, "u"), "u\n");
    const f = failing(t, "*' clean -n'*", "printf 'Would remove u\\nSomething odd\\n'; exit 0");
    const r = t.run(["clean", "-f"], { env: f.env });
    assert.equal(r.rc, 1);
    assert.deepEqual(r.err, [
      `bastra: cannot read what git clean would remove (Something odd) — \`git clean\` not run (nothing changed). ${ASK}`,
    ]);
    assert.deepEqual(r.out, []);
    assert.equal(t.read("u"), "u\n");
    assert.deepEqual(t.rows(), []);
  });

  it("git clean: a path the archiving rm refuses gives exit 1; the others are archived and printed", () => {
    const t = fixture();
    writeFileSync(join(t.dir, "u"), "u\n");
    const f = failing(t, "*' clean -n'*", "printf 'Would remove u\\nWould remove ./\\n'; exit 0");
    const r = t.run(["clean", "-f"], { env: f.env });
    assert.equal(r.rc, 1);
    assert.deepEqual(r.out, ["Removing u"]);
    assert.deepEqual(r.err, ["rm: refusing to remove '.' or '..' directory: skipping '.'"]);
    assert.equal(t.read("u"), null);
    assert.deepEqual(
      t.rows().map((x) => [x.action, x.orig]),
      [["archived", join(t.dir, "u")]]
    );
    assert.ok(!f.calls().includes("clean -f"), "the real git clean never runs");
  });
});

describe("#1527 runGitShim characterization — when the shim's own git calls fail: the other acts", () => {
  it("git stash create failing for no reason the shim names: today's fallback message, nothing run", () => {
    const t = fixture();
    t.edit();
    const f = failing(t, "*' stash create'", "exit 1");
    const r = t.run(["reset", "--hard"], { env: f.env });
    assert.equal(r.rc, 1);
    assert.deepEqual(r.err, [
      `bastra: could not save the uncommitted changes first — \`git reset\` not run (nothing changed). ${ASK}`,
    ]);
    assert.deepEqual(r.out, []);
    assert.equal(t.read("a"), "unsaved\n");
    assert.equal(t.pins(), "");
  });

  it("git diff failing: what the act would overwrite or discard cannot be listed, so it does not run", () => {
    const cases: Array<[string[], string, string]> = [
      [["reset", "--hard", "HEAD"], "*--diff-filter=D*", "could not list what the act would overwrite — `git reset`"],
      [["restore", "a"], "*--diff-filter=AMT*", "could not list what the act would discard — `git restore`"],
      [
        ["checkout", "HEAD", "--", "a"],
        "*--diff-filter=AMT*",
        "could not list what the act would discard — `git checkout`",
      ],
    ];
    for (const [argv, when, why] of cases) {
      const t = fixture();
      t.edit();
      const f = failing(t, when, "exit 1");
      const r = t.run(argv, { env: f.env });
      assert.equal(r.rc, 1, argv.join(" "));
      assert.deepEqual(r.err, [`bastra: ${why} not run (nothing changed). ${ASK}`], argv.join(" "));
      assert.deepEqual(r.out, []);
      assert.equal(t.read("a"), "unsaved\n", argv.join(" "));
      assert.equal(t.pins(), "", argv.join(" "));
    }
  });

  it("a pin ref that cannot be created: 51 tries, then refused, nothing recorded", () => {
    const t = fixture();
    t.edit();
    const f = failing(t, "*' update-ref refs/bastra-archive/'*", "exit 1");
    const r = t.run(["reset", "--hard"], { env: f.env });
    assert.equal(r.rc, 1);
    assert.deepEqual(r.err, [
      `bastra: could not pin the uncommitted changes — \`git reset\` not run (nothing changed). ${ASK}`,
    ]);
    assert.equal(f.calls().filter((c) => c.includes(" update-ref refs/bastra-archive/")).length, 51);
    assert.equal(t.read("a"), "unsaved\n");
    assert.deepEqual(t.rows(), []);
  });

  it("the real git killed by a signal: exit 1", () => {
    const t = fixture();
    const env = { ...t.env, BASTRA_RM_CALL: "" };
    for (const argv of [["frobnicate"], ["reset", "-q", "--hard"]]) {
      const f = failing({ ...t, root: mkdtempSync(join(t.root, "k-")) }, `'${argv.join(" ")}'`, "kill -9 $$");
      const r = t.run(argv, { env: { ...env, PATH: f.env.PATH } });
      assert.equal(r.rc, 1, argv.join(" "));
      assert.deepEqual([r.out, r.err], [[], []], argv.join(" "));
    }
  });
});

describe("#1527 runGitShim characterization — the order: save, record, then the real git", () => {
  /** A `git` first in PATH that, when the act itself arrives, copies the manifest
   *  and the pinned refs as they are at that moment, then runs the real git. */
  function spy(t: ReturnType<typeof fixture>, act: string) {
    const real = realGit(process.env);
    assert.ok(real);
    const bin = join(t.root, "spy");
    mkdirSync(bin);
    const seen = join(t.root, "seen");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = '${act}' ]; then\n` +
        `  cat '${join(t.root, "archive", "manifest.jsonl")}' > '${seen}' 2>/dev/null\n` +
        `  '${real}' for-each-ref --format='%(refname)' refs/bastra-archive >> '${seen}'\nfi\nexec '${real}' "$@"\n`
    );
    chmodSync(join(bin, "git"), 0o755);
    return { env: { ...t.env, PATH: [bin, t.env.PATH].join(":") }, seen: () => readFileSync(seen, "utf8") };
  }

  it("reset --hard over an untracked file: the pin and then the archived file are recorded before git runs", () => {
    const t = fixture();
    writeFileSync(join(t.dir, "n"), "tracked later\n");
    t.git("add", "n");
    t.git("commit", "-qm", "c2");
    t.git("checkout", "-q", "-b", "old", "HEAD~1");
    writeFileSync(join(t.dir, "n"), "my notes\n");
    t.edit();
    const s = spy(t, "reset -q --hard main");
    assert.equal(t.run(["reset", "-q", "--hard", "main"], { env: s.env }).rc, 0);
    const [pinRow, archRow, ref, ...more] = s.seen().trim().split("\n");
    assert.equal(JSON.parse(pinRow).action, "pinned");
    assert.equal(JSON.parse(archRow).action, "archived");
    assert.equal(JSON.parse(archRow).orig, join(t.dir, "n"));
    assert.match(ref, /^refs\/bastra-archive\/reset\//);
    assert.deepEqual(more, []);
    assert.equal(t.read("n"), "tracked later\n");
  });

  it("branch -D and stash drop: the ref and its row exist when git runs", () => {
    for (const [argv, setup] of [
      [["branch", "-D", "side"], (t: ReturnType<typeof fixture>) => t.git("branch", "side")],
      [
        ["stash", "drop", "-q"],
        (t: ReturnType<typeof fixture>) => {
          t.edit();
          t.git("stash", "push", "-q");
        },
      ],
    ] as Array<[string[], (t: ReturnType<typeof fixture>) => void]>) {
      const t = fixture();
      setup(t);
      const s = spy(t, argv.join(" "));
      assert.equal(t.run(argv, { env: s.env }).rc, 0, argv.join(" "));
      const [row, ref, ...more] = s.seen().trim().split("\n");
      assert.equal(JSON.parse(row).action, "pinned", argv.join(" "));
      assert.equal(JSON.parse(row).dest, ref, argv.join(" "));
      assert.deepEqual(more, [], argv.join(" "));
    }
  });
});
