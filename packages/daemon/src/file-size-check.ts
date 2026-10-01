/**
 * Deterministischer Dateigrößen-Check im PreToolUse-Hook (Daniel, 19.07.2026).
 *
 * Die Datei-Größen-Konvention (~500 Zeilen Richtwert, >800 kritisch; Tests
 * 700/1000) hing bisher daran, dass der Agent im Schreibmoment an sie DENKT —
 * und genau da verliert sie gegen den Feature-Fokus (zweimal passiert am
 * 19.07.: orbit-view 678→959, app.js →915, ohne Hinweis). Ein Memory löst das
 * nicht: probabilistischer Abruf erzwingt keine deterministische Regel.
 *
 * Darum misst der Hook selbst: vor jedem Write/Edit auf eine Code-Datei wird
 * die aktuelle Zeilenzahl gezählt und ab Richtwert-Nähe als kompakter
 * `<file-size-check>`-Block injiziert — der Agent bekommt die Zahl
 * hingehalten, statt sich erinnern zu müssen. Pure stdlib, budget-sicher,
 * Kill-Switch BASTRA_SIZE_CHECK=off.
 *
 * Wichtig (Daniels Klarstellung): 500 ist RICHTWERT, kein Limit — 670/700
 * sind okay, wenn die Größe kohärent begründet ist. Der Block fordert deshalb
 * einen Split-VORSCHLAG vor spürbarem Wachstum, nie ein Auto-Split.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { envOff } from "./env.js";

const CODE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".py", ".swift", ".rs", ".go", ".css", ".scss", ".vue", ".svelte",
]);
/** Generated blobs / bundles are none of the convention's business. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Throwaway contexts the convention does not apply to (#280).
 *
 * Reported case: `webui/mindspace-lab-anims.js` sits at ~1299 lines, so every
 * single edit to it got "over the 800-line ceiling — do NOT grow this file
 * further". Arithmetically correct, wrong advice: it is an animation sandbox
 * that gets deleted, not a module anyone will maintain. The only escape was
 * the all-or-nothing BASTRA_SIZE_CHECK=off, which also silences the check for
 * the real files edited in the same session.
 *
 * Segments are matched WHOLE, so `collaboration/` or `labels/` keep the
 * convention. The basename rule is delimiter-bounded for the same reason —
 * `collab-view.ts` and `foo-labels.ts` must not slip through.
 *
 * They are also matched only BELOW the project anchor (the hook's `cwd`):
 * meant are project-internal throwaway directories. A checkout that merely
 * lives under `~/labs/myapp` or `~/scratch/myapp` would otherwise exempt every
 * file it contains — a silent, un-overridable off switch for the whole project.
 */
const SANDBOX_SEGMENT = /^(sandbox(es)?|labs?|prototypes?|scratch|experiments?)$/;

/** Deliberately WITHOUT `prototype`: as a directory it means throwaway, as a
 *  file-name token it is usually production code about `Object.prototype`
 *  (`prototype-utils.ts`), and exempting that silently would be the one way
 *  this change could hurt. */
const SANDBOX_BASENAME = /(^|[-_.])(sandbox|lab|scratch|experiments?)([-_.]|$)/;

/**
 * True when a path sits in a throwaway context and the size convention should
 * not fire at all. Full exemption, not a raised ceiling: a bigger number would
 * only postpone the same wrong advice, and the agent would still have to argue
 * with a block it cannot act on. Sandbox code has no future readers, which is
 * the entire cost the convention is protecting against.
 *
 * `exemptPaths` comes from cli-settings `size.exemptPaths` (see
 * readSizeSettings) and is matched as a plain case-insensitive substring of
 * the normalized path — no glob engine on purpose, the hook has a 250 ms
 * budget and "webui/mindspace" is the shape users actually write.
 *
 * `cwd` is the project anchor the hook already passes to its skip gate; the
 * directory-segment rule only looks below it (see SANDBOX_SEGMENT).
 */
export function isSizeExemptPath(filePath: string, exemptPaths: string[] = [], cwd?: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  for (const raw of exemptPaths) {
    const needle = raw.replace(/\\/g, "/").trim().toLowerCase();
    if (needle.length > 0 && norm.includes(needle)) return true;
  }
  const segments = norm.split("/");
  if (SANDBOX_BASENAME.test(segments[segments.length - 1] ?? "")) return true;
  return dirSegmentsBelow(norm, cwd).some((seg) => SANDBOX_SEGMENT.test(seg));
}

/** Directory segments of an already normalized (lowercase, forward-slash) path
 *  that lie strictly below the project anchor. Without an anchor — or for a
 *  file outside it — every directory segment is used: there is nothing to tell
 *  a project directory from one of its ancestors. */
