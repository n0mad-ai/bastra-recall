/**
 * `bastra rules cursor [path]` — install the convention layer into a project.
 *
 * Why this is a command and not part of `bastra install cursor`: Cursor has no
 * global, file-based rules location. Its User Rules live in the settings UI,
 * and project rules are `<project>/.cursor/rules/*.mdc` — versioned with the
 * repo. `bastra install` registers MCP globally and often runs from the home
 * directory (the double-click installer does), where a `.cursor/rules/` folder
 * would mean nothing. So the rules layer is an explicit, per-project step: the
 * installer points at it, this command performs it, and nothing gets written
 * into a working directory the user did not name.
 */

import { cmdRulebookProposals } from "./rulebook-proposals-cmd.js";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CURSOR_RULES_RELATIVE, CURSOR_RULES_SOURCE_PATH } from "./paths.js";
import { fileExists } from "./helpers.js";
import type { ParsedArgs } from "./types.js";
import { usageBlocksIn } from "./usage-block-words.js";
import { rulesCmdWordsIn, type RulesCmdWords } from "./rules-cmd-words.js";
import { taskCliLanguage } from "./task-cli-words.js";

const SURFACES = ["cursor"] as const;

async function install(projectDir: string, dryRun: boolean, w: RulesCmdWords): Promise<number> {
  if (!CURSOR_RULES_SOURCE_PATH) {
    process.stderr.write(w.templateMissing);
    return 1;
  }
  const target = resolve(projectDir, CURSOR_RULES_RELATIVE);
  const source = await readFile(CURSOR_RULES_SOURCE_PATH, "utf8");

  if (await fileExists(target)) {
    const existing = await readFile(target, "utf8");
    if (existing === source) {
      process.stdout.write(w.alreadyInstalled(target));
      return 0;
    }
    if (dryRun) {
      process.stdout.write(w.wouldUpdate(target));
      return 0;
    }
    // The file is ours by name, but a user may have edited it. Keep a copy
    // rather than silently discarding their wording.
    //
    // "wx" on the backup: the name is derived from a timestamp and therefore
    // predictable, so refusing to write through an existing path (or a symlink
    // planted at one) is the difference between a backup and an overwrite
    // primitive. A collision means something is already sitting there — that
    // is a reason to stop, not to clobber. Mode 0600 from the first write,
    // like every installer backup (#1524).
    const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await writeFile(backup, existing, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (e) {
      process.stderr.write(w.backupFailed(backup, (e as Error).message));
      return 1;
    }
    await writeFile(target, source, "utf8");
    process.stdout.write(w.updated(target, backup));
    return 0;
  }

  if (dryRun) {
    process.stdout.write(w.wouldWrite(target));
    return 0;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
  process.stdout.write(w.wrote(target));
  return 0;
}

async function remove(projectDir: string, dryRun: boolean, w: RulesCmdWords): Promise<number> {
  const target = resolve(projectDir, CURSOR_RULES_RELATIVE);
  if (!(await fileExists(target))) {
    process.stdout.write(w.notPresent(target));
    return 0;
  }
  if (dryRun) {
    process.stdout.write(w.wouldRemove(target));
    return 0;
  }
  await rm(target, { force: true });
  process.stdout.write(w.removed(target));
  return 0;
}

export async function cmdRules(args: ParsedArgs): Promise<number> {
  if (["proposals", "confirm", "reject"].includes(args.positional[1]))
    return cmdRulebookProposals(args.positional.slice(1), args.dryRun);
  // `rules cursor [path]` and `rules remove cursor [path]`
  const [, second, third, fourth] = args.positional;
  const removing = second === "remove";
  const surface = removing ? third : second;
  const pathArg = removing ? fourth : third;
  const language = await taskCliLanguage().catch(() => "en");
  const w = rulesCmdWordsIn(language);

  if (!surface) {
    process.stderr.write(usageBlocksIn(language).rules);
    return 2;
  }
  if (!(SURFACES as readonly string[]).includes(surface)) {
    process.stderr.write(w.noLayer(surface, SURFACES.join(", ")));
    return 2;
  }

  const projectDir = resolve(pathArg ?? process.cwd());
  if (!(await fileExists(projectDir))) {
    process.stderr.write(w.noSuchDir(projectDir));
    return 2;
  }

  return removing ? remove(projectDir, args.dryRun, w) : install(projectDir, args.dryRun, w);
}
