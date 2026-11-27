/**
 * #1473: when a hook client cannot reach the daemon, it used to answer `{}`
 * and nothing else — the session then looked as if Recall had simply found
 * nothing, and the user had no way to see that the service was down.
 *
 * Now the first such failure in a session answers with one `systemMessage`
 * line for the user (Claude Code and Codex print it), naming `bastra doctor`;
 * every later failure in the same session stays silent. "Once" is one marker
 * file per session in the hook state directory, created exclusively, so
 * parallel hook processes of one session cannot both announce it. Without a
 * session id, or when the marker cannot be written, the client stays silent:
 * a notice that cannot be limited to once would repeat on every call.
 *
 * Only the lanes whose answer is a plain notice carrier announce it: the
 * session start and the prompt lane, which together cover every session from
 * its first turn on. The tool-call lanes stay `{}` (their output decides
 * about the tool call, and a notice there adds nothing the prompt lane has
 * not already said).
 *
 * The daemon is not there to ask for the user's language setting, so the
 * line follows the process locale; anything without its own text gets English.
 *
 * #1640: the daemon's session sweep removes markers older than the session
 * retention horizon, so they do not pile up one per session forever. Only
 * regular files named like a marker go; anything else in the directory stays.
 *
 * Stdlib-only: the compiled stub imports it (#344).
 */
import { lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defaultHookStateDir, privateDirState } from "./private-state-dir.js";

/** Text the product writes — never matched against anything. */
const NOTICE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  en: "bastra-recall: the Recall service is not reachable, so this session gets no memories. Check it with `bastra doctor`.",
  de: "bastra-recall: Der Recall-Dienst ist nicht erreichbar, diese Sitzung bekommt keine Erinnerungen. Prüfen mit `bastra doctor`.",
};

/** The lanes that announce an unreachable daemon. */
const NOTICE_LANES: ReadonlySet<string> = new Set(["prompt", "session"]);

const base = () => process.env.BASTRA_HOOK_STATE_DIR || defaultHookStateDir();
const directory = () => join(base(), "unreachable-notice");

function processLanguage(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0].toLowerCase();
  } catch {
    return "en";
  }
}

export function unreachableNoticeText(language: string = processLanguage()): string {
  return NOTICE_BY_LANGUAGE[language] ?? NOTICE_BY_LANGUAGE.en;
}

/** One-time markers, statusline markers and any interrupted statusline writes. */
const MARKER_NAME = /^(?:(?:offline-)?[0-9a-f]{24}|offline-local-\d{1,5}-[0-9a-f]{24}|offline-[0-9a-f-]{36}\.tmp)$/;

function markerKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

async function ensureNoticeDir(): Promise<boolean> {
  // Check the base before creating anything below it: a recursive mkdir
  // through a planted symlink would create the marker wherever it points.
  const root = base();
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await privateDirState(root)) !== "private") return false;
  const dir = directory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return (await privateDirState(dir)) === "private";
}

/** True exactly once per session id: the first caller creates the marker. */
async function firstInSession(sessionId: string): Promise<boolean> {
  try {
    if (!(await ensureNoticeDir())) return false;
    await writeFile(join(directory(), markerKey(sessionId)), "", { mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The stdout document for a call that could not reach the daemon: the notice
 * on the first failure of a session in a notice lane, `{}` otherwise.
 */
export async function unreachableAnswer(lane: string, sessionId: string | null | undefined): Promise<string> {
  if (!NOTICE_LANES.has(lane) || typeof sessionId !== "string" || !sessionId) return "{}";
  if (!(await firstInSession(sessionId))) return "{}";
  return JSON.stringify({ systemMessage: unreachableNoticeText() });
}

/**
 * #1640: drop the markers last written before `maxAgeMs`. Best-effort and
 * never throws. A session whose marker went may announce once more; the
 * exclusive create still keeps that to one notice.
 */
export async function sweepUnreachableNotices(maxAgeMs: number, now: number = Date.now()): Promise<void> {
  try {
    if ((await privateDirState(base())) !== "private") return;
    if ((await privateDirState(directory())) !== "private") return;
    const cutoff = now - maxAgeMs;
    for (const name of await readdir(directory())) {
      if (!MARKER_NAME.test(name)) continue;
      const path = join(directory(), name);
      try {
        const info = await lstat(path);
        if (info.isFile() && info.mtimeMs < cutoff) await unlink(path);
      } catch {
        /* Gone already, or not ours to remove. */
      }
    }
  } catch {
    /* Cleanup is advisory. */
  }
}

/** A daemon binds plain HTTP on IPv4 loopback. A remote address has no local owner. */
function localServicePort(baseUrl: string): number | undefined {
  const { protocol, hostname, port } = new URL(baseUrl);
  if (protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost")) return Number(port || 80);
  return undefined;
}

/** #1694: only a successfully bound daemon may clear its own offline markers. */
export async function clearStatuslineOutagesForPort(port: number): Promise<void> {
  try {
    const dir = directory();
    if ((await privateDirState(base())) !== "private" || (await privateDirState(dir)) !== "private") return;
    const prefix = `offline-local-${port}-`;
    for (const name of await readdir(dir, { withFileTypes: true })) {
      if (name.isFile() && name.name.startsWith(prefix) && MARKER_NAME.test(name.name))
        await unlink(join(dir, name.name)).catch(() => {});
    }
  } catch {
    // The running daemon and the next hook can still serve the session.
  }
}

/** Publish the last confirmed outage for the Claude footer. Recovery keeps the one-time notice. */
export async function recordStatuslineReachability(
  sessionId: string,
  reachable: boolean,
  baseUrl: string
): Promise<void> {
  try {
    const dir = directory();
    const port = localServicePort(baseUrl);
    const key = markerKey(sessionId);
    const marker = join(dir, port === undefined ? `offline-${key}` : `offline-local-${port}-${key}`);
    if (reachable) {
      if ((await privateDirState(base())) === "private" && (await privateDirState(dir)) === "private") {
        await unlink(marker).catch(() => {});
        // A successful hook also retires a marker written by an older client.
        if (port !== undefined) await unlink(join(dir, `offline-${key}`)).catch(() => {});
      }
      return;
    }
    if (!(await ensureNoticeDir())) return;
    const next = join(dir, `offline-${randomUUID()}.tmp`);
    await writeFile(next, "", { mode: 0o600, flag: "wx" });
    try {
      await rename(next, marker);
    } catch {
      await unlink(next);
    }
  } catch {
    // The footer is optional and must never interfere with the hook result.
  }
}
