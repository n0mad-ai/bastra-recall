/**
 * #650/#651: reversible defaults. The pattern table (`bash-pre-patterns.ts`)
 * declares per destructive row what the hint may say instead of STOP; these
 * tests iterate that table, so a new row is covered — or red — without anybody
 * remembering to add a case.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { matchPattern, formatHintBlock, runBashPreLane, reversibleDefault, DESTRUCTIVE_PATTERNS } from "../src/bash-pre-lane.js";

const RM = { BASTRA_RM_ARCHIVES: "1" };

/** Apply env vars; the returned function puts the previous values back. */
function setEnv(env: Record<string, string>): () => void {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const restore = setEnv(env);
  try {
    return fn();
  } finally {
    restore();
  }
}

/** The lane in-process; recall is unreachable (port 1), which the hint does not need. */
async function runHook(payload: object, env: Record<string, string>): Promise<string> {
  const restore = setEnv({ BASTRA_TELEMETRY: "off", ...env });
  try {
    return await runBashPreLane(payload as Parameters<typeof runBashPreLane>[0], "http://127.0.0.1:1");
  } finally {
    restore();
  }
}

async function readTelemetryEvents(dir: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}


/** What the agent reads for a command: the hint kind and the pattern it names. */
async function hintOf(command: string, env: Record<string, string> = {}, surface = "claude-code") {
  const stdout = await runHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "", bastra_client: surface },
    env,
  );
  const block: string = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext ?? "";
  const pattern = /pattern: `([^`]+)`/.exec(block)?.[1] ?? "";
  if (/STOP — destructive/.test(block)) return { kind: "stop", pattern };
  if (/REVERSIBLE FORM/.test(block)) return { kind: "reversible-form", pattern };
  if (/NOTE — reversible/.test(block)) return { kind: "receipt", pattern };
  return { kind: "none", pattern };
}

/** The table split the way a host with `env` sees it. */
function sides(env: Record<string, string>) {
  return withEnv(env, () => {
    const withUndo = DESTRUCTIVE_PATTERNS.filter((p) => reversibleDefault(p.label, "claude-code") !== null);
    const without = DESTRUCTIVE_PATTERNS.filter((p) => reversibleDefault(p.label, "claude-code") === null);
    const kinds = new Map(withUndo.map((p) => [p.label, reversibleDefault(p.label, "claude-code")?.kind]));
    return { withUndo, without, kind: (label: string) => kinds.get(label) };
  });
}

/** One real command per destructive row — the generated tests compose these. */
const EXAMPLE: Record<string, string> = {
  "rm -rf": "rm -rf build",
  "rm -r": "rm -r build",
  rmdir: "rmdir empty",
  "git reset --hard": "git reset --hard origin/main",
  "git checkout --": "git checkout -- src",
  "git clean -f": "git clean -fd",
  "git branch -D": "git branch -D old",
  "git push --delete": "git push origin --delete old",
  "git push --force-with-lease": "git push --force-with-lease origin main",
  "git push --force": "git push --force origin main",
  "git push -f": "git push -f origin main",
  "git push +refspec": "git push origin +main",
  "git commit --amend": "git commit --amend --no-edit",
  "git reflog expire": "git reflog expire --expire=now --all",
  "git reflog delete": "git reflog delete HEAD@{1}",
  "git gc --prune": "git gc --prune=now",
  "git -c gc.*Expire": "git -c gc.pruneExpire=now gc",
  "git config gc.*Expire": "git config gc.reflogExpire now",
  "gh repo delete": "gh repo delete me/prod --yes",
  "gh release delete": "gh release delete v1 --yes",
  "npm uninstall": "npm uninstall left-pad",
  "npm rm": "npm rm left-pad",
  "yarn remove": "yarn remove left-pad",
  "pnpm rm": "pnpm remove left-pad",
  "DROP TABLE": "psql -c 'DROP TABLE users'",
  "DROP DATABASE": "psql -c 'DROP DATABASE prod'",
  "TRUNCATE TABLE": "psql -c 'TRUNCATE TABLE users'",
  "docker rm": "docker rm -f db",
  "docker volume rm": "docker volume rm data",
  "kubectl delete": "kubectl delete ns prod",
};

// `&` is not a segment separator — both acts then sit in one segment.
const SEPARATORS = [";", " && ", " || ", " & ", " | ", "\n"];

describe("#650 reversible defaults — the table", () => {
  it("every destructive row has an example command, and the example trips that row first", () => {
    // Revert-check: add a row to DESTRUCTIVE_PATTERNS → red here, naming it,
    // before the generated tests below could silently leave it out.
    for (const { label } of DESTRUCTIVE_PATTERNS) {
      assert.ok(EXAMPLE[label], `${label}: no example command`);
      assert.equal(matchPattern(EXAMPLE[label])?.label, label, EXAMPLE[label]);
    }
  });

  it("the hint says what the row declares: receipt, the reversible form, or STOP", () => {
    // Revert-check: swap the receipt and form branches in formatHintBlock → red.
    for (const env of [{}, RM]) {
      const { withUndo, without, kind } = sides(env);
      assert.ok(withUndo.length > 0 && without.length > 0, "both sides non-empty");
      withEnv(env, () => {
        for (const { label } of withUndo) {
          const out = formatHintBlock(label, "destructive", []);
          if (kind(label) === "receipt") {
            assert.match(out, /NOTE — reversible/, label);
            assert.doesNotMatch(out, /STOP/, label);
            // The block ends "No confirmation needed" — a receipt whose own text
            // asks to confirm in some case contradicts it (#651 review).
            assert.doesNotMatch(reversibleDefault(label, "claude-code")!.text, /confirm/i, label);
          } else {
            assert.match(out, /REVERSIBLE FORM/, label);
            assert.match(out, /bare command keeps the rule: explicit user confirmation/, label);
          }
        }
        for (const { label } of without) assert.match(formatHintBlock(label, "destructive", []), /STOP — destructive/, label);
      });
    }
  });

  it("an undo that needs the archiving rm exists only on claude-code with BASTRA_RM_ARCHIVES", () => {
    // Revert-check: drop the needsArchivingRm gate in reversibleDefault → red.
    const gated = DESTRUCTIVE_PATTERNS.filter((p) => p.undo?.needsArchivingRm);
    assert.deepEqual(gated.map((p) => p.label), ["rm -rf", "rm -r", "git clean -f"]);
    for (const { label } of gated) {
      assert.equal(reversibleDefault(label, "claude-code"), null, `${label} without the flag`);
      withEnv(RM, () => {
        assert.notEqual(reversibleDefault(label, "claude-code"), null, `${label} with the flag`);
        assert.equal(reversibleDefault(label, "codex"), null, `${label} on codex`);
      });
    }
  });

  it("the archive receipt names the archive, and codex or no flag keep STOP", async () => {
    assert.match(withEnv(RM, () => formatHintBlock("rm -rf", "destructive", [])), /archives instead of deleting/);
    assert.equal((await hintOf("rm -rf build", RM, "codex")).kind, "stop");
    assert.equal((await hintOf("rm -rf build")).kind, "stop");
  });
});

// The hint text is a claim about git. These run the claim — the same command
// bare and in the named form, compared — so a recipe that changes what the
// caller observes, or does not bring the work back, is red here and not in
// somebody's lost afternoon.
describe("#650 reversible defaults — every undo row's recipe, run in a real repo", () => {
  const repo = async () => {
    const dir = await mkdtemp(join(tmpdir(), "bash-pre-undo-"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    await writeFile(join(dir, "a"), "one\n");
    git("add", "a");
    git("commit", "-qm", "c1");
    return { dir, git, read: (f: string) => readFile(join(dir, f), "utf8").catch(() => null) };
  };
  type Repo = Awaited<ReturnType<typeof repo>>;
  const twins = async (): Promise<[Repo, Repo]> => [await repo(), await repo()];
  const drop = (...rs: Repo[]) => Promise.all(rs.map((r) => rm(r.dir, { recursive: true, force: true })));
  const listing = (r: Repo) => r.git("status", "--porcelain", "--untracked-files=all", "--ignored");

  /** Push through a local bare remote; B is a stale second clone of it. */
  const pushSetup = async () => {
    const a = await repo();
    const remote = await mkdtemp(join(tmpdir(), "bash-pre-undo-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    a.git("remote", "add", "origin", remote);
    a.git("push", "-q", "-u", "origin", "HEAD:main");
    return { a, remote, done: async () => (await drop(a), await rm(remote, { recursive: true, force: true })) };
  };

  const leaseProof = async () => {
    const { a, remote, done } = await pushSetup();
    // Nobody else pushed: the lease overwrites, and the old tip stays in the reflog.
    const old = a.git("rev-parse", "HEAD");
    a.git("commit", "-q", "--amend", "-m", "rewritten");
    a.git("push", "-q", "--force-with-lease", "origin", "HEAD:main");
    assert.equal(a.git("ls-remote", remote, "main").split("\t")[0], a.git("rev-parse", "HEAD"));
    assert.match(a.git("reflog", "--format=%H", "origin/main"), new RegExp(old));
    // Someone pushed since our fetch: the lease refuses, the remote is untouched.
    const b = await repo();
    b.git("fetch", "-q", remote, "main:refs/remotes/origin/main");
    a.git("commit", "-q", "--allow-empty", "-m", "theirs");
    a.git("push", "-q", "origin", "HEAD:main");
    const theirs = a.git("rev-parse", "HEAD");
    b.git("remote", "add", "origin", remote);
    assert.throws(() => b.git("push", "-q", "--force-with-lease", "origin", "HEAD:main"));
    assert.equal(a.git("ls-remote", remote, "main").split("\t")[0], theirs);
    await drop(b);
    await done();
  };

  /** Keyed by label. A new undo row without an entry here (or in NOT_RUN_HERE) is red. */
  const PROOFS: Record<string, () => Promise<void>> = {
    "git reset --hard": async () => {
      // c2 tracks `u`; HEAD is back at c1 with `u` untracked in the way, `v`
      // untracked elsewhere, and a tracked edit — every case the text names.
      const [bare, form] = await twins();
      for (const r of [bare, form]) {
        await writeFile(join(r.dir, "u"), "c2\n");
        r.git("add", "u");
        r.git("commit", "-qm", "c2");
        r.git("reset", "-q", "--hard", "HEAD~1");
        await writeFile(join(r.dir, "u"), "mine\n");
        await writeFile(join(r.dir, "v"), "mine\n");
        await writeFile(join(r.dir, "a"), "edited\n");
      }
      const [bareTarget, formTarget] = [bare, form].map((r) => r.git("rev-parse", "HEAD@{1}"));
      bare.git("reset", "-q", "--hard", bareTarget);
      form.git("stash", "push", "-q");
      form.git("reset", "-q", "--hard", formTarget);
      for (const f of ["a", "u", "v"]) assert.equal(await form.read(f), await bare.read(f), `same end state: ${f}`);
      assert.equal(await form.read("u"), "c2\n", "the untracked file in the way is overwritten either way");
      assert.equal(await form.read("v"), "mine\n", "an untracked file not in the way survives");
      form.git("stash", "pop", "-q");
      assert.equal(await form.read("a"), "edited\n", "stash pop brings the tracked edit back");
      await drop(bare, form);
    },
    "git checkout --": async () => {
      const [bare, form] = await twins();
      for (const r of [bare, form]) {
        await writeFile(join(r.dir, "a"), "staged\n");
        r.git("add", "a");
        await writeFile(join(r.dir, "a"), "unstaged\n");
      }
      bare.git("checkout", "--", "a");
      form.git("stash", "push", "-q", "--keep-index", "--", "a");
      assert.equal(await form.read("a"), await bare.read("a"));
      assert.equal(form.git("diff", "--cached"), bare.git("diff", "--cached"));
      // `stash pop` would conflict here (staged + unstaged in one path) — the
      // hint names restore --worktree, which puts back exactly the lost part.
      form.git("restore", "--source=stash@{0}", "--worktree", "--", "a");
      assert.equal(await form.read("a"), "unstaged\n");
      assert.equal(form.git("show", ":a"), "staged", "index untouched by the undo");
      await drop(bare, form);
    },
    "git clean -f": async () => {
      // A plain recursive remove stands in for the archiving rm: the claim
      // here is that the dry run lists exactly what the bare clean removes.
      const [bare, form] = await twins();
      for (const r of [bare, form]) {
        await writeFile(join(r.dir, ".gitignore"), "ignored\n");
        await writeFile(join(r.dir, "loose"), "x\n");
        await writeFile(join(r.dir, "ignored"), "x\n");
        await mkdir(join(r.dir, "d"));
        await writeFile(join(r.dir, "d", "f"), "x\n");
        await writeFile(join(r.dir, "a"), "tracked edit\n");
      }
      assert.ok(listing(bare).includes("?? loose"), "precondition: there is something to clean");
      bare.git("clean", "-f", "-d");
      const listed = form.git("clean", "-n", "-f", "-d").split("\n").map((l) => l.replace(/^Would remove /, ""));
      assert.ok(listed.length > 0 && existsSync(join(form.dir, "loose")), "-n wins over -f: nothing removed yet");
      for (const p of listed) await rm(join(form.dir, p), { recursive: true });
      assert.equal(listing(form), listing(bare));
      await drop(bare, form);
    },
    "git branch -D": async () => {
      const r = await repo();
      // Reachable from HEAD: `-d` does what `-D` does, and the printed sha restores it.
      r.git("branch", "merged");
      const was = /\(was ([0-9a-f]+)\)/.exec(r.git("branch", "-d", "merged"))?.[1];
      assert.ok(was, "git prints (was <sha>)");
      assert.throws(() => r.git("rev-parse", "--verify", "-q", "merged"), "deleted");
      r.git("branch", "merged", was);
      assert.equal(r.git("rev-parse", "merged"), r.git("rev-parse", "HEAD"));
      // Commits nothing else reaches: `-d` refuses and the branch stays.
      r.git("checkout", "-q", "-b", "alone");
      r.git("commit", "-q", "--allow-empty", "-m", "only here");
      r.git("checkout", "-q", "main");
      assert.throws(() => r.git("branch", "-d", "alone"));
      assert.ok(r.git("rev-parse", "--verify", "alone"));
      await drop(r);
    },
    "git commit --amend": async () => {
      const r = await repo();
      const before = r.git("rev-parse", "HEAD");
      r.git("commit", "-q", "--amend", "-m", "c1 amended");
      assert.notEqual(r.git("rev-parse", "HEAD"), before);
      r.git("reset", "--soft", "HEAD@{1}");
      assert.equal(r.git("rev-parse", "HEAD"), before);
      await drop(r);
    },
    "git push --force-with-lease": leaseProof,
    "git push --force": leaseProof,
    "git push -f": leaseProof,
    "git push +refspec": leaseProof,
  };
  /** Undo rows whose recipe is not this repo's to run — the hole, named. */
  const NOT_RUN_HERE: Record<string, string> = {
    "rm -rf": "the archive is the host's rm shim (#650), installed outside this repo",
    "rm -r": "the archive is the host's rm shim (#650), installed outside this repo",
  };
  // Push proofs push to a local bare repo; the name marks them so a host that
  // gates `git push` can leave them out (`--test-skip-pattern "runs git push"`).
  const title = (label: string) => (label.startsWith("git push") ? `${label} (runs git push to a local bare repo)` : label);

  const rows = withEnv(RM, () => DESTRUCTIVE_PATTERNS.filter((p) => reversibleDefault(p.label, "claude-code")));
  it("there are undo rows to prove, and every proof belongs to one", () => {
    assert.ok(rows.length > 0);
    for (const label of Object.keys(PROOFS)) assert.ok(rows.some((p) => p.label === label), `${label}: stale proof`);
  });
  for (const { label } of rows) {
    if (NOT_RUN_HERE[label]) it(label, { skip: NOT_RUN_HERE[label] }, () => {});
    else it(title(label), PROOFS[label] ?? (() => assert.fail(`${label}: an undo row without a proof`)));
  }

  it("git push --delete (runs git push to a local bare repo): the remote-tracking ref and its reflog go with it — no receipt", async () => {
    const { a, done } = await pushSetup();
    a.git("push", "-q", "origin", "HEAD:old");
    assert.ok(a.git("reflog", "--format=%H", "origin/old"));
    a.git("push", "-q", "--force-with-lease", "origin", ":old");
    assert.throws(() => a.git("reflog", "--format=%H", "origin/old"));
    await done();
  });
});

describe("#651 review — the hint weighs the whole command, not the first row in the table", () => {
  // Generated from the table on both hosts: every pair of rows, every
  // separator, both orders. Revert-check: make hintFor return the first
  // match's own undo → hundreds of pairs read "No confirmation needed".
  for (const [host, env] of [["no opt-in", {}], ["rm archives", RM]] as const) {
    it(`${host}: an act with an undo next to one without is STOP, naming the one without`, async () => {
      const { withUndo, without } = sides(env);
      assert.ok(withUndo.length > 0 && without.length > 0);
      for (const u of withUndo) {
        for (const n of without) {
          for (const sep of SEPARATORS) {
            for (const cmd of [EXAMPLE[u.label] + sep + EXAMPLE[n.label], EXAMPLE[n.label] + sep + EXAMPLE[u.label]]) {
              assert.deepEqual(await hintOf(cmd, env), { kind: "stop", pattern: n.label }, JSON.stringify(cmd));
            }
          }
        }
      }
    });

    it(`${host}: two acts with undos are one receipt only when both are receipts`, async () => {
      const { withUndo, kind } = sides(env);
      assert.ok(withUndo.length > 1);
      for (const a of withUndo) {
        for (const b of withUndo) {
          if (a === b) continue;
          const want = kind(a.label) === "receipt" && kind(b.label) === "receipt" ? "receipt" : "stop";
          for (const sep of SEPARATORS) {
            const cmd = EXAMPLE[a.label] + sep + EXAMPLE[b.label];
            assert.equal((await hintOf(cmd, env)).kind, want, JSON.stringify(cmd));
          }
        }
      }
    });
  }

  it("telemetry's hint_kind is what the block said, for the whole command (#614 counts STOP rows by it)", async () => {
    // Revert-check: record the first label's own undo kind → the chained row
    // logs "reversible-form" under a STOP block and goes red.
    const logDir = await mkdtemp(join(tmpdir(), "bastra-bashpre-hintkind-"));
    const want: Array<[string, string | null]> = [
      ["git branch -D old && gh repo delete me/prod --yes", "stop"],
      ["git commit --amend --no-edit", "receipt"],
      ["git reset --hard origin/main", "reversible-form"],
      ["chmod -R 777 build", null],
    ];
    try {
      for (const [command] of want) {
        await runHook(
          { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "" },
          { BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir },
        );
      }
      const logged = (await readTelemetryEvents(logDir)).filter((e) => e.kind === "bash_hook_call").map((e) => e.hint_kind);
      assert.deepEqual(logged, want.map(([, kind]) => kind));
      assert.equal((await hintOf(want[0][0])).kind, "stop", "the block for the chained row");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("one push that both leases and deletes, or leases and forces, is STOP", async () => {
    // Revert-check: remove the `git push --delete` row → the delete reads as a lease receipt.
    assert.deepEqual(await hintOf("git push --force-with-lease origin :old"), { kind: "stop", pattern: "git push --delete" });
    assert.equal((await hintOf("git push --force-with-lease --prune origin")).kind, "stop");
    assert.equal((await hintOf("git push --force-with-lease --force origin main")).kind, "stop");
    // Revert-check: remove the `git push +refspec` row → the `+` force reads as a lease receipt.
    assert.deepEqual(await hintOf("git push --force-with-lease origin +main"), { kind: "stop", pattern: "git push +refspec" });
    assert.equal((await hintOf("git push --force-with-lease origin +HEAD:main")).kind, "stop");
    // …and a plain lease, or a push to a refspec with a colon inside, stays what it is.
    assert.equal((await hintOf("git push --force-with-lease origin HEAD:main")).kind, "receipt");
    assert.equal(matchPattern("git push origin HEAD:refs/heads/main"), null);
    assert.equal(matchPattern("git push https://example.com/r.git main"), null);
  });

  it("#658: removing the reflog turns a reflog-based receipt into STOP", async () => {
    // Revert-check: drop the reflog/gc rows → the amend receipt is shown although
    // the same line deletes the reflog entry it points to.
    assert.deepEqual(
      await hintOf("git commit --amend; git reflog expire --expire=now --all; git gc --prune=now"),
      { kind: "stop", pattern: "git reflog expire" },
    );
    assert.equal((await hintOf("git commit --amend --no-edit && git gc --prune=now")).kind, "stop");
    assert.equal((await hintOf("git branch -D old; git reflog delete HEAD@{1}")).kind, "stop");
    assert.equal(matchPattern("git gc --prune=never"), null);
    assert.equal(matchPattern("git gc"), null);
  });

  it("#658: the same expiry set through config turns the receipt into STOP too", async () => {
    // Revert-check: drop the two gc.*Expire rows → each amend line below gets
    // the receipt although its gc removes the pre-amend commit for good.
    for (const cmd of [
      "git commit --amend --no-edit; git -c gc.reflogExpire=now -c gc.reflogExpireUnreachable=now -c gc.pruneExpire=now gc",
      "git commit --amend --no-edit; git -c gc.reflogExpire=now -c gc.pruneExpire=now maintenance run --task=gc",
      "git commit --amend --no-edit; git config gc.reflogExpire now; git config gc.pruneExpire now; git gc",
      "git commit --amend --no-edit; git -C repo config --local GC.PRUNEEXPIRE now; git gc",
    ]) {
      assert.equal((await hintOf(cmd)).kind, "stop", cmd);
    }
    assert.equal(matchPattern("git -c gc.pruneExpire=never gc"), null);
    assert.equal(matchPattern("git config gc.reflogExpire never"), null);
    assert.equal(matchPattern("git config gc.auto 0"), null);
  });

  it("#658: several receipts in one command are all said, each once", async () => {
    // Revert-check: return acts[0].undo → the amend note is missing.
    const stdout = await runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit --amend --no-edit && git push --force-with-lease origin main" },
        session_id: "",
      },
      {},
    );
    const block: string = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext ?? "";
    assert.match(block, /NOTE — reversible/);
    assert.match(block, /git reset --soft HEAD@\{1\}/, "the amend receipt");
    assert.match(block, /the lease refuses/, "the lease receipt");
    const rmStdout = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf a && rm -r b" }, session_id: "" },
      RM,
    );
    const rmBlock: string = JSON.parse(rmStdout)?.hookSpecificOutput?.additionalContext ?? "";
    assert.equal(rmBlock.split("archives instead of deleting").length - 1, 1, "one rm receipt, not two");
  });

  it("git global options before the subcommand do not hide it", () => {
    // Revert-check: drop `(?:\s+-[Cc]\s+\S+)*` from the git() helper → red.
    assert.equal(matchPattern("git -C ../other push --force origin main")?.label, "git push --force");
    assert.equal(matchPattern("git -c core.hooksPath=/dev/null reset --hard")?.label, "git reset --hard");
    assert.equal(matchPattern("git clean -d --force")?.label, "git clean -f");
    assert.deepEqual(matchPattern("find . -name '*.o' -delete"), { label: "find ... -delete", severity: "risky" });
  });

  // Revert-check: make rmRunsThroughPath return true → every row here reads
  // "archives instead of deleting" and goes red.
  it("rm archives only where this shell's PATH picks the rm: sudo, absolute paths, remote and wrapped rm keep STOP", async () => {
    for (const cmd of [
      "sudo rm -rf /opt/app",
      "/bin/rm -rf ~/work",
      "/usr/bin/rm -r build",
      "ssh prod rm -rf /srv/data",
      'ssh prod "cd /srv; rm -rf data"',
      "docker exec db rm -rf /var/lib/postgresql",
      "kubectl exec pod -- rm -rf /data",
      "git rm -rf src",
      "find . -name tmp -exec rm -rf {} +",
      'bash -c "rm -rf build"',
      "env -i rm -rf build",
      "PATH=/usr/bin rm -rf build",
      "ssh prod bash <<'EOF'\nrm -rf /srv/data\nEOF",
      "rm -rf $(cat list.txt)",
      // #657: the same command changes what `rm` resolves to.
      "export PATH=/bin:$PATH; rm -rf x",
      "PATH=/bin; rm -rf x",
      "alias rm=/bin/rm; rm -rf x",
      'rm() { /bin/rm "$@"; }; rm -rf x',
      "function rm { /bin/rm \"$@\"; }; rm -rf x",
      // …also inside a quoted eval, or by pinning the hash table entry.
      "eval 'rm(){ /bin/rm \"$@\"; }'; rm -rf x",
      'eval "rm(){ /bin/rm \\"\\$@\\"; }"; rm -rf x',
      "hash -p /bin/rm rm; rm -rf x",
    ]) {
      assert.equal((await hintOf(cmd, RM)).kind, "stop", cmd);
    }
  });

  it("…and the plain local forms keep their receipt (no new false STOP)", async () => {
    for (const cmd of [
      "rm -rf build",
      "cd pkg && rm -rf node_modules dist",
      "\\rm -rf x",
      '"rm" -rf x',
      "command rm -rf x",
      "find . -name '*.o' | xargs rm -rf",
      "rm -rf a && rm -r b",
      'rm -rf "$TMPDIR/x"',
    ]) {
      assert.equal((await hintOf(cmd, RM)).kind, "receipt", cmd);
    }
  });
});
