/**
 * `bastra commons` — Bastra Commons, der Community-Rezept-Vault.
 *
 * Git-first: `enable` clont (bzw. pullt) das Commons-Repo nach
 * ~/.bastra/commons und setzt `commons.enabled` in cli-settings.json; der
 * Daemon lädt das Verzeichnis beim nächsten Boot als read-only BM25-Index
 * und fusioniert Treffer (scope "commons") in recall — leicht unter den
 * persönlichen Memories gerankt. Es wird NIE in das Repo geschrieben;
 * Beiträge laufen über PRs (siehe Commons-CONTRIBUTING).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { arch, homedir, platform } from "node:os";
import { join, basename, dirname } from "node:path";
import { findExecutable, run } from "./exec.js";
import { getCommonsEnabled, setCommonsEnabled } from "../settings.js";

export const COMMONS_REPO_URL = process.env.BASTRA_COMMONS_REPO ?? "https://github.com/n0mad-ai/bastra-commons.git";

/** #260 — the only host/owner the commons paths talk to without an explicit
 *  opt-in. `BASTRA_COMMONS_REPO` is free-form env and feeds both `git clone`
 *  and `gh pr create --repo`; the clone is read-only, but the PR path is
 *  EGRESS — a redirected repo would receive verification records and scrubbed
 *  bridges. Same posture as `assertLocalOrOptIn` for Ollama: default target,
 *  or an opt-in that says the operator meant it. */
const COMMONS_ALLOWED_HOST = "github.com";
const COMMONS_ALLOWED_OWNER = "n0mad-ai";
const COMMONS_OPT_IN_ENV = "BASTRA_ALLOW_REMOTE_COMMONS";

/** `owner/repo` for a git remote URL, or null if it is not a recognizable
 *  remote. Handles the three forms git accepts for GitHub: https, `ssh://`,
 *  and the scp-like `git@host:owner/repo`. Replaces an inline
 *  `.replace(/^https:\/\/github\.com\//)` that produced a garbage `--repo`
 *  argument for the ssh forms instead of admitting it could not parse them. */
