import { bastraDataDir } from "../platform-paths.js";
/**
 * #268 + #226 — one preflight stage in front of the install step.
 *
 * `bastra update` replaced the installation with no awareness of anything: no
 * check for locally modified files, no backup, no verification of what it was
 * pulling. The trigger case for #268 was real — the Cyrillic locale fix lived
 * as a local patch on an installed daemon for days before #253 merged, and any
 * update in that window would have reverted it without a word. And the staged
 * path runs completely unattended (`update-check.ts` → `bastra update
 * --staged`, detached, stdio ignored), so "silently" is literal.
 *
 * ## Why the two issues are one module
 *
 * Both gate the SAME install step, and both must hold on the unattended path.
 * Built separately, they become two independent abort conditions in front of
 * one action — and the fastest way to kill auto-updates for everyone is two
 * guards that can each veto without knowing about the other. So: one preflight,
 * one result object, one place that decides.
 *
 * ## What it does NOT do
 *
 * It never repairs. It detects, backs up, and reports; reapplying local changes
 * onto the new version is the patch registry (#269) and deliberately separate.
 * The first version of a guard that can block every update should be able to
 * say "no" and nothing else.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, relative, dirname } from "node:path";
import { readdir, readFile, writeFile, mkdir, stat, cp } from "node:fs/promises";
import { findExecutable } from "./exec.js";

export interface ManifestEntry {
  /** Path relative to the package root, POSIX separators. */
  path: string;
  /** SHA-256 of the file contents, hex. */
  hash: string;
}

export interface UpdateManifest {
  version: string;
  /** Absolute package root the manifest was taken from. */
  root: string;
  created_at: string;
  files: ManifestEntry[];
}

export interface DirtyFile {
  path: string;
  /** "modified" — hash differs; "missing" — recorded but gone. */
  kind: "modified" | "missing";
}

/** The single verdict the update path acts on. */
export interface PreflightResult {
  /** May the install proceed? */
  ok: boolean;
  /** Locally modified files found against the manifest. Empty when clean or
   *  when no manifest exists yet (first run after this ships). */
  dirty: DirtyFile[];
  /** Where modified files were copied before anything replaced them. Absent
   *  when there was nothing to back up — and absent when NOTHING could be
   *  copied, so the line is never printed for an empty directory. */
  backupDir?: string;
  /** Modified files whose copy failed: nothing was preserved for these.
   *  Absent on the normal path. */
  backupFailed?: string[];
  /** Present when ok === false — one line, already user-facing. */
  refusal?: string;
  /** Present when a check could not run at all (no manifest yet, no npm, a
   *  registry that did not answer). Not a refusal: an honest "unknown". */
  notes: string[];
}

function baseDir(home = homedir()): string {
  return bastraDataDir(home);
}

export function manifestPath(home = homedir()): string {
  return join(baseDir(home), "install-manifest.json");
}

export function backupRoot(home = homedir()): string {
  return join(baseDir(home), "update-backups");
}

/** Directories that are never part of what a user would patch, and would only
 *  make the manifest enormous. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".bin", "__tests__"]);

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subtree — the manifest is best-effort by design
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".bin") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(root, full, out);
    } else if (e.isFile()) {
      out.push(relative(root, full).split(/[\\/]/).join("/"));
    }
  }
}

async function hashFile(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Snapshot the installed package so a later update can tell what changed. */
export async function buildManifest(root: string, version: string): Promise<UpdateManifest> {
  const rel: string[] = [];
  await walk(root, root, rel);
  const files: ManifestEntry[] = [];
  for (const p of rel.sort()) {
    const hash = await hashFile(join(root, p));
    if (hash) files.push({ path: p, hash });
  }
  return { version, root, created_at: new Date().toISOString(), files };
}

export async function writeManifest(m: UpdateManifest, home = homedir()): Promise<void> {
  const p = manifestPath(home);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  await writeFile(p, JSON.stringify(m, null, 2) + "\n", "utf8");
}

export async function readManifest(home = homedir()): Promise<UpdateManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(home), "utf8")) as UpdateManifest;
    return Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

