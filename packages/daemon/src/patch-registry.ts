/**
 * #269 — local patch registry: reapply registered patches after an update.
 *
 * #268 built the guard that never silently clobbers a local change: it detects
 * modified files, backs them up, and refuses or proceeds. It deliberately stops
 * there — "it never repairs" (see update-preflight.ts). This module is the
 * repair half, and it is the small version of #256: patch mechanics only, no
 * routine layer.
 *
 * ## The shape
 *
 * An ORDERED series of git-format patches under `~/.bastra/patches/`, applied
 * onto the fresh installation after every successful update. Three outcomes per
 * patch, and the third one is the reason this is worth building:
 *
 *   - applies cleanly        → applied, the local fix survives the update
 *   - already present        → auto-retired, this is the happy path once a PR
 *                              lands upstream and the patch became redundant
 *   - no longer applies      → SET ASIDE, never forced. Upstream moved the code
 *                              the patch touches; a forced apply would produce a
 *                              file nobody wrote and nobody reviewed.
 *
 * ## Why not `git apply --3way`
 *
 * The issue asks for a 3-way apply, and that is the right instinct — but
 * `--3way` reads the pre-image blobs out of an object database, so it needs the
 * target to BE a git repository. The npm-global install root is not one, and
 * that is the install mode the whole update preflight exists for
 * (`hasInPlacePreflight`). Creating a repo inside someone's install directory to
 * enable a merge strategy is not a trade worth making.
 *
 * So the probe is `--check` in both directions, which answers the same three
 * questions without an object database:
 *
 *   `git apply --reverse --check`  succeeds → the change is ALREADY in the tree
 *   `git apply --check`            succeeds → it applies cleanly
 *   neither                                 → conflict, set aside
 *
 * When the root IS a git repository (a source install), `--3way` is used as a
 * second chance before giving up — it can resolve a moved hunk that a plain
 * apply cannot. That is a bonus for one install mode, never the baseline.
 *
 * ## Two roots, not one
 *
 * A source install has two different roots and calling either one "the root" is
 * how a patch goes missing. `dist/cli.js` lives in the daemon PACKAGE root
 * (`<repo>/packages/daemon`) — that is what the boot check needs. A patch made
 * the way this feature expects, `git format-patch` off the checkout, addresses
 * files from the REPO root (`packages/core/src/graph.ts`) — that is what git
 * apply needs. They are the same directory only for an npm-global install,
 * which is why one variable served for both until a real source install ran.
 *
 * The failure is silent, which is the part that matters: `git apply` run from a
 * subdirectory does not error on paths outside it, it SKIPS them and exits 0.
 * A patch whose files all live outside the package root therefore looks like a
 * clean apply that changed nothing.
 *
 * ## Failure posture of the 3-way second chance
 *
 * `git apply --3way` is not a probe. When it cannot merge it still writes
 * `<<<<<<<` markers into the tree and stages the conflict, then exits non-zero
 * — so "it failed, therefore nothing happened" is false, and the promise this
 * feature makes ("set aside, never forced, the file is untouched") would be
 * broken by the very branch meant to save a patch. Every file the patch
 * addresses is snapshotted before the attempt and restored byte-for-byte if it
 * does not merge cleanly, and the attempt runs against a COPY of the index, so
 * a failed merge cannot stage anything in the real one either.
 *
 * "Every file it addresses" includes the SOURCE side of a rename, which the
 * `--numstat` plumbing does not report — see patchPaths(). A snapshot that
 * misses it loses that file outright, so when the list cannot be established
 * the 3-way is not attempted at all: an unreversible attempt is worth less
 * than the set-aside it would replace.
 *
 * ## Failure posture
 *
 * A patch series that leaves the daemon unable to boot is worse than a reverted
 * local fix. After the series, the patched CLI is actually started; if it does
 * not come up, every file this run touched is copied back from a snapshot taken
 * before each apply, and then READ AGAIN. Reverse-applying the patches cannot
 * do this: a `--3way` merge leaves a tree that no longer matches the patch's
 * post-image, so the reverse simply fails and the patched bytes stay. `git
 * stash` and `git checkout --` are out for the same reason #268 exists — they
 * would take the user's own uncommitted work with them, and they need a repo
 * the npm-global root does not have. What did not go back is named rather than
 * assumed away: `rolledBack` is the verdict of that read-back, never a
 * constant, and an install that is neither patched nor the one the updater
 * produced says exactly that. Rolling back is not a repair either — it is a
 * return to the one state that is known to work.
 */
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { findExecutable } from "./cli/exec.js";

