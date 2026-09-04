/** Cross-client Skill installation, including OpenAI metadata (#232/#15). */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SERVER_KEY, fileExists, getServersBlock, readJsonConfig } from "./helpers.js";
import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_DESKTOP_CONFIG,
  SKILL_SOURCE_DIR,
  SKILL_TARGET_DIR,
} from "./paths.js";

export type SkillStepStatus =
  | "installed"
  | "already-installed"
  | "would-install"
  | "removed"
  | "not-present"
  | "would-remove"
  | "error";

/**
 * The skill payload: every markdown file directly in the skill source dir,
 * plus OpenAI's optional agents/openai.yaml metadata (#15/#232). Everything
 * else next to it (install scripts, Cursor rules) is deliberately excluded.
 */
async function skillPayload(sourceDir: string): Promise<string[]> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const payload = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
  const openAiMetadata = join("agents", "openai.yaml");
  if (await fileExists(join(sourceDir, openAiMetadata))) payload.push(openAiMetadata);
  return payload.sort();
}

/**
 * #456: one revision for the whole instruction bundle — sha256 over the
 * payload file names and contents, as shipped in the package. Doctor prints
 * it, so two machines can be compared by one short string, and a stale
 * installed copy is a difference against it, not a guess.
 */
export async function skillBundleRevision(sourceDir: string): Promise<string> {
  const h = createHash("sha256");
  for (const name of await skillPayload(sourceDir)) {
    h.update(name).update("\0").update(await readFile(join(sourceDir, name))).update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

export interface SkillInstallInspection {
  status: "missing" | "stale" | "up-to-date";
  /** Revision of the SOURCE bundle (what an up-to-date install would carry). */
  revision: string;
  /** Payload files absent from the target. */
  missing: string[];
  /** Payload files present but differing from the source. */
  stale: string[];
}

/**
 * #456: what an installed skill dir is, measured against the package source.
 * `bastra doctor` used to report "present" for any SKILL.md at the path — an
 * installed client could keep an older bundle indefinitely and look healthy.
 * Same comparison `copySkill` uses to decide what to copy, so doctor and
 * install can never disagree.
 */
export async function inspectSkillInstall(
  sourceDir: string,
  targetDir: string,
): Promise<SkillInstallInspection> {
  const payload = await skillPayload(sourceDir);
  const revision = await skillBundleRevision(sourceDir);
  const missing: string[] = [];
  const stale: string[] = [];
  for (const name of payload) {
    const target = join(targetDir, name);
    if (!(await fileExists(target))) {
      missing.push(name);
      continue;
    }
    const [src, dst] = await Promise.all([readFile(join(sourceDir, name), "utf8"), readFile(target, "utf8")]);
    if (src !== dst) stale.push(name);
  }
  if (missing.length === payload.length) return { status: "missing", revision, missing, stale };
  if (missing.length > 0 || stale.length > 0) return { status: "stale", revision, missing, stale };
  return { status: "up-to-date", revision, missing, stale };
}

/** Doctor wording for one skill install — identical on every surface. */
export function describeSkillInstall(i: SkillInstallInspection, targetDir: string): string {
  if (i.status === "missing") return "missing";
  if (i.status === "up-to-date") return `present, up to date (bundle ${i.revision}, ${targetDir})`;
  const parts = [
    ...(i.stale.length > 0 ? [`stale: ${i.stale.join(", ")}`] : []),
    ...(i.missing.length > 0 ? [`missing: ${i.missing.join(", ")}`] : []),
  ];
  return `STALE — ${parts.join("; ")} (installed copy differs from bundle ${i.revision})`;
}

/**
 * Install the skill directory (#232). Copies each payload file that is missing
 * or differs; an up-to-date target reports `already-installed` without writing.
 * Files already in the target that the source no longer has are left alone —
 * only SKILL.md is ever loaded, so a leftover reference file is inert, and
 * deleting under the user's skill dir is not this step's business.
 * `io` is injectable for tests only (real paths live under HOME).
 */
export async function copySkill(
  opts: { dryRun: boolean },
  io: { sourceDir?: string; targetDir?: string } = {},
): Promise<{ status: SkillStepStatus; detail: string }> {
  const sourceDir = io.sourceDir ?? SKILL_SOURCE_DIR;
  const targetDir = io.targetDir ?? SKILL_TARGET_DIR;
  const sourceFile = join(sourceDir, "SKILL.md");
  if (!(await fileExists(sourceFile))) {
    return { status: "error", detail: `skill source missing: ${sourceFile}` };
  }
  const payload = await skillPayload(sourceDir);
  const outdated: string[] = [];
  for (const name of payload) {
    const target = join(targetDir, name);
    if (!(await fileExists(target))) {
      outdated.push(name);
      continue;
    }
    const [src, dst] = await Promise.all([
      readFile(join(sourceDir, name), "utf8"),
      readFile(target, "utf8"),
    ]);
    if (src !== dst) outdated.push(name);
  }
  const scope = `${payload.length} file${payload.length === 1 ? "" : "s"}`;
  if (outdated.length === 0) {
    return { status: "already-installed", detail: `skill already at ${targetDir} (${scope})` };
  }
  if (opts.dryRun) {
    return { status: "would-install", detail: `would copy ${outdated.join(", ")} → ${targetDir}` };
  }
  await mkdir(targetDir, { recursive: true });
  for (const name of outdated) {
    await mkdir(dirname(join(targetDir, name)), { recursive: true });
    await copyFile(join(sourceDir, name), join(targetDir, name));
  }
  return { status: "installed", detail: `skill installed at ${targetDir} (${outdated.join(", ")})` };
}

// ─── post-uninstall skill sweep (#181) ───────────────────────────────────────

/** Surfaces that share the skill under ~/.claude/skills/ (Cursor doesn't). */
export const SKILL_SHARING_SURFACES = ["claude-desktop", "claude-code"] as const;

/** Skill-sharing surfaces this run must uninstall cleanly before a sweep. */
function requiredSweepSurfaces(surface: string | null): string[] {
  if (surface === "all") return [...SKILL_SHARING_SURFACES];
  return (SKILL_SHARING_SURFACES as readonly string[]).includes(surface ?? "") ? [surface as string] : [];
}

/**
 * Pure guard for the final sweep after the uninstall surface loop: sweep only
 * when this run targeted a skill-sharing surface (or 'all') AND no surface
 * registration still references the skill. A remaining registration always
 * wins; runs that never touch ~/.claude/skills (cursor) never sweep.
 * `succeededSurfaces` (when given) lists the surfaces whose uninstall
 * reported removed/would-remove/not-present — a covered surface missing from
 * it FAILED and counts as still registered, so a failed uninstall never
 * triggers (or dry-run-promises) the sweep.
 */
export function shouldSweepSkill(i: {
  surface: string | null;
  remainingRegistrations: string[];
  succeededSurfaces?: string[];
}): boolean {
  const covers =
    i.surface === "all" || (SKILL_SHARING_SURFACES as readonly string[]).includes(i.surface ?? "");
  if (!covers || i.remainingRegistrations.length > 0) return false;
  if (i.succeededSurfaces === undefined) return true;
  const succeeded = i.succeededSurfaces;
  return requiredSweepSurfaces(i.surface).every((s) => succeeded.includes(s));
}

/**
 * Skill-sharing surfaces whose config still registers the MCP server.
 * An unreadable/invalid config counts as registered — never delete on
 * uncertainty.
 */
async function liveSkillRegistrations(configPaths: Record<string, string>): Promise<string[]> {
  const registered: string[] = [];
  for (const [surface, path] of Object.entries(configPaths)) {
    const read = await readJsonConfig(path);
    if ("error" in read) {
      registered.push(surface);
      continue;
    }
    const servers = getServersBlock(read.data);
    if (servers && SERVER_KEY in servers) registered.push(surface);
  }
  return registered;
}

/**
 * Final sweep after the uninstall surface loop (#181): per-surface uninstalls
 * keep the shared skill, so a full run used to leave ~/.claude/skills/
 * bastra-recall behind. Registrations are read live AFTER the loop — a failed
 * surface uninstall keeps its registration and blocks the sweep. Under
 * --dry-run nothing was removed yet, so surfaces covered by this run are
 * subtracted instead — but only those whose uninstall reported
 * removed/would-remove/not-present (`succeededSurfaces`): a surface that
 * ERRORED counts as still registered. Best-effort: never throws; missing
 * dir = not-present. `io` is injectable for tests only (real paths live
 * under HOME).
 */
export async function sweepSharedSkill(
  opts: { surface: string | null; dryRun: boolean; succeededSurfaces?: string[] },
  io: { skillDir?: string; configPaths?: Record<string, string> } = {},
): Promise<{ status: "removed" | "would-remove" | "kept" | "not-present"; detail: string }> {
  try {
    const skillDir = io.skillDir ?? SKILL_TARGET_DIR;
    if (!(await fileExists(skillDir))) return { status: "not-present", detail: `no skill at ${skillDir}` };
    const configPaths = io.configPaths ?? {
      "claude-desktop": CLAUDE_DESKTOP_CONFIG,
      "claude-code": CLAUDE_CODE_CONFIG,
    };
    const succeeded = (s: string) =>
      opts.succeededSurfaces === undefined || opts.succeededSurfaces.includes(s);
    const coveredByRun = (s: string) => opts.surface === "all" || s === opts.surface;
    const live = await liveSkillRegistrations(configPaths);
    const remaining = opts.dryRun
      ? live.filter((s) => !coveredByRun(s) || !succeeded(s))
      : live;
    if (!shouldSweepSkill({
      surface: opts.surface,
      remainingRegistrations: remaining,
      succeededSurfaces: opts.succeededSurfaces,
    })) {
      const failed = requiredSweepSurfaces(opts.surface).filter((s) => !succeeded(s));
      const why = [
        remaining.length > 0 ? `still registered: ${remaining.join(", ")}` : "",
        failed.length > 0 ? `uninstall failed: ${failed.join(", ")}` : "",
      ].filter(Boolean).join("; ") || "still registered: none";
      return { status: "kept", detail: `kept (${why})` };
    }
    if (opts.dryRun) {
      return { status: "would-remove", detail: `${skillDir} — no surface registration would remain` };
    }
    await rm(skillDir, { recursive: true, force: true });
    return { status: "removed", detail: `${skillDir} — no surface registration references it anymore` };
  } catch (err) {
    // Cleanup must never fail the uninstall — an unregistered skill is inert.
    return { status: "kept", detail: `kept (${(err as Error).message})` };
  }
}