/** Files whose contents no longer match the manifest. */
export async function detectDirty(m: UpdateManifest): Promise<DirtyFile[]> {
  const dirty: DirtyFile[] = [];
  for (const entry of m.files) {
    const full = join(m.root, entry.path);
    const hash = await hashFile(full);
    if (hash === null) {
      try {
        await stat(full);
        dirty.push({ path: entry.path, kind: "modified" }); // exists but unreadable
      } catch {
        dirty.push({ path: entry.path, kind: "missing" });
      }
      continue;
    }
    if (hash !== entry.hash) dirty.push({ path: entry.path, kind: "modified" });
  }
  return dirty;
}

/** What a backup run actually achieved — never just "where it was attempted". */
export interface BackupOutcome {
  /** The backup directory, present only when at least one file really landed
   *  in it. A directory nobody could write to is not a backup. */
  dir?: string;
  /** Modified files whose copy failed. Nothing was preserved for these. */
  failed: string[];
}

/**
 * Copy every modified file aside before anything replaces it. Runs even on
 * `--force` — forcing means "update anyway", never "throw my work away".
 *
 * A failed copy is collected instead of swallowed: an unreadable file (root-
 * owned, chmod 000) is exactly the case where the caller would otherwise be
 * told "backed up to: …" about an empty directory and then overwrite the
 * original. Per file, so one failure still lets the rest be saved.
 */
export async function backupDirty(
  m: UpdateManifest,
  dirty: DirtyFile[],
  home = homedir(),
): Promise<BackupOutcome> {
  const present = dirty.filter((d) => d.kind === "modified");
  if (present.length === 0) return { failed: [] };
  const dir = join(backupRoot(home), m.version);
  const failed: string[] = [];
  let saved = 0;
  for (const d of present) {
    const from = join(m.root, d.path);
    const to = join(dir, d.path);
    try {
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await cp(from, to);
      saved++;
    } catch {
      failed.push(d.path);
    }
  }
  return { ...(saved > 0 ? { dir } : {}), failed };
}

export interface ProvenanceCheck {
  ok: boolean;
  /** Present when the check could not be performed at all. */
  skipped?: string;
  detail?: string;
}

/** npm colours the decisive words (`invalid`, `missing`) with chalk. Piped
 *  stdio disables colour today, but classification must not hinge on that. */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * The ONLY sentences that may block an update — every one of them is npm
 * stating that it looked at a signature or an attestation and it did not check
 * out. Taken from npm's `lib/utils/verify-signatures.js` (npm 9 through 11),
 * which is what `npm audit signatures` prints:
 *
 *   "1 package has an invalid registry signature:"        (EINTEGRITYSIGNATURE)
 *   "3 packages have invalid registry signatures:"
 *   "1 package has an invalid attestation:"               (EATTESTATIONVERIFY)
 *   "2 packages have invalid attestations:"
 *   "1 package has a missing registry signature but the registry is providing signing keys:"
 *   "Someone might have tampered with this package since it was published on the registry!"
 *
 * `missing` is in the list on purpose: the registry handed npm signing keys and
 * then served a package without a signature. That is a finding, not an outage —
 * and since #268 it is overridable with an interactive `--force`, so a mirror
 * that strips signatures costs one flag rather than the whole update path.
 *
 * Everything else npm can exit non-zero with — an unreachable registry, a TUF
 * fetch that failed, ENOTCACHED under `--offline`, a package root with no
 * installed dependency tree, an npm too old for the subcommand — says nothing
 * about the signatures and therefore may not block.
 */
const AUDIT_FAILURE_PATTERNS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /\b(?:has an|have)\s+invalid\s+registry\s+signatures?\b/i, what: "invalid registry signature" },
  { re: /\b(?:has an|have)\s+invalid\s+attestations?\b/i, what: "invalid provenance attestation" },
  {
    re: /\b(?:has a|have)\s+missing\s+registry\s+signatures?\s+but the registry is providing signing keys\b/i,
    what: "missing registry signature",
  },
  { re: /Someone might have tampered with th(?:is|ese) packages?/i, what: "npm reports possible tampering" },
  { re: /\b(?:EINTEGRITYSIGNATURE|EATTESTATIONVERIFY)\b/, what: "signature verification error" },
];

/** Last few meaningful lines of npm's output, for a one-line report. */
function tail(out: string): string {
  return out.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ").slice(0, 300);
}