export interface PatchEntry {
  /** Ordering prefix + slug, e.g. "010-cyrillic-slugify". Stable, user-visible. */
  id: string;
  /** File name inside the patches directory. */
  file: string;
  /** First `Subject:` line of the patch, or the filename when it has none. */
  subject: string;
  added_at: string;
  /** Set when the patch was auto-retired because upstream absorbed it. */
  retired_at?: string;
  /** Why it was retired — only ever "merged-upstream" today, but the field
   *  exists so a future manual retire is distinguishable from this one. */
  retired_reason?: string;
}

export interface PatchIndex {
  version: 1;
  patches: PatchEntry[];
}

/** What a probe says about one patch against one installation. */
export type PatchState =
  | "clean" // applies as-is
  | "already-upstream" // reverse-applies, so the change is already in the tree
  | "applied-here" // reverse-applies because the last run on THIS tree put it there
  | "conflict" // neither direction is clean
  | "unknown"; // git missing, patch unreadable — never treated as either

export interface PatchStatus {
  entry: PatchEntry;
  state: PatchState;
  /** git's own stderr, trimmed — the hunk names live here. */
  detail?: string;
}

export interface ApplyOutcome {
  applied: PatchEntry[];
  /** Already in the tree because the previous run on this same install applied
   *  them — kept in the series, not retired, not applied twice. */
  kept: PatchEntry[];
  retired: PatchEntry[];
  setAside: Array<{ entry: PatchEntry; detail: string }>;
  /** False when the smoke check failed and the series was reversed. */
  ok: boolean;
  /** Measured, not assumed: true only once every file the run touched was read
   *  back and matched the bytes taken before it. */
  rolledBack: boolean;
  /** What the rollback could not put back, when it could not. The install is
   *  then neither patched nor the one the updater produced. */
  unrestored?: string[];
  /** Present when the smoke check ran and failed. */
  smokeError?: string;
  /** Set when nothing could run at all (no git, no patches). Not a failure. */
  skipped?: string;
  /** The tree this run addressed — recorded so the next run can tell its own
   *  earlier work from an upstream merge. */
  tree?: { root: string; version?: string };
}

function baseDir(home = homedir()): string {
  return join(home, ".bastra");
}

export function patchesDir(home = homedir()): string {
  return join(baseDir(home), "patches");
}

export function patchIndexPath(home = homedir()): string {
  return join(patchesDir(home), "index.json");
}

export function retiredDir(home = homedir()): string {
  return join(patchesDir(home), "retired");
}

export function readIndex(home = homedir()): PatchIndex {
  try {
    const raw = readFileSync(patchIndexPath(home), "utf8");
    const parsed = JSON.parse(raw) as PatchIndex;
    if (!parsed || !Array.isArray(parsed.patches)) return { version: 1, patches: [] };
    return { version: 1, patches: parsed.patches };
  } catch {
    // No registry yet, or one we cannot parse. Both mean "no patches to apply"
    // — an update must never fail because of a file only this feature reads.
    return { version: 1, patches: [] };
  }
}