export function commonsRepoSlug(rawUrl: string): string | null {
  const parsed = parseRemote(rawUrl);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

function parseRemote(rawUrl: string): { host: string; owner: string; repo: string } | null {
  const url = rawUrl.trim();
  if (!url) return null;
  // scp-like: git@github.com:owner/repo(.git)
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  if (scp && !url.includes("://")) return { host: scp[1].toLowerCase(), owner: scp[2], repo: scp[3] };
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (!/^(https?|ssh|git):$/.test(parsedUrl.protocol)) return null; // file:, and anything local, is not a remote
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  return { host: parsedUrl.hostname.toLowerCase(), owner: segments[0], repo: segments[1].replace(/\.git$/, "") };
}

/** Null when this target may be used; otherwise the reason to print and abort.
 *  Fail-closed on purpose: git would happily clone a path or an odd URL, so an
 *  unrecognized shape must not fall through the way the Ollama guard does. */
export function commonsRepoRefusal(rawUrl: string): string | null {
  if (process.env[COMMONS_OPT_IN_ENV] === "1") return null;
  const parsed = parseRemote(rawUrl);
  if (
    parsed &&
    parsed.host === COMMONS_ALLOWED_HOST &&
    parsed.owner.toLowerCase() === COMMONS_ALLOWED_OWNER
  )
    return null;
  const shown = parsed ? `${parsed.host}/${parsed.owner}/${parsed.repo}` : rawUrl || "(empty)";
  return (
    `refusing commons target "${shown}" — expected ${COMMONS_ALLOWED_HOST}/${COMMONS_ALLOWED_OWNER}/…\n` +
    `  The contribution path (\`bastra commons verify\`) opens a PR against this repo, so a redirected\n` +
    `  target would receive your verification records. Set ${COMMONS_OPT_IN_ENV}=1 to use it on purpose.`
  );
}

/** Print the one-line warning that an override is in effect (#260). Called at
 *  each egress point so the operator sees the target they redirected to, every
 *  time, not just when they set the variable. */
function noteCommonsOverride(action: string): void {
  if (process.env[COMMONS_OPT_IN_ENV] !== "1") return;
  if (COMMONS_REPO_URL === "https://github.com/n0mad-ai/bastra-commons.git") return;
  process.stdout.write(`! commons target overridden (${COMMONS_OPT_IN_ENV}=1): ${action} → ${COMMONS_REPO_URL}\n`);
}

export function commonsPath(): string {
  return process.env.BASTRA_COMMONS_PATH ?? join(homedir(), ".bastra", "commons");
}

export async function cmdCommons(opts: { sub: string | null; positional?: string[] }): Promise<number> {
  const sub = opts.sub ?? "status";
  switch (sub) {
    case "verify":
      // bastra commons verify <recipe-id> <works|fails> ["environment note"]
      return await cmdVerify(opts.positional?.[2] ?? null, opts.positional?.[3] ?? null, opts.positional?.[4] ?? null);
    case "enable": {
      const rc = await cloneOrPull();
      if (rc !== 0) return rc;
      await setCommonsEnabled(true);
      process.stdout.write("✓ commons enabled — restart the daemon (or your AI client) to load it\n");
      return 0;
    }
    case "update": {
      if (!existsSync(commonsPath())) {
        process.stdout.write("commons not cloned yet — run 'bastra commons enable' first\n");
        return 1;
      }
      return await cloneOrPull();
    }
    case "disable": {
      await setCommonsEnabled(false);
      process.stdout.write("✓ commons disabled (clone kept at " + commonsPath() + ") — restart the daemon to apply\n");
      return 0;
    }
    case "status": {
      const enabled = await getCommonsEnabled();
      const cloned = existsSync(join(commonsPath(), "recipes"));
      process.stdout.write(`commons: ${enabled ? "enabled" : "disabled"} · clone: ${cloned ? commonsPath() : "not cloned"}\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown commons subcommand '${sub}' — use enable|update|disable|status|verify\n`);
      return 2;
  }
}

// ─── verify-Loop (das Herzstück) ─────────────────────────────────────────────
// Ein Verification-Record ist die kleinste Beweis-Einheit: "works/fails for
// me" + Umgebung. Ein Record pro Verifier+Rezept — die Datei wird bei
// Meinungsänderung überschrieben, die Historie liegt im git-Log (append-only
// durch git, nicht durch uns). Aus den Records entsteht die Hitlist: Status
// wird berechnet, nie vergeben.

export interface VerificationRecord {
  recipe_id: string;
  result: "works" | "fails";
  environment: { os: string; arch: string; node: string; note: string | null };
  verifier: string;
  date: string;
}

export function buildVerificationRecord(
  recipeId: string,
  result: "works" | "fails",
  note: string | null,
  verifier: string,
  date: string = new Date().toISOString().slice(0, 10),
): VerificationRecord {
  return {
    recipe_id: recipeId,
    result,
    environment: { os: platform(), arch: arch(), node: process.version, note },
    verifier,
    date,
  };
}

export function verificationRecordPath(rootDir: string, recipeId: string, verifier: string): string {
  return join(rootDir, "verifications", recipeId, `${verifier}.json`);
}

/** Pseudonymer, stabiler Verifier-Schlüssel: Kurzhash der git-Mail. Der
 *  Klarname steht ohnehin im PR; der Hash macht nur den Dateinamen
 *  deterministisch ("ein Record pro User+Solution"). */
function verifierId(): string {
  const r = spawnSync("git", ["config", "user.email"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
  const email = r.status === 0 ? String(r.stdout).trim() : "";
  const seed = email || `${homedir()}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

/** Liest alle Records unter <root>/verifications → counts pro Rezept-ID.
 *  Synchron + defensiv; der Daemon ruft das einmal beim Boot. */
export function loadVerificationCounts(rootDir: string): Map<string, { works: number; fails: number }> {
  const counts = new Map<string, { works: number; fails: number }>();
  const base = join(rootDir, "verifications");
  try {
    for (const recipeDir of readdirSync(base, { withFileTypes: true })) {
      if (!recipeDir.isDirectory()) continue;
      const entry = { works: 0, fails: 0 };
      for (const f of readdirSync(join(base, recipeDir.name))) {
        if (!f.endsWith(".json")) continue;
        try {
          const rec = JSON.parse(readFileSync(join(base, recipeDir.name, f), "utf8")) as { result?: string };
          if (rec.result === "works") entry.works++;
          else if (rec.result === "fails") entry.fails++;
        } catch {
          /* skip corrupt record */
        }
      }
      counts.set(recipeDir.name, entry);
    }
  } catch {
    /* no verifications dir yet */
  }
  return counts;
}

/** Evidenz → Ranking: Basis-Dämpfung 0.8 (persönliche Memories gewinnen),
 *  unabhängige works heben (bis +0.15), fails senken. Geclampt, damit ein
 *  Rezept nie über persönliche Hits hinaus geboostet wird oder ganz
 *  verschwindet — Abstieg ist sichtbar, nicht Zensur. */
export function commonsRankFactor(works: number, fails: number): number {
  const factor = 0.8 + Math.min(0.15, works * 0.05) - Math.min(0.25, fails * 0.08);
  return Math.max(0.5, Math.min(0.95, factor));
}

async function cmdVerify(recipeId: string | null, result: string | null, note: string | null): Promise<number> {
  if (!recipeId || (result !== "works" && result !== "fails")) {
    process.stderr.write("usage: bastra commons verify <recipe-id> <works|fails> [\"environment note\"]\n");
    return 2;
  }
  const root = commonsPath();
  if (!existsSync(join(root, ".git"))) {
    process.stderr.write("commons not cloned — run 'bastra commons enable' first\n");
    return 1;
  }
  if (!findRecipeFile(root, recipeId)) {
    process.stderr.write(`✗ recipe '${recipeId}' not found in ${join(root, "recipes")}\n`);
    return 1;
  }

  const verifier = verifierId();
  const record = buildVerificationRecord(recipeId, result, note, verifier);
  const recordPath = verificationRecordPath(root, recipeId, verifier);
  mkdirSync(join(root, "verifications", recipeId), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  process.stdout.write(`✓ verification recorded: ${recipeId} → ${result} (${basename(recordPath)})\n`);

  // Submission als Mini-PR — best-effort: gelingt git/gh nicht, bleibt der
  // Record lokal liegen und der Pfad wird ausgegeben (manuell einreichbar).
  const git = findExecutable("git");
  const gh = findExecutable("gh");
  if (!git) {
    process.stdout.write(`→ submit manually: open a PR adding ${recordPath}\n`);
    return 0;
  }
  // #260: the gate sits BEFORE the push, not just before `gh pr create` — the
  // push already ships the record to whatever origin the clone carries. The
  // record itself stays on disk either way, so refusing here costs nothing but
  // the automatic submission.
  const refusal = commonsRepoRefusal(COMMONS_REPO_URL);
  if (refusal) {
    process.stderr.write(`✗ ${refusal}\n`);
    process.stdout.write(`→ record kept at ${recordPath} — submit manually if you meant to\n`);
    return 1;
  }
  noteCommonsOverride("verification PR");
  const branch = `verify/${recipeId}-${verifier}-${result}`;
  const steps: [string[], string][] = [
    [["-C", root, "checkout", "-B", branch], "branch"],
    [["-C", root, "add", recordPath], "add"],
    [["-C", root, "commit", "-m", `verify: ${recipeId} ${result} (${verifier})`], "commit"],
    [["-C", root, "push", "-u", "origin", branch, "--force-with-lease"], "push"],
  ];
  for (const [args, label] of steps) {
    const r = run(git, args, { timeoutMs: 60_000 });
    if (!r.ok) {
      process.stdout.write(`→ ${label} failed (${r.detail}) — record kept at ${recordPath}; submit manually\n`);
      run(git, ["-C", root, "checkout", "main"], { timeoutMs: 15_000 });
      return 0;
    }
  }
  const repoSlug = commonsRepoSlug(COMMONS_REPO_URL);
  if (gh && repoSlug) {
    const pr = spawnSync(gh, ["pr", "create", "--repo", repoSlug, "--head", branch, "--title", `verify: ${recipeId} → ${result}`, "--body", `Verification record from \`bastra commons verify\`:\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    if (pr.status === 0) process.stdout.write(`✓ verification PR opened: ${String(pr.stdout).trim()}\n`);
    else process.stdout.write(`→ branch '${branch}' pushed — open the PR manually (gh pr create failed)\n`);
  } else {
    process.stdout.write(`→ branch '${branch}' pushed — open a PR to submit your verification\n`);
  }
  run(git, ["-C", root, "checkout", "main"], { timeoutMs: 15_000 });
  return 0;
}

function findRecipeFile(rootDir: string, recipeId: string): string | null {
  const recipes = join(rootDir, "recipes");
  try {
    for (const domain of readdirSync(recipes, { withFileTypes: true })) {
      if (!domain.isDirectory()) continue;
      const candidate = join(recipes, domain.name, `${recipeId}.md`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no recipes dir */
  }
  return null;
}

async function cloneOrPull(): Promise<number> {
  const git = findExecutable("git");
  if (!git) {
    process.stderr.write("✗ git not found on a trusted PATH\n");
    return 1;
  }
  const path = commonsPath();
  if (existsSync(join(path, ".git"))) {
    process.stdout.write(`→ updating commons (${path})\n`);
    const r = run(git, ["-C", path, "pull", "--ff-only"], { timeoutMs: 120_000, showProgress: true, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (!r.ok) {
      process.stderr.write(`✗ git pull failed (${r.detail})\n`);
      return 1;
    }
  } else {
    const refusal = commonsRepoRefusal(COMMONS_REPO_URL);
    if (refusal) {
      process.stderr.write(`✗ ${refusal}\n`);
      return 1;
    }
    noteCommonsOverride("clone");
    process.stdout.write(`→ cloning ${COMMONS_REPO_URL} → ${path}\n`);
    const r = cloneIntoRoot(git, COMMONS_REPO_URL, path);
    if (!r.ok) {
      process.stderr.write(`✗ ${r.detail}\n`);
      return 1;
    }
  }
  process.stdout.write("✓ commons up to date\n");
  return 0;
}

/**
 * Clone into a root that may already hold local state. The bridges pool
 * lives under the same root (`bridgesPath()` defaults to `commonsPath()`),
 * and shared recall bridges are on by default, so the daemon has usually
 * minted `bridges/` and `last-mint.json` there long before anyone enables
 * Commons. `git clone` refuses a non-empty directory, which made
 * `commons enable` fail for every such user. So the checkout is cloned next
 * to the root and moved in; a name that exists on both sides is refused by
 * name rather than overwritten, because the local side is the user's data.
 */
export function cloneIntoRoot(git: string, url: string, path: string): { ok: true } | { ok: false; detail: string } {
  const unreachable = " — is the repo reachable (public, or your account has access)?";
  const occupied = existsSync(path) && readdirSync(path).length > 0;
  if (!occupied) {
    const r = run(git, ["clone", "--depth", "1", url, path], { timeoutMs: 300_000, showProgress: true, env: { GIT_TERMINAL_PROMPT: "0" } });
    return r.ok ? { ok: true } : { ok: false, detail: `git clone failed (${r.detail})${unreachable}` };
  }
  const staging = mkdtempSync(join(dirname(path), `.${basename(path)}-clone-`));
  try {
    const checkout = join(staging, "checkout");
    const r = run(git, ["clone", "--depth", "1", url, checkout], { timeoutMs: 300_000, showProgress: true, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (!r.ok) return { ok: false, detail: `git clone failed (${r.detail})${unreachable}` };
    const entries = readdirSync(checkout);
    const clash = entries.filter((name) => existsSync(join(path, name)));
    if (clash.length > 0) {
      return { ok: false, detail: `${path} already holds ${clash.join(", ")}, which the Commons checkout also has — move them aside and run 'bastra commons enable' again` };
    }
    for (const name of entries) renameSync(join(checkout, name), join(path, name));
    return { ok: true };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