/**
 * Pure decision over what `npm audit signatures` said. Split out of
 * {@link verifyProvenance} so the interesting cases are testable without a
 * registry, a network or npm itself.
 *
 * Burden of proof is on the BLOCK, not on the pass: only an explicit
 * verification failure returns `ok: false`. Every other non-zero exit is an
 * honest "could not verify", reported as `skipped`.
 */
export function classifyAuditOutput(status: number, output: string): ProvenanceCheck {
  const out = stripAnsi(output);
  if (/unknown command|not a valid command/i.test(out)) {
    return { ok: true, skipped: "this npm has no `audit signatures` — upgrade npm to verify provenance" };
  }
  if (status === 0) return { ok: true, detail: "provenance attestations verified" };
  const failure = AUDIT_FAILURE_PATTERNS.find((p) => p.re.test(out));
  if (failure) return { ok: false, detail: `${failure.what} — ${tail(out)}` };
  const reason = tail(out) || `npm exited ${status} without output`;
  return { ok: true, skipped: `provenance could not be verified here — ${reason}` };
}

/**
 * #226 — verify the npm provenance attestation before pulling a version.
 *
 * All four packages publish through the protected GitHub Actions workflow with
 * `--provenance`, so every version carries a Sigstore attestation binding it to
 * a public workflow run and commit. Nothing checked it until now: `bastra
 * update` trusted the registry.
 *
 * `npm audit signatures` is the check npm ships. It works against an installed
 * tree, so it is run in the package root before the swap — that verifies what
 * is currently installed came from the expected pipeline. A missing npm, an npm
 * too old for the subcommand, a registry that does not answer: all SKIPPED, not
 * failed. A verifier that cannot run must not become a blocker for every
 * update, which would be the supply-chain guard taking the whole update path
 * down with it — and that is not hypothetical: behind a company mirror npm
 * exits 1 with "Fetching verification keys using TUF failed" / ENOTCACHED, and
 * with a negative list that verdict would have killed `bastra update` for good.
 */
export function verifyProvenance(packageRoot: string): ProvenanceCheck {
  const npmBin = findExecutable("npm");
  if (!npmBin) return { ok: true, skipped: "npm not found on a trusted PATH" };
  const r = spawnSync(npmBin, ["audit", "signatures"], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status === null) {
    return { ok: true, skipped: `npm audit signatures did not run (${r.error?.message ?? "timeout"})` };
  }
  return classifyAuditOutput(r.status, `${r.stdout ?? ""}${r.stderr ?? ""}`);
}

export interface PreflightOptions {
  /** Package root being replaced. */
  root: string;
  /** true for the unattended staged/auto path — it may never ask, and it may
   *  never proceed past a finding. */
  unattended: boolean;
  /** Interactive `--force`: proceed despite local modifications. Backups still
   *  happen. Ignored when unattended. */
  force: boolean;
  /** npm-global installs are the only ones with a registry attestation to
   *  check; brew and source have no equivalent. */
  checkProvenance: boolean;
  home?: string;
  /** Test seam only: how the provenance verdict is obtained. Defaults to the
   *  real `npm audit signatures` run — no caller passes this. */
  verify?: (packageRoot: string) => ProvenanceCheck;
}

/**
 * The single gate. Returns one verdict; callers do not re-derive it.
 */