export function writeIndex(idx: PatchIndex, home = homedir()): void {
  mkdirSync(patchesDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(patchIndexPath(home), JSON.stringify(idx, null, 2) + "\n", "utf8");
}

/** Patches still in the series — retired ones stay in the index as history. */
export function activePatches(home = homedir()): PatchEntry[] {
  return readIndex(home).patches.filter((p) => !p.retired_at);
}

/** `Subject:` of a git-format-patch, minus the `[PATCH n/m]` decoration. */
export function patchSubject(content: string, fallback: string): string {
  const m = /^Subject:\s*(?:\[[^\]]*\]\s*)?(.+)$/m.exec(content);
  const s = m?.[1]?.trim();
  return s && s.length > 0 ? s : fallback;
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "patch";
}

/** Next free ordering prefix, in steps of 10 so a patch can be slotted between
 *  two existing ones by hand without renumbering the series. */
function nextPrefix(idx: PatchIndex): string {
  let max = 0;
  for (const p of idx.patches) {
    const n = Number.parseInt(p.id.slice(0, 3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(Math.min(max + 10, 999)).padStart(3, "0");
}

export interface AddResult {
  entry: PatchEntry;
  path: string;
}

export function addPatch(sourceFile: string, home = homedir()): AddResult {
  const abs = isAbsolute(sourceFile) ? sourceFile : resolve(process.cwd(), sourceFile);
  const content = readFileSync(abs, "utf8");
  if (!/^(diff --git |--- |Index: |From [0-9a-f]{7,})/m.test(content)) {
    throw new Error(`${sourceFile} does not look like a patch (no diff header found)`);
  }
  const idx = readIndex(home);
  const subject = patchSubject(content, basename(abs));
  const id = `${nextPrefix(idx)}-${slugify(subject)}`;
  const file = `${id}.patch`;
  mkdirSync(patchesDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(patchesDir(home), file), content, "utf8");
  const entry: PatchEntry = { id, file, subject, added_at: new Date().toISOString() };
  idx.patches.push(entry);
  writeIndex(idx, home);
  return { entry, path: join(patchesDir(home), file) };
}

/** Drops a patch from the series and deletes its file. Returns false when the
 *  id is unknown — the caller decides whether that is an error. */
export function removePatch(id: string, home = homedir()): boolean {
  const idx = readIndex(home);
  const i = idx.patches.findIndex((p) => p.id === id);
  if (i < 0) return false;
  const [entry] = idx.patches.splice(i, 1);
  try {
    unlinkSync(join(patchesDir(home), entry.file));
  } catch {
    // File already gone — the index entry is what matters.
  }
  writeIndex(idx, home);
  return true;
}

/** Moves a patch out of the active series into `retired/`, keeping the index
 *  entry as history. Used when upstream absorbed the change. */
function retirePatch(entry: PatchEntry, reason: string, home = homedir()): void {
  const idx = readIndex(home);
  const found = idx.patches.find((p) => p.id === entry.id);
  if (!found) return;
  found.retired_at = new Date().toISOString();
  found.retired_reason = reason;
  try {
    mkdirSync(retiredDir(home), { recursive: true, mode: 0o700 });
    renameSync(join(patchesDir(home), entry.file), join(retiredDir(home), entry.file));
  } catch {
    // Keeping the file in place is harmless; the index is what drives the series.
  }
  writeIndex(idx, home);
}

interface GitRun {
  ok: boolean;
  /** Both streams, trimmed: `git apply -v` writes its per-file verdict
   *  ("Checking patch", "Skipped patch") to stdout on some versions and stderr
   *  on others, and every reader below has to see it either way. */
  output: string;
  /** stdout alone, for the plumbing calls whose answer IS their stdout. */
  stdout: string;
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): GitRun {
  const bin = findExecutable("git");
  if (!bin) return { ok: false, output: "git not found on a trusted PATH", stdout: "" };
  const r = spawnSync(bin, args, { cwd: root, encoding: "utf8", timeout: 30_000, ...(env ? { env } : {}) });
  const stdout = r.stdout ?? "";
  return { ok: r.status === 0, output: `${stdout}\n${r.stderr ?? ""}`.trim(), stdout };
}

/**
 * git, confined to `root`. An install can sit inside a git work tree it has
 * nothing to do with: on Apple Silicon Homebrew `/opt/homebrew` IS the brew
 * checkout and the keg lies inside it, so `git apply` from the keg read every
 * patch as addressed from `/opt/homebrew` and printed "Skipped patch" for each
 * file — no patch could ever apply there, and the 3-way path would have probed
 * Homebrew's own index. A root with its own `.git` (a source checkout's top
 * level) keeps it; any other root gets `GIT_DIR` at a `.git` that is not there,
 * which turns discovery off. Not `GIT_CEILING_DIRECTORIES`: git compares it to
 * the cwd's realpath (a symlinked root slips past) and splits it on `:`.
 */
function gitAt(root: string, args: string[], env?: NodeJS.ProcessEnv): GitRun {
  if (existsSync(join(root, ".git"))) return git(root, args, env);
  return git(root, args, { ...(env ?? process.env), GIT_DIR: join(root, ".git") });
}

/**
 * `git apply --check`, but "exit 0" alone is not taken as a yes.
 *
 * git skips a patch it cannot make sense of — a malformed hunk header, a file
 * it decides not to touch — prints "Skipped patch 'x'" and still exits 0. Read
 * naively that is indistinguishable from a clean apply, and the consequence is
 * not cosmetic: a skipped patch would pass the reverse probe, be classified as
 * already-upstream, and get AUTO-RETIRED out of the series. The user would lose
 * a patch they still needed, silently, which is the one outcome this whole
 * feature exists to prevent.
 *
 * So the verdict is exit 0 AND no skip line. `-v` is what makes the skip
 * visible at all; without it the output is empty and the lie is invisible.
 */
function checkApplies(root: string, patchFile: string, reverse: boolean): GitRun {
  const args = ["apply", "--check", "-v", ...(reverse ? ["--reverse"] : []), patchFile];
  return noSkips(gitAt(root, args), "it could not be parsed or applied");
}

/**
 * The same rule on the apply path, where it decides more.
 *
 * `--check` is not the only call that exits 0 on a skip: a plain `git apply`
 * and `git apply --3way` do too, and there the reading is "applied" rather than
 * "clean". A patch every file of which git skipped would be recorded as
 * successfully reapplied while the tree is untouched — the user is told their
 * local fix survived the update when it did not.
 */
function noSkips(r: GitRun, what: string): GitRun {
  if (r.ok && /Skipped patch/i.test(r.output)) {
    return { ...r, ok: false, output: `git skipped this patch — ${what}:\n${r.output}` };
  }
  return r;
}

function applyPatch(root: string, patchFile: string, extra: string[] = [], env?: NodeJS.ProcessEnv): GitRun {
  return noSkips(gitAt(root, ["apply", "-v", ...extra, patchFile], env), "nothing was applied");
}

/**
 * The two roots of one installation. `apply` is where git addresses the patch
 * from, `boot` is where `dist/cli.js` is. See the header: they differ for a
 * source install and that difference is silent, so it is resolved once, here,
 * rather than assumed at each call site.
 */
export interface PatchRoots {
  apply: string;
  boot: string;
}

/**
 * The repo a source install is a checkout OF, or null.
 *
 * "Is this directory inside a work tree" is the wrong question: an npm-global
 * root can sit inside an unrelated repository (a dotfiles checkout, a synced
 * home) and answer yes, and then patches would be addressed against a tree that
 * has nothing to do with bastra. The question that separates the two is whether
 * the install's OWN package.json is a file that repo tracks — true for a source
 * checkout, false for anything unpacked into an ignored node_modules.
 */
function sourceRepoRoot(installRoot: string): string | null {
  if (!git(installRoot, ["ls-files", "--error-unmatch", "package.json"]).ok) return null;
  const top = git(installRoot, ["rev-parse", "--show-toplevel"]);
  const path = top.stdout.trim();
  return top.ok && path ? path : null;
}

export function resolveRoots(installRoot: string): PatchRoots {
  return { apply: sourceRepoRoot(installRoot) ?? installRoot, boot: installRoot };
}

/**
 * Probe one patch against an installation without changing anything.
 *
 * Order matters: the reverse check runs FIRST. A patch that upstream already
 * merged often also passes a forward `--check` on an unrelated hunk, and
 * applying it then would duplicate the change. Asking "is this already here?"
 * before "can this go in?" is the only order that cannot double-apply.
 */
export function probePatch(
  root: string,
  patchFile: string,
  /** Pass the already-resolved apply root when probing a whole series: working
   *  it out costs two `git` processes, and it cannot change between patches. */
  knownApplyRoot?: string,
): { state: PatchState; detail?: string } {
  if (!findExecutable("git")) return { state: "unknown", detail: "git not found on a trusted PATH" };
  if (!existsSync(patchFile)) return { state: "unknown", detail: "patch file missing" };
  const applyRoot = knownApplyRoot ?? resolveRoots(root).apply;
  const reverse = checkApplies(applyRoot, patchFile, true);
  if (reverse.ok) return { state: "already-upstream" };
  const forward = checkApplies(applyRoot, patchFile, false);
  if (forward.ok) return { state: "clean" };
  return { state: "conflict", detail: forward.output || reverse.output };
}

export function statusAll(root: string, home = homedir(), version?: string): PatchStatus[] {
  const dir = patchesDir(home);
  const applyRoot = resolveRoots(root).apply;
  const last = readLastRun(home);
  return activePatches(home).map((entry) => {
    const { state, detail } = probePatch(root, join(dir, entry.file), applyRoot);
    if (state === "already-upstream" && appliedByLastRun(last, entry.id, applyRoot, version)) {
      return { entry, state: "applied-here" as const, detail };
    }
    return { entry, state, detail };
  });
}

/**
 * Undo git's C-quoting of a path (`"sp\303\244t.txt"`).
 *
 * The `-z` plumbing reports paths raw, but the `rename from` header inside a
 * patch is written with `core.quotePath` applied, so anything outside ASCII
 * arrives escaped. The octal escapes are UTF-8 BYTES: they are collected as
 * bytes and decoded once at the end, because decoding each escape on its own
 * turns every multi-byte character into mojibake. Returns null for anything
 * that is not a well-formed quoted path — the caller treats that as "I cannot
 * enumerate this patch" rather than guessing.
 */
function unquotePath(raw: string): string | null {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
  const body = raw.slice(1, -1);
  const simple: Record<string, number> = {
    a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92,
  };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const esc = body[++i];
    if (esc === undefined) return null;
    if (esc in simple) {
      bytes.push(simple[esc]!);
      continue;
    }
    const oct = body.slice(i, i + 3);
    if (!/^[0-7]{3}$/.test(oct)) return null;
    bytes.push(Number.parseInt(oct, 8));
    i += 2;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Every file a patch addresses, and whether that list is trustworthy.
 *
 * `--numstat` only reads the patch — it never looks at, or touches, the tree.
 * But for a RENAME it names the destination only, and the apply deletes the
 * source. A snapshot built from `--numstat` alone therefore cannot put a
 * renamed-away file back, and a failed 3-way would leave the user with neither
 * path: the destination unlinked because it did not exist before, the source
 * gone because nothing recorded it. So the `rename from` headers are read out
 * of the patch itself and added.
 *
 * `complete: false` means the caller must not run anything that has to be
 * undone afterwards. A partial snapshot restores partially, which is worse
 * than never having tried.
 */
function patchPaths(root: string, patchFile: string): { paths: string[]; complete: boolean } {
  const r = gitAt(root, ["apply", "--numstat", "-z", patchFile]);
  if (!r.ok) return { paths: [], complete: false };
  // One NUL-terminated record per file: "<adds>\t<dels>\t<path>".
  const paths = r.stdout
    .split("\0")
    .map((rec) => rec.split("\t")[2])
    .filter((p): p is string => !!p && p.length > 0);

  let content: string;
  try {
    content = readFileSync(patchFile, "utf8");
  } catch {
    return { paths, complete: false };
  }
  for (const m of content.matchAll(/^rename from (.+)$/gm)) {
    const raw = m[1]!.trim();
    const source = raw.startsWith('"') ? unquotePath(raw) : raw;
    if (source === null || source.length === 0) return { paths, complete: false };
    if (!paths.includes(source)) paths.push(source);
  }
  return { paths, complete: true };
}

interface FileSnapshot {
  path: string;
  /** null = the file did not exist, and must not exist again after a restore. */
  bytes: Buffer | null;
  /** The permission bits it carried. A restore that has to CREATE the file —
   *  the source side of a rename — would otherwise hand back 0644 to something
   *  that was executable. */
  mode?: number;
}

function snapshot(root: string, relPaths: string[]): FileSnapshot[] {
  return relPaths.map((rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return { path: abs, bytes: null };
    return { path: abs, bytes: readFileSync(abs), mode: statSync(abs).mode & 0o7777 };
  });
}

/**
 * Put the snapshotted files back, and return the paths that did not go back.
 *
 * Every write is read again and compared to the bytes that were taken: a
 * rollback nobody verified is a rollback nobody may claim. Still best effort
 * per file — one unwritable path must not stop the rest from going back — but
 * that path is now named instead of swallowed.
 */
function restore(snap: FileSnapshot[]): string[] {
  const failed: string[] = [];
  for (const f of snap) {
    try {
      if (f.bytes === null) {
        if (existsSync(f.path)) unlinkSync(f.path);
        if (existsSync(f.path)) failed.push(f.path);
        continue;
      }
      // The directory can be gone: `git apply` removes one a rename emptied,
      // and then the copy-back is an ENOENT that would be reported as a file
      // needing hand repair — over a rollback nothing was actually wrong with.
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.bytes);
      if (f.mode !== undefined) chmodSync(f.path, f.mode);
      if (!readFileSync(f.path).equals(f.bytes)) failed.push(f.path);
    } catch {
      failed.push(f.path);
    }
  }
  return failed;
}

/**
 * The 3-way second chance, with the tree put back if it does not merge.
 *
 * Two guards, because `--3way` writes before it knows whether it succeeded:
 * the files it addresses are snapshotted and restored on failure, and it runs
 * against a copy of the index so a conflict cannot stage anything real.
 */
function tryThreeWay(applyRoot: string, patchFile: string): boolean {
  const gitDir = gitAt(applyRoot, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
  if (!gitDir) return false;

  // No trustworthy list of what the attempt would touch means no attempt. The
  // snapshot is the only thing that makes `--3way` reversible, and an empty or
  // partial one restores nothing while `--3way` still writes — which is the
  // pre-guard behaviour this function exists to remove.
  const addressed = patchPaths(applyRoot, patchFile);
  if (!addressed.complete || addressed.paths.length === 0) return false;

  const before = snapshot(applyRoot, addressed.paths);
  let scratch: string | null = null;
  let env: NodeJS.ProcessEnv | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), "bastra-3way-"));
    const indexCopy = join(scratch, "index");
    const realIndex = join(gitDir, "index");
    if (existsSync(realIndex)) copyFileSync(realIndex, indexCopy);
    env = { ...process.env, GIT_INDEX_FILE: indexCopy };
  } catch {
    // No scratch index means no safe attempt: a merge that could stage into the
    // real index is not worth a patch that a plain apply already refused.
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    return false;
  }

  try {
    if (applyPatch(applyRoot, patchFile, ["--3way"], env).ok) return true;
    restore(before);
    return false;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Boot the patched CLI. A patch that applies cleanly can still leave code that
 * does not load — this is the check that separates "the text merged" from "the
 * program still runs".
 */
export function smokeCheck(root: string): { ok: boolean; detail: string } {
  const cli = join(root, "dist", "cli.js");
  if (!existsSync(cli)) return { ok: true, detail: "no dist/cli.js to boot — smoke check skipped" };
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 30_000 });
  if (r.status === 0) return { ok: true, detail: `${r.stdout ?? ""}`.trim() };
  const why = r.error ? r.error.message : `${r.stderr ?? ""}`.trim() || `exit ${r.status}`;
  return { ok: false, detail: why };
}