function dirSegmentsBelow(norm: string, cwd?: string): string[] {
  const anchor = (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const below = anchor.length > 0 && norm.startsWith(`${anchor}/`) ? norm.slice(anchor.length + 1) : norm;
  return below.split("/").slice(0, -1);
}

export interface SizeThresholds {
  guide: number;
  critical: number;
}

/** Convention thresholds for a path, or null when the path is exempt — by file
 *  type (docs, configs, lockfiles, generated code — anything non-code) or by
 *  throwaway context (#280, see isSizeExemptPath).
 *  Guide value resolves env > cli-settings (size.guide — written by the
 *  onboarding interview / `bastra config set size.guide N`) > built-in 500.
 *  `settings` is the pre-read settings size block (see readSizeSettings),
 *  `cwd` the project anchor for the throwaway-directory rule. */
export function thresholdsFor(
  filePath: string,
  settings: { guide?: number; critical?: number; exemptPaths?: string[] } = {},
  cwd?: string,
): SizeThresholds | null {
  const ext = extname(filePath).toLowerCase();
  if (!CODE_EXTS.has(ext)) return null;
  // Before the test-file branch: a sandbox test file is just as throwaway.
  if (isSizeExemptPath(filePath, settings.exemptPaths, cwd)) return null;
  const base = basename(filePath).toLowerCase();
  const isTest = /\.(test|spec)\./.test(base) || filePath.includes("__tests__");
  if (isTest) return { guide: 700, critical: 1000 }; // test files keep the fixed convention
  const guide = envNum("BASTRA_SIZE_GUIDE", numOr(settings.guide, 500));
  const critical = Math.max(guide, envNum("BASTRA_SIZE_CRITICAL", numOr(settings.critical, 800)));
  return { guide, critical };
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 5000 ? Math.round(v) : fallback;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}

/** Der User-Richtwert aus ~/.bastra/cli-settings.json — bewusst ein eigener
 *  Mini-Read (pure stdlib) statt settings.ts-Import: der Hook hat 250 ms
 *  Budget und braucht exakt zwei Zahlen. Fehler → leeres Objekt. */
export async function readSizeSettings(
  settingsPath: string = join(homedir(), ".bastra", "cli-settings.json"),
): Promise<{ guide?: number; critical?: number; exemptPaths?: string[] }> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      size?: { guide?: unknown; critical?: unknown; exemptPaths?: unknown };
    };
    // Non-strings and blanks are dropped rather than rejected: a broken entry
    // must not take the two numbers down with it (#280).
    const exemptPaths = Array.isArray(parsed.size?.exemptPaths)
      ? parsed.size.exemptPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    return {
      ...(typeof parsed.size?.guide === "number" ? { guide: parsed.size.guide } : {}),
      ...(typeof parsed.size?.critical === "number" ? { critical: parsed.size.critical } : {}),
      ...(exemptPaths.length > 0 ? { exemptPaths } : {}),
    };
  } catch {
    return {};
  }
}

/** The injected note, or null while the file is comfortably under the guide.
 *  Fires from ~90 % of the guide value so the split proposal can happen
 *  BEFORE the write that crosses the line. */
export function formatSizeNote(filePath: string, lines: number, t: SizeThresholds): string | null {
  if (lines < Math.floor(t.guide * 0.9)) return null;
  const level = lines > t.critical ? "critical" : "guide";
  const msg =
    level === "critical"
      ? `over the ${t.critical}-line ceiling — do NOT grow this file further; propose a coherent module split FIRST (file-size convention: cut responsibilities, not line counts).`
      : `at/near the ~${t.guide}-line guide value — if this edit adds noticeable growth, propose a module split BEFORE writing (file-size convention; a justified ${t.guide + 200}-line file is fine, silent growth is not).`;
  return `<file-size-check file="${basename(filePath)}" lines="${lines}" level="${level}">${msg}</file-size-check>`;
}

/** Measure + format in one step — the hook's entry point. Never throws:
 *  a new/unreadable file simply has nothing to warn about. */
export async function fileSizeNote(
  filePath: string,
  settingsPath?: string,
  cwd?: string,
): Promise<string | null> {
  if (envOff("BASTRA_SIZE_CHECK")) return null;
  const t = thresholdsFor(filePath, await readSizeSettings(settingsPath), cwd);
  if (!t) return null;
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.length > MAX_BYTES) return null;
    return formatSizeNote(filePath, raw.split("\n").length, t);
  } catch {
    return null;
  }
}
