/**
 * `bastra onboard` — the terminal surface of the onboarding interview:
 * persona choice, then the persona's questions one by one (optionals are
 * skippable with Enter), answers saved immediately as user-directed
 * memories. `onboard skip` just sets the marker (stop nudging); `onboard
 * done` is what an AI session runs after finishing the interview itself.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import matter from "gray-matter";
import {
  parseOnboardingAnswers,
  PERSONAS,
  PERSONA_LABELS,
  questionsFor,
  buildOnboardingMemories,
  saveOnboardingMemories,
  persistConventionSettings,
  persistLanguageSetting,
  markOnboardingDone,
  isOnboardingDone,
  type Persona,
} from "../onboarding.js";
import { resolveVault } from "./helpers.js";
import type { ParsedArgs } from "./types.js";

export async function cmdOnboard(args: ParsedArgs): Promise<number> {
  const vault = await resolveVault({ dryRun: false, vaultPath: args.vaultPath });
  if ("error" in vault) {
    process.stderr.write(`${vault.error}\n`);
    return 1;
  }

  if (args.surface === "skip" || args.surface === "done") {
    await markOnboardingDone(vault.path, args.surface === "skip" ? "cli (skipped)" : "session");
    process.stdout.write(
      args.surface === "skip"
        ? "✓ onboarding dismissed — run `bastra onboard` anytime to do the interview later\n"
        : "✓ onboarding marked done\n",
    );
    return 0;
  }

  if (args.answers !== null) {
    const loaded = await loadAnswersFile(args.answers);
    if ("error" in loaded) {
      process.stderr.write(`${loaded.error}\n`);
      return 2;
    }
    if (loaded.ignored.length > 0) {
      process.stderr.write(
        `ignored (not a ${loaded.persona} question): ${loaded.ignored.join(", ")} — ` +
          `known ids: ${questionsFor(loaded.persona).map((q) => q.id).join(", ")}\n`,
      );
    }
    return saveInterview(vault.path, loaded.persona, loaded.answers);
  }

  if (!process.stdin.isTTY) {
    process.stderr.write(
      "usage: bastra onboard                   run the interview (interactive)\n" +
        "       bastra onboard --answers <file>  save answers from a JSON/YAML file (no TTY needed)\n" +
        "       bastra onboard skip             stop the onboarding nudge without answering\n",
    );
    return 2;
  }

  if (await isOnboardingDone(vault.path)) {
    process.stdout.write("(you have onboarded before — answers overwrite your existing profile memories)\n\n");
  }

  const interview = await runInterview(process.stdin, process.stdout);
  if (!interview) {
    process.stderr.write("\ninput ended before the interview finished — nothing saved\n");
    return 1;
  }
  return saveInterview(vault.path, interview.persona, interview.answers);
}

/**
 * `--answers <file>` (#645): `{ persona, answers: { <question id>: text } }`
 * as JSON (a `.json` file) or YAML (anything else), validated exactly like
 * the map's POST body. `ignored` lists answer ids the persona's catalog does
 * not ask, so a typo is reported instead of silently dropped.
 */
export async function loadAnswersFile(
  path: string,
): Promise<{ persona: Persona; answers: Record<string, string>; ignored: string[] } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return { error: `cannot read answers file ${path}: ${(err as Error).message}` };
  }
  let data: unknown;
  try {
    // gray-matter's YAML engine, reused rather than adding a YAML dependency.
    data = extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : matter(`---\n${raw}\n---\n`).data;
  } catch (err) {
    return { error: `cannot parse answers file ${path}: ${(err as Error).message}` };
  }
  const parsed = parseOnboardingAnswers(data);
  if ("error" in parsed) return { error: `answers file ${path}: ${parsed.error}` };
  const asked = new Set(questionsFor(parsed.persona).map((q) => q.id));
  const ignored = Object.keys(parsed.answers).filter((id) => !asked.has(id));
  return { ...parsed, ignored };
}

async function saveInterview(vaultPath: string, persona: Persona, answers: Record<string, string>): Promise<number> {
  const memories = buildOnboardingMemories(persona, answers);
  // Keep the completion marker after this call: a real write failure must
  // leave onboarding retryable instead of recording a partial interview as done.
  await saveOnboardingMemories(vaultPath, memories, "cli:onboard");
  await persistConventionSettings(answers);
  await persistLanguageSetting(answers);
  await markOnboardingDone(vaultPath, "cli");
  process.stdout.write(
    `\n✓ ${memories.length} profile memories saved — your AI knows you from the next session on.\n` +
      `  Refine anytime: just tell your AI, or re-run \`bastra onboard\` (answers overwrite).\n` +
      `  Got memories in other AI tools? \`bastra import\` brings them along too.\n`,
  );
  return 0;
}

/**
 * The interactive interview over one readline interface (#645). Lines are
 * read through the interface's async iterator, which buffers input that
 * arrives before the next prompt (a pty fed scripted answers) and simply
 * ends at EOF or Ctrl-C. `rl.question()` dropped such early lines, hung on
 * a question pending at EOF and threw ERR_USE_AFTER_CLOSE on the next
 * question once the input had closed. Returns null when the input ends
 * before every question was asked — the caller then saves nothing.
 */
export async function runInterview(
  input: Readable,
  output: Writable,
): Promise<{ persona: Persona; answers: Record<string, string> } | null> {
  const rl = createInterface({ input, output });
  // Create the iterator before the first prompt so no early line is lost.
  const lines = rl[Symbol.asyncIterator]();
  // setPrompt keeps readline's own line redraws consistent; the prompt is
  // written directly because rl.prompt() resumes the input and throws
  // ERR_USE_AFTER_CLOSE once EOF has closed the interface.
  rl.setPrompt("> ");
  const ask = async (): Promise<string | null> => {
    output.write("> ");
    const next = await lines.next();
    return next.done ? null : String(next.value).trim();
  };
  try {
    output.write(
      "Seed your vault in ~5 minutes — a handful of questions, every answer becomes a memory\n" +
        "your AI recalls from day one. Enter skips an optional question; Ctrl-C aborts.\n\n" +
        "What will your memory mainly hold?\n",
    );
    PERSONAS.forEach((p, i) => output.write(`  ${i + 1}. ${PERSONA_LABELS[p]}\n`));
    let persona: Persona | null = null;
    while (persona === null) {
      const pick = await ask();
      if (pick === null) return null;
      const idx = parseInt(pick, 10) - 1;
      if (idx >= 0 && idx < PERSONAS.length) persona = PERSONAS[idx];
      else output.write(`pick 1-${PERSONAS.length}\n`);
    }

    const answers: Record<string, string> = {};
    for (const q of questionsFor(persona)) {
      output.write(`\n${q.ask}${q.optional ? "  (optional)" : ""}\n  ${q.hint}\n`);
      const answer = await ask();
      if (answer === null) return null;
      if (answer) answers[q.id] = answer;
    }
    return { persona, answers };
  } finally {
    rl.close();
  }
}