export interface ApplyOptions {
  home?: string;
  /** Probe only — report what would happen, change nothing. */
  dryRun?: boolean;
  /** Skip the boot check. Only for tests; the update path always runs it. */
  skipSmoke?: boolean;
  /** Version of the tree being patched. With it, a patch this install already
   *  carries from the last run is told apart from one upstream absorbed. */
  version?: string;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * "Reverse-applies" has two causes, and only one means upstream merged the
 * patch. When the series runs over a tree that was not replaced (`bastra
 * update` with nothing newer to install), the user's own patch is still there
 * from the last run — read as "merged upstream" it was auto-retired, and the
 * next real update came up without it. It is ours when the last run applied or
 * kept this id on the same tree at the same version; with a root or version
 * missing from the record it is kept, because a kept patch costs nothing and a
 * wrong retire costs the patch (there is no un-retire).
 */
function appliedByLastRun(last: LastRun | null, id: string, applyRoot: string, version?: string): boolean {
  if (!last || !last.applied.includes(id)) return false;
  // A record written before root/version existed — the very update that installs
  // this code writes one — cannot rule the tree out, so it keeps.
  if (last.root && canonical(last.root) !== canonical(applyRoot)) return false;
  if (version !== undefined && last.version !== undefined) return version === last.version;
  return true;
}

/**
 * Apply the whole series onto `root`, in order.
 *
 * Ordering is not cosmetic: patches that touch the same file must go on in the
 * sequence the user registered them, or a later one fails against a tree its
 * predecessor was supposed to have produced.
 */
export function applySeries(root: string, opts: ApplyOptions = {}): ApplyOutcome {
  const home = opts.home ?? homedir();
  const out: ApplyOutcome = { applied: [], kept: [], retired: [], setAside: [], ok: true, rolledBack: false };
  const series = activePatches(home);
  if (series.length === 0) return { ...out, skipped: "no patches registered" };
  if (!findExecutable("git")) return { ...out, skipped: "git not found on a trusted PATH" };

  const dir = patchesDir(home);
  const roots = resolveRoots(root);
  out.tree = { root: canonical(roots.apply), ...(opts.version ? { version: opts.version } : {}) };
  const last = readLastRun(home);
  // The 3-way second chance is for a source checkout and nowhere else: it needs
  // an object database holding the pre-image blobs, and pointing it at whatever
  // repository an install root happens to sit inside would merge against a tree
  // that is not this program.
  const repo = roots.apply !== roots.boot || sourceRepoRoot(roots.boot) !== null;

  // The run-level snapshot the rollback below copies back from, filled lazily
  // right before each apply. FIRST WRITE WINS: a file two patches touch has to
  // go back to what it was before the RUN, not to what the first patch left.
  const taken = new Map<string, FileSnapshot>();
  // Patches whose file list could not be established. Nothing here is snapshot
  // covered, so the rollback falls back to a reverse-apply for them — and reads
  // its exit status instead of assuming it worked.
  const unenumerable = new Set<string>();
  const takeSnapshot = (file: string): boolean => {
    const addressed = patchPaths(roots.apply, file);
    for (const f of snapshot(roots.apply, addressed.paths)) if (!taken.has(f.path)) taken.set(f.path, f);
    return addressed.complete;
  };

  for (const entry of series) {
    const file = join(dir, entry.file);
    const { state, detail } = probePatch(root, file, roots.apply);

    if (state === "already-upstream" && appliedByLastRun(last, entry.id, roots.apply, opts.version)) {
      out.kept.push(entry);
      continue;
    }

    if (state === "already-upstream") {
      if (!opts.dryRun) retirePatch(entry, "merged-upstream", home);
      out.retired.push(entry);
      continue;
    }

    if (state === "clean") {
      if (opts.dryRun) {
        out.applied.push(entry);
        continue;
      }
      const covered = takeSnapshot(file);
      if (applyPatch(roots.apply, file).ok) {
        out.applied.push(entry);
        if (!covered) unenumerable.add(entry.id);
      } else out.setAside.push({ entry, detail: "probe said clean but the apply failed" });
      continue;
    }

    // Conflict — one more attempt, and only where it is actually available.
    if (state === "conflict" && repo && !opts.dryRun) {
      takeSnapshot(file);
      if (tryThreeWay(roots.apply, file)) {
        out.applied.push(entry);
        continue;
      }
    }
    out.setAside.push({ entry, detail: detail ?? "does not apply" });
  }

  if (opts.dryRun || opts.skipSmoke || out.applied.length === 0) return out;

  const smoke = smokeCheck(roots.boot);
  if (smoke.ok) return out;

  // The series broke the install. The patches nothing could enumerate go back
  // the only way left, newest first — the same order a stack unwinds in, so a
  // later patch never blocks the reversal of the one it sat on. Everything else
  // is copied back from the snapshot, which is the only move that also undoes a
  // `--3way` merge, and the copy-back has the last word on any path both cover.
  const unrestored: string[] = [];
  for (const entry of [...out.applied].reverse()) {
    if (!unenumerable.has(entry.id)) continue;
    if (!applyPatch(roots.apply, join(dir, entry.file), ["--reverse"]).ok) {
      unrestored.push(`${entry.id} — its files could not be listed and reversing it failed`);
    }
  }
  unrestored.push(...restore([...taken.values()]));

  const rolledBack = unrestored.length === 0;
  return {
    ...out,
    ok: false,
    rolledBack,
    smokeError: smoke.detail,
    ...(unrestored.length > 0 ? { unrestored } : {}),
    // Blanked only when the rollback was verified. A half-restored install has
    // to keep naming what went on: that list is the only thing the operator can
    // work from when they go to the backup by hand.
    ...(rolledBack ? { applied: [] } : {}),
  };
}

/**
 * What the last reapply did, for surfaces that must not spawn a process to find
 * out. The SessionStart hook runs inside a hard latency budget, so probing every
 * patch with `git apply --check` there is not an option — it reads this file
 * instead, which the update path wrote when it actually knew.
 */
export interface LastRun {
  at: string;
  applied: string[];
  retired: string[];
  setAside: Array<{ id: string; subject: string; detail: string }>;
  rolledBack: boolean;
  /** Added later, so it is optional: a record written before this existed still
   *  parses, it simply has nothing to say about what did not go back. */
  unrestored?: string[];
  smokeError?: string;
  /** The tree the run addressed (canonical) and its version. Optional for the
   *  same reason; without them a reverse-applying patch is never read as ours. */
  root?: string;
  version?: string;
}

export function lastRunPath(home = homedir()): string {
  return join(patchesDir(home), "last-run.json");
}

export function readLastRun(home = homedir()): LastRun | null {
  try {
    const rec = JSON.parse(readFileSync(lastRunPath(home), "utf8")) as LastRun;
    return rec && Array.isArray(rec.setAside) ? rec : null;
  } catch {
    return null;
  }
}
