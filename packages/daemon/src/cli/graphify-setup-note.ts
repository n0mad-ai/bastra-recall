/**
 * The "existing Graphify setup" note in `bastra doctor` (#573).
 *
 * Graphify's own installers (`graphify install`, `graphify claude install`,
 * `graphify hook install`) write a `hook-guard` PreToolUse entry into
 * `.claude/settings.json`, a `# graphify` block into `~/.claude/CLAUDE.md` and a
 * `graphify` skill directory. Recall never runs those commands (it uses its own
 * pinned copy by absolute path), but a user may have run them: the result is two
 * code-awareness layers answering the same questions.
 *
 * Read-only, by owner decision: this only names what it found. It never changes
 * or removes anything, `--fix` included, and it never flips doctor's exit code.
 * The signals are exactly the three the issue names; nothing broader.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { doctorNotesWordsIn } from "./doctor-notes-words.js";

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

const preToolUseSettings = z.object({
  hooks: z.object({
    PreToolUse: z.array(
      z
        .object({
          hooks: z.array(z.object({ command: z.string().optional() }).catch({})).optional(),
        })
        .catch({})
    ),
  }),
});

// Installs use either the bare executable or its absolute path, quoted if needed.
const graphifyGuard =
  /^\s*(?:"(?:[^"]*[\\/])?graphify(?:\.exe)?"|'(?:[^']*[\\/])?graphify(?:\.exe)?'|(?:\S*[\\/])?graphify(?:\.exe)?)\s+hook-guard(?:\s|$)/i;

function hasGraphifyGuard(text: string): boolean {
  try {
    const settings = preToolUseSettings.parse(JSON.parse(text));
    return settings.hooks.PreToolUse.some((group) =>
      group.hooks?.some((hook) => graphifyGuard.test(hook.command ?? ""))
    );
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Paths of Graphify's own setup found in `repo` and `home`; empty when none. */
export async function findGraphifySetup(repo: string, home: string): Promise<string[]> {
  const found: string[] = [];
  for (const base of [repo, home]) {
    const settings = join(base, ".claude", "settings.json");
    if (hasGraphifyGuard(await readText(settings))) found.push(settings);
  }
  const claudeMd = join(home, ".claude", "CLAUDE.md");
  if (/^#\s+graphify\b/im.test(await readText(claudeMd))) found.push(claudeMd);
  const skill = join(home, ".claude", "skills", "graphify");
  if (await isDirectory(skill)) found.push(skill);
  return found;
}

/** Print the note; silent when nothing is found. Never throws. */
export async function printGraphifySetupNote(
  language: string,
  where: { repo?: string; home?: string } = {}
): Promise<void> {
  try {
    const found = await findGraphifySetup(where.repo ?? process.cwd(), where.home ?? homedir());
    if (found.length === 0) return;
    const w = doctorNotesWordsIn(language);
    process.stdout.write(w.graphifySetupHeader);
    for (const path of found) process.stdout.write(`  ${path}\n`);
    process.stdout.write(`  ${w.graphifySetupHint}\n\n`);
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