export async function preflight(opts: PreflightOptions): Promise<PreflightResult> {
  const home = opts.home ?? homedir();
  const notes: string[] = [];

  const manifest = await readManifest(home);
  let dirty: DirtyFile[] = [];
  let backupDir: string | undefined;
  let backupFailed: string[] = [];

  if (!manifest) {
    // First run after this ships: there is no baseline yet, so "clean" is not
    // knowable. Saying so beats implying a check happened.
    notes.push("no install manifest yet — local modifications could not be checked (a baseline is written after this update)");
  } else if (manifest.root !== opts.root) {
    notes.push(`manifest was taken from a different install root (${manifest.root}) — skipping the dirty check`);
  } else {
    dirty = await detectDirty(manifest);
    if (dirty.length > 0) {
      const backup = await backupDirty(manifest, dirty, home);
      backupDir = backup.dir;
      backupFailed = backup.failed;
    }
  }

  // Carried into every verdict below, but only when there is something to say.
  const failedField = backupFailed.length > 0 ? { backupFailed } : {};

  // #226 — the verdict is taken here but ACTED ON below, in the same shape as a
  // dirty tree: an interactive `--force` may overrule it, the unattended path
  // never may. Returning from inside this block (as the first version did) put
  // the provenance branch in front of the force branch, so a verification that
  // could not run was an unbypassable "no" — `bastra update --force` included.
  let provenanceFailure: string | undefined;
  if (opts.checkProvenance) {
    const prov = (opts.verify ?? verifyProvenance)(opts.root);
    if (prov.skipped) notes.push(prov.skipped);
    else if (!prov.ok) provenanceFailure = prov.detail ?? "npm audit signatures reported a failed verification";
  }

  if (provenanceFailure) {
    const preamble = `provenance verification failed — refusing to install: ${provenanceFailure}.`;
    if (opts.unattended) {
      return {
        ok: false,
        dirty,
        backupDir,
        ...failedField,
        notes,
        refusal:
          `${preamble} Every published version carries a Sigstore attestation from the release workflow, so` +
          " this is a signature that did not check out — not a registry that stayed quiet. The automatic" +
          " update never overrides that: run 'bastra update' yourself to see the finding and decide.",
      };
    }
    if (!opts.force) {
      return {
        ok: false,
        dirty,
        backupDir,
        ...failedField,
        notes,
        refusal:
          `${preamble} Every published version carries a Sigstore attestation from the release workflow. If` +
          " you know why this install cannot prove it, re-run 'bastra update --force' to install anyway.",
      };
    }
    notes.push(`provenance verification FAILED and was overridden by --force: ${provenanceFailure}`);
  }

  if (dirty.length === 0) return { ok: true, dirty, notes, backupDir };

  // A copy that failed outranks the dirty finding itself, and it is the one
  // thing `--force` may NOT wave through: forcing costs the user nothing as
  // long as the original is safe elsewhere. Without a copy it costs the work.
  if (backupFailed.length > 0) {
    const named = backupFailed.slice(0, 3).join(", ");
    return {
      ok: false,
      dirty,
      backupDir,
      ...failedField,
      notes,
      refusal:
        `${backupFailed.length} locally modified file(s) could NOT be backed up (${named}` +
        `${backupFailed.length > 3 ? ", …" : ""}) — refusing to install, --force included. ` +
        `Installing would overwrite them with no copy to restore from; ` +
        `save or fix those files by hand, then re-run.`,
    };
  }

  if (opts.unattended) {
    return {
      ok: false,
      dirty,
      backupDir,
      notes,
      refusal:
        `${dirty.length} locally modified file(s) found — an automatic update will not replace them. ` +
        `Run 'bastra update' yourself to review and confirm.`,
    };
  }
  if (!opts.force) {
    return {
      ok: false,
      dirty,
      backupDir,
      notes,
      refusal: `${dirty.length} locally modified file(s) found — re-run with --force to update anyway.`,
    };
  }
  return { ok: true, dirty, backupDir, notes };
}

/** Human-readable rendering of a verdict — one place, so the interactive and
 *  the unattended path cannot drift in what they tell the user. */
export function formatPreflight(r: PreflightResult): string {
  const lines: string[] = [];
  for (const n of r.notes) lines.push(`  note: ${n}`);
  if (r.dirty.length > 0) {
    lines.push(`  locally modified (${r.dirty.length}):`);
    for (const d of r.dirty.slice(0, 20)) lines.push(`    ${d.kind === "missing" ? "missing " : "changed "} ${d.path}`);
    if (r.dirty.length > 20) lines.push(`    … and ${r.dirty.length - 20} more`);
  }
  if (r.backupDir) lines.push(`  backed up to: ${r.backupDir}`);
  // Printed right under the backup line so "backed up to: …" is never read as
  // "all of it" — these files have no copy anywhere.
  if (r.backupFailed && r.backupFailed.length > 0) {
    lines.push(`  NOT backed up (${r.backupFailed.length}) — no copy exists of:`);
    for (const p of r.backupFailed.slice(0, 20)) lines.push(`    failed   ${p}`);
    if (r.backupFailed.length > 20) lines.push(`    … and ${r.backupFailed.length - 20} more`);
  }
  if (r.refusal) lines.push(`✗ ${r.refusal}`);
  return lines.join("\n");
}
