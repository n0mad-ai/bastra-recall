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
 * Stdlib-only: the compiled stub imports it (#344).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defaultHookStateDir, privateDirState } from "./private-state-dir.js";

/** Text the product writes — never matched against anything. */
const NOTICE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  en: "bastra-recall: the Recall service is not reachable, so this session gets no memories. Check it with `bastra doctor`.",
  de: "bastra-recall: Der Recall-Dienst ist nicht erreichbar, diese Sitzung bekommt keine Erinnerungen. Prüfen mit `bastra doctor`.",
};

/** The lanes that announce an unreachable daemon. */
export const NOTICE_LANES: ReadonlySet<string> = new Set(["prompt", "session"]);

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

/** True exactly once per session id: the first caller creates the marker. */
async function firstInSession(sessionId: string): Promise<boolean> {
  try {
    // Check the base before creating anything below it: a recursive mkdir
    // through a planted symlink would create the marker wherever it points.
    await mkdir(base(), { recursive: true, mode: 0o700 });
    if ((await privateDirState(base())) !== "private") return false;
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    if ((await privateDirState(directory())) !== "private") return false;
    const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    await writeFile(join(directory(), key), "", { mode: 0o600, flag: "wx" });
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
