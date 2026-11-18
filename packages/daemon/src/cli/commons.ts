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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { findExecutable, run } from "./exec.js";
import { getCommonsEnabled, setCommonsEnabled } from "../settings.js";
import { isOnValue } from "../env.js";
import { buildVerificationRecord, commonsPath, verificationRecordPath } from "../commons-store.js";
import { usageWordsIn } from "./usage-words.js";
import { commonsWordsIn, type CommonsWords } from "./commons-words.js";
import { taskCliLanguage } from "./task-cli-words.js";

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
export function commonsRepoRefusal(rawUrl: string, language?: string): string | null {
  const w = commonsWordsIn(language);
  if (isOnValue(process.env[COMMONS_OPT_IN_ENV])) return null;
  const parsed = parseRemote(rawUrl);
  if (parsed && parsed.host === COMMONS_ALLOWED_HOST && parsed.owner.toLowerCase() === COMMONS_ALLOWED_OWNER)
    return null;
  const shown = parsed ? `${parsed.host}/${parsed.owner}/${parsed.repo}` : rawUrl || w.empty;
  return w.refusal(shown, COMMONS_ALLOWED_HOST, COMMONS_ALLOWED_OWNER, COMMONS_OPT_IN_ENV);
}

/** Print the one-line warning that an override is in effect (#260). Called at
 *  each egress point so the operator sees the target they redirected to, every
 *  time, not just when they set the variable. */
function noteCommonsOverride(action: string, w: CommonsWords): void {
  if (!isOnValue(process.env[COMMONS_OPT_IN_ENV])) return;
  if (COMMONS_REPO_URL === "https://github.com/n0mad-ai/bastra-commons.git") return;
  process.stdout.write(w.overridden(COMMONS_OPT_IN_ENV, action, COMMONS_REPO_URL));
}

export async function cmdCommons(opts: { sub: string | null; positional?: string[] }): Promise<number> {
  const sub = opts.sub ?? "status";
  const language = await taskCliLanguage().catch(() => "en");
  const w = commonsWordsIn(language);
  switch (sub) {
    case "verify":
      // bastra commons verify <recipe-id> <works|fails> ["environment note"]
      return await cmdVerify(
        opts.positional?.[2] ?? null,
        opts.positional?.[3] ?? null,
        opts.positional?.[4] ?? null,
        language
      );
    case "enable": {
      const rc = await cloneOrPull(language);
      if (rc !== 0) return rc;
      await setCommonsEnabled(true);
      process.stdout.write(w.enabled);
      return 0;
    }
    case "update": {
      if (!existsSync(commonsPath())) {
        process.stdout.write(w.notClonedYet);
        return 1;
      }
      return await cloneOrPull(language);
    }
    case "disable": {
      await setCommonsEnabled(false);
      process.stdout.write(w.disabled(commonsPath()));
      return 0;
    }
    case "status": {
      const enabled = await getCommonsEnabled();
      const cloned = existsSync(join(commonsPath(), "recipes"));
      process.stdout.write(w.status(enabled, cloned ? commonsPath() : null));
      return 0;
    }
    default:
      process.stderr.write(w.unknownSub(sub));
      return 2;
  }
}

// ─── verify-Loop (das Herzstück) ─────────────────────────────────────────────
/** Pseudonymer, stabiler Verifier-Schlüssel: Kurzhash der git-Mail. Der
 *  Klarname steht ohnehin im PR; der Hash macht nur den Dateinamen
 *  deterministisch ("ein Record pro User+Solution"). */
