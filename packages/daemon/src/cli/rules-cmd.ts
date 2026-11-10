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

const SURFACES = ["cursor"] as const;

function usage(): void {
  process.stderr.write(
    [
      "usage: bastra rules proposals            show pending proposals with full text and revision",
      "       bastra rules confirm|reject <id> <revision> user-directed",
      "       bastra rules cursor [path]        install the rules file into a project",
      "       bastra rules cursor [path] --dry-run",
      "       bastra rules remove cursor [path] remove it again",
      "",
      "  path defaults to the current directory.",
      "",
      "Cursor keeps project rules in the repo (.cursor/rules/*.mdc) and has no",
      "global rules file, so this runs once per project you want memory in.",
      "",
    ].join("\n"),
  );
}

async function install(projectDir: string, dryRun: boolean): Promise<number> {
  if (!CURSOR_RULES_SOURCE_PATH) {
    process.stderr.write("error: cursor rules template missing from this installation\n");
    return 1;
  }
  const target = resolve(projectDir, CURSOR_RULES_RELATIVE);
  const source = await readFile(CURSOR_RULES_SOURCE_PATH, "utf8");

  if (await fileExists(target)) {
    const existing = await readFile(target, "utf8");
    if (existing === source) {
      process.stdout.write(`✓ already installed: ${target}\n`);
      return 0;
    }
    if (dryRun) {
      process.stdout.write(`~ would update ${target} (differs from the shipped rules)\n`);
      return 0;
    }
    // The file is ours by name, but a user may have edited it. Keep a copy
    // rather than silently discarding their wording.
    //
    // "wx" on the backup: the name is derived from a timestamp and therefore
    // predictable, so refusing to write through an existing path (or a symlink
    // planted at one) is the difference between a backup and an overwrite
    // primitive. A collision means something is already sitting there — that
    // is a reason to stop, not to clobber.
    const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await writeFile(backup, existing, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      process.stderr.write(
        `error: cannot back up the existing rules to ${backup}: ${(e as Error).message}\n` +
          "  refusing to overwrite your version without one\n",
      );
      return 1;
    }
    await writeFile(target, source, "utf8");
    process.stdout.write(`✓ updated ${target}\n  previous version kept at ${backup}\n`);
    return 0;
  }

  if (dryRun) {
    process.stdout.write(`~ would write ${target}\n`);
    return 0;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
  process.stdout.write(
    `✓ wrote ${target}\n` +
      "  Cursor picks it up on the next chat — the rule applies to every session in this project.\n" +
      "  It is a normal project file: commit it and your team gets the same behaviour.\n",
  );
  return 0;
}

async function remove(projectDir: string, dryRun: boolean): Promise<number> {
  const target = resolve(projectDir, CURSOR_RULES_RELATIVE);
  if (!(await fileExists(target))) {
    process.stdout.write(`✓ not present: ${target}\n`);
    return 0;
  }
  if (dryRun) {
    process.stdout.write(`~ would remove ${target}\n`);
    return 0;
  }
  await rm(target, { force: true });
  process.stdout.write(`✓ removed ${target}\n`);
  return 0;
}

export async function cmdRules(args: ParsedArgs): Promise<number> {
  if (["proposals", "confirm", "reject"].includes(args.positional[1])) return cmdRulebookProposals(args.positional.slice(1), args.dryRun);
  // `rules cursor [path]` and `rules remove cursor [path]`
  const [, second, third, fourth] = args.positional;
  const removing = second === "remove";
  const surface = removing ? third : second;
  const pathArg = removing ? fourth : third;

  if (!surface) {
    usage();
    return 2;
  }
  if (!(SURFACES as readonly string[]).includes(surface)) {
    process.stderr.write(
      `error: no rules layer for '${surface}' — supported: ${SURFACES.join(", ")}\n` +
        "  (Claude Code and Claude Desktop use the skill, installed by 'bastra install'.)\n",
    );
    return 2;
  }

  const projectDir = resolve(pathArg ?? process.cwd());
  if (!(await fileExists(projectDir))) {
    process.stderr.write(`error: no such directory: ${projectDir}\n`);
    return 2;
  }

  return removing ? remove(projectDir, args.dryRun) : install(projectDir, args.dryRun);
}
