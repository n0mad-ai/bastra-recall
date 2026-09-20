/**
 * Getting one commit's tree onto disk, with its dependencies, without touching
 * the source repository (#582, #606).
 *
 * Split out of `mine-repo.mjs`, which had grown past the size ceiling and was
 * carrying two jobs: deciding which changes become scenarios, and materialising
 * the trees that decision is made on. This is the second one. It is also the
 * half that talks to the process table — `git archive`, `tar`, symlinks — and
 * keeping it apart is what let the pipe failure below get its own test.
 *
 * Everything here READS the source repository. No git worktree is created, no
 * index is touched, nothing is written outside `dir`.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * `producer | consumer`, as a promise that REJECTS on every way it can fail.
 *
 * The ChildProcess `error` event is the spawn failing. The pipe's own failure
 * is an `error` on the STREAMS, and node throws an unhandled one of those out
 * of the event loop: it does not reject anything, it ends the process. That is
 * what killed the first tests/v2 mining pass after two and a half hours at 732
 * of roughly a thousand candidates — `write EPIPE`, the consumer having closed
 * the stdin the producer was still writing to. The remaining candidates were
 * never decided, and the population looked finished because the accepted count
 * had stopped moving anyway. Routed into the promise, the failure reaches the
 * per-candidate `catch` in the worker loop instead: one candidate is recorded
 * as not evaluable and the run carries on.
 *
 * Both children are killed on settle. A consumer that died leaves the producer
 * writing into nothing, and one leaked process per failed candidate across
 * four workers and a thousand candidates is not a leak anybody notices until
 * it matters.
 */
export function pipeSpawn(producer, consumer, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      producer.kill("SIGKILL");
      consumer.kill("SIGKILL");
      fn(arg);
    };
    const ok = done(resolve);
    const no = done(reject);
    const fail = (where) => (e) => no(new Error(`${label}: ${where} ${e?.message ?? e}`));
    producer.stdout.pipe(consumer.stdin);
    let err = "";
    producer.stderr.on("data", (d) => (err += d));
    consumer.stderr.on("data", (d) => (err += d));
    consumer.on("close", (code) => (code === 0 ? ok() : no(new Error(`${label}: ${err.slice(0, 300)}`))));
    producer.on("error", fail("producer"));
    consumer.on("error", fail("consumer"));
    producer.stdout.on("error", fail("producer stdout"));
    consumer.stdin.on("error", fail("consumer stdin"));
  });
}

/**
 * One commit's tree, extracted. NEVER a git worktree: `git archive` reads the
 * object store and writes nothing, so the source repository is untouched even
 * while several of these run at once.
 */
export async function extractTree(repo, profile, sha, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Streamed, not buffered: `execFile`'s options have no `input` (that is
  // `execFileSync`), so a buffered version leaves tar waiting on a stdin that
  // never closes — it hangs forever instead of failing.
  await pipeSpawn(
    spawn("git", ["archive", "--format=tar", sha], { cwd: repo }),
    spawn("tar", ["-x", "-C", dir]),
    `extract ${sha}`,
  );
  linkNodeModules(repo, profile, dir);
}

/**
 * Dependencies without a network and without writing to the source repository:
 * every top-level entry of the original `node_modules` is symlinked in, EXCEPT
 * the workspace scopes — those are pointed at the extracted tree, so a change
 * to a package is seen by everything that imports it.
 *
 * Per-package `node_modules` are linked too. Measured on bastra-io: without
 * them the app's typecheck reports 331 errors on an unmodified tree, because
 * a package's own dependencies cannot resolve from the extracted copy.
 */
export function linkNodeModules(repo, profile, dir) {
  const link = (from, to) => {
    if (!existsSync(from)) return;
    try {
      if (lstatSync(to)) rmSync(to, { recursive: true, force: true });
    } catch {
      /* not there yet */
    }
    symlinkSync(from, to);
  };

  const rootModules = join(repo, "node_modules");
  if (existsSync(rootModules)) {
    const target = join(dir, "node_modules");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(rootModules)) {
      if (profile.scopes.includes(entry)) continue;
      link(join(rootModules, entry), join(target, entry));
    }
    // pnpm keeps the real packages in `.pnpm`; without it every link dangles.
    for (const hidden of [".pnpm", ".bin", ".modules.yaml"]) {
      link(join(rootModules, hidden), join(target, hidden));
    }
    for (const scope of profile.scopes) {
      const scopeDir = join(target, scope);
      mkdirSync(scopeDir, { recursive: true });
      for (const [pkgDir, name] of profile.packageNames) {
        if (!name.startsWith(`${scope}/`)) continue;
        link(join(dir, pkgDir), join(scopeDir, name.slice(scope.length + 1)));
      }
    }
  }

  for (const pkgDir of profile.packageDirs) {
    const from = join(repo, pkgDir, "node_modules");
    const to = join(dir, pkgDir, "node_modules");
    if (!existsSync(from) || existsSync(to)) continue;
    // The workspace scope inside a package's own node_modules must point at
    // the extracted tree as well, or the package resolves its siblings from
    // the original checkout and no mutation is ever seen.
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      if (profile.scopes.includes(entry)) continue;
      link(join(from, entry), join(to, entry));
    }
    for (const scope of profile.scopes) {
      const scopeDir = join(to, scope);
      mkdirSync(scopeDir, { recursive: true });
      for (const [otherDir, name] of profile.packageNames) {
        if (!name.startsWith(`${scope}/`)) continue;
        link(join(dir, otherDir), join(scopeDir, name.slice(scope.length + 1)));
      }
    }
  }
}