export function verifierId(): string {
  const r = spawnSync("git", ["config", "user.email"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
  const email = r.status === 0 ? String(r.stdout).trim() : "";
  const seed = email || `${homedir()}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

async function cmdVerify(
  recipeId: string | null,
  result: string | null,
  note: string | null,
  language: string
): Promise<number> {
  const w = commonsWordsIn(language);
  if (!recipeId || (result !== "works" && result !== "fails")) {
    process.stderr.write(usageWordsIn(language).commons);
    return 2;
  }
  const root = commonsPath();
  if (!existsSync(join(root, ".git"))) {
    process.stderr.write(w.notCloned);
    return 1;
  }
  if (!findRecipeFile(root, recipeId)) {
    process.stderr.write(w.recipeMissing(recipeId, join(root, "recipes")));
    return 1;
  }

  const verifier = verifierId();
  const record = buildVerificationRecord(recipeId, result, note, verifier);
  const recordPath = verificationRecordPath(root, recipeId, verifier);
  mkdirSync(join(root, "verifications", recipeId), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  process.stdout.write(w.recorded(recipeId, result, basename(recordPath)));

  // Submission als Mini-PR — best-effort: gelingt git/gh nicht, bleibt der
  // Record lokal liegen und der Pfad wird ausgegeben (manuell einreichbar).
  const git = findExecutable("git");
  const gh = findExecutable("gh");
  if (!git) {
    process.stdout.write(w.submitManually(recordPath));
    return 0;
  }
  // #260: the gate sits BEFORE the push, not just before `gh pr create` — the
  // push already ships the record to whatever origin the clone carries. The
  // record itself stays on disk either way, so refusing here costs nothing but
  // the automatic submission.
  const refusal = commonsRepoRefusal(COMMONS_REPO_URL, language);
  if (refusal) {
    process.stderr.write(`✗ ${refusal}\n`);
    process.stdout.write(w.recordKept(recordPath));
    return 1;
  }
  noteCommonsOverride(w.actionPr, w);
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
      process.stdout.write(w.stepFailed(label, r.detail, recordPath));
      run(git, ["-C", root, "checkout", "main"], { timeoutMs: 15_000 });
      return 0;
    }
  }
  const repoSlug = commonsRepoSlug(COMMONS_REPO_URL);
  if (gh && repoSlug) {
    const pr = spawnSync(
      gh,
      [
        "pr",
        "create",
        "--repo",
        repoSlug,
        "--head",
        branch,
        "--title",
        `verify: ${recipeId} → ${result}`,
        "--body",
        `Verification record from \`bastra commons verify\`:\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }
    );
    if (pr.status === 0) process.stdout.write(w.prOpened(String(pr.stdout).trim()));
    else process.stdout.write(w.prFailed(branch));
  } else {
    process.stdout.write(w.pushed(branch));
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

async function cloneOrPull(language: string): Promise<number> {
  const w = commonsWordsIn(language);
  const git = findExecutable("git");
  if (!git) {
    process.stderr.write(w.noGit);
    return 1;
  }
  const path = commonsPath();
  if (existsSync(join(path, ".git"))) {
    process.stdout.write(w.updating(path));
    const r = run(git, ["-C", path, "pull", "--ff-only"], {
      timeoutMs: 120_000,
      showProgress: true,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (!r.ok) {
      process.stderr.write(w.pullFailed(r.detail));
      return 1;
    }
  } else {
    const refusal = commonsRepoRefusal(COMMONS_REPO_URL, language);
    if (refusal) {
      process.stderr.write(`✗ ${refusal}\n`);
      return 1;
    }
    noteCommonsOverride(w.actionClone, w);
    process.stdout.write(w.cloning(COMMONS_REPO_URL, path));
    const r = cloneIntoRoot(git, COMMONS_REPO_URL, path, {}, language);
    if (!r.ok) {
      process.stderr.write(`✗ ${r.detail}\n`);
      return 1;
    }
  }
  process.stdout.write(w.upToDate);
  return 0;
}

/**
 * Clone into a root that may already hold local state. Before #648 the
 * bridges pool lived under the same root (`bridgesPath()` defaulted to
 * `commonsPath()`), so the daemon has usually minted `bridges/` and
 * `last-mint.json` there long before anyone enables Commons; #648 copies them
 * to ~/.bastra/bridges but leaves the originals in place. `git clone` refuses a non-empty directory, which made
 * `commons enable` fail for every such user. So the checkout is cloned next
 * to the root and moved in; a name that exists on both sides is refused by
 * name rather than overwritten, because the local side is the user's data.
 */
export function cloneIntoRoot(
  git: string,
  url: string,
  path: string,
  io: { move?: typeof renameSync } = {},
  language?: string
): { ok: true } | { ok: false; detail: string } {
  const w = commonsWordsIn(language);
  const unreachable = w.unreachable;
  const occupied = existsSync(path) && readdirSync(path).length > 0;
  if (!occupied) {
    const r = run(git, ["clone", "--depth", "1", url, path], {
      timeoutMs: 300_000,
      showProgress: true,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    return r.ok ? { ok: true } : { ok: false, detail: `${w.cloneFailed(r.detail)}${unreachable}` };
  }
  const staging = mkdtempSync(join(dirname(path), `.${basename(path)}-clone-`));
  let preserveStaging = false;
  try {
    const checkout = join(staging, "checkout");
    const r = run(git, ["clone", "--depth", "1", url, checkout], {
      timeoutMs: 300_000,
      showProgress: true,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (!r.ok) return { ok: false, detail: `${w.cloneFailed(r.detail)}${unreachable}` };
    const entries = readdirSync(checkout);
    const clash = entries.filter((name) => existsSync(join(path, name)));
    if (clash.length > 0) {
      return { ok: false, detail: w.clash(path, clash.join(", ")) };
    }
    // `.git` last: the root only counts as cloned once `.git` is in, so a move that stops
    // midway leaves visible clashes for the next run instead of a half tree it would pull into.
    const moved: Array<{ name: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }> = [];
    try {
      for (const name of [...entries.filter((n) => n !== ".git"), ".git"]) {
        const dest = join(path, name);
        (io.move ?? renameSync)(join(checkout, name), dest);
        const st = lstatSync(dest);
        moved.push({ name, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
      }
    } catch (err) {
      const stuck: string[] = [];
      for (const item of moved.reverse()) {
        const dest = join(path, item.name);
        try {
          const st = lstatSync(dest);
          if (
            st.dev !== item.dev ||
            st.ino !== item.ino ||
            st.size !== item.size ||
            st.mtimeMs !== item.mtimeMs ||
            st.ctimeMs !== item.ctimeMs
          ) {
            stuck.push(item.name);
            continue;
          }
          renameSync(dest, join(checkout, item.name));
        } catch {
          stuck.push(item.name);
        }
      }
      preserveStaging = stuck.length > 0;
      return {
        ok: false,
        detail: preserveStaging
          ? w.moveStuck((err as Error).message, path, staging, stuck.join(", "))
          : w.moveRolledBack((err as Error).message),
      };
    }
    return { ok: true };
  } finally {
    if (!preserveStaging) rmSync(staging, { recursive: true, force: true });
  }
}
