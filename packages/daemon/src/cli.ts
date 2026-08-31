#!/usr/bin/env node
/**
 * bastra — CLI to install/uninstall/check bastra-recall across AI clients.
 *
 * One command, every MCP-capable client: the user installs once and bastra-recall
 * is reachable from Claude Code, Claude Desktop, Codex/ChatGPT Desktop, Cursor, etc. See vision in
 * bastra-recall#7 + memory `bastra-vision-universal-cross-surface-memory-onboarding`.
 *
 * Entry point only — parsing, adapters, commands live in ./cli/.
 */

import {
  cmdDoctor,
  cmdInstall,
  cmdUninstall,
  parseArgs,
  showVersion,
} from "./cli/commands.js";
import { showHelp } from "./cli/help-text.js";
import { cmdStatus } from "./cli/status.js";
import { cmdUpdate } from "./cli/update.js";
import { cmdConfig } from "./cli/config-cmd.js";
import { cmdEmbeddings } from "./cli/embeddings-cmd.js";
import { cmdModels } from "./cli/models-cmd.js";
import { cmdToken } from "./cli/token.js";
import { cmdCommons } from "./cli/commons.js";
import { cmdBridges } from "./cli/bridges.js";
import { cmdMap } from "./cli/map-cmd.js";
import { cmdImport } from "./cli/import-cmd.js";
import { cmdOnboard } from "./cli/onboard-cmd.js";
import { cmdSkills } from "./cli/skills-cmd.js";
import { cmdFeedback } from "./cli/feedback-cmd.js";
import { cmdLogs, parseSince } from "./cli/logs.js";
import { cmdLogStats } from "./cli/log-stats.js";
import { cmdCompletion } from "./cli/completion.js";
import { cmdRules } from "./cli/rules-cmd.js";
import { cmdPatches } from "./cli/patches-cmd.js";
import { cmdPanel } from "./cli/panel.js";
import { cmdAutostart } from "./cli/autostart.js";
import { maybeEmitUpdateHint } from "./cli/update-hint.js";

async function dispatch(args: ReturnType<typeof parseArgs>): Promise<number> {
  if (args.showVersion) { showVersion(); return 0; }
  // #330 — this guard runs BEFORE the switch and carries no `!args.command`
  // condition, so `--help` documents every command instead of executing it.
  // Binding it to "no command given" is what made `bastra update --help`
  // restart the daemon as its answer to what update does.
  if (args.showHelp) { showHelp(args.command); return 0; }
  if (!args.command) { return cmdPanel(args); }
  if (args.command === "help") { showHelp(args.surface); return 0; }

  switch (args.command) {
    case "version": showVersion(); return 0;
    case "install": return cmdInstall(args);
    case "uninstall": return cmdUninstall(args);
    case "doctor": return cmdDoctor(args);
    case "update": return cmdUpdate(args);
    case "autostart": return cmdAutostart(args);

    case "status": {
      const rc = await cmdStatus({ json: args.json, quiet: args.quiet });
      return rc;
    }
    case "config": return cmdConfig(args);
    case "embeddings": return cmdEmbeddings({ sub: args.surface });
    case "models": return cmdModels({ sub: args.surface, positional: args.positional });
    case "token": return cmdToken({ sub: args.surface, json: args.json, origin: args.origin });
    case "commons": return cmdCommons({ sub: args.surface, positional: args.positional });
    case "bridges": return cmdBridges({ sub: args.surface, positional: args.positional });
    case "map":
    case "ui":
      return cmdMap();
    case "import": return cmdImport(args);
    case "onboard": return cmdOnboard(args);
    case "skills": return cmdSkills(args);
    case "feedback": return cmdFeedback(args);
    case "rules": return cmdRules(args);
    case "patches": return cmdPatches(args);
    case "completion": return cmdCompletion(args.surface);
    case "logs": {
      const sinceMs = args.since === null ? 5 * 60_000 : parseSince(args.since);
      if (sinceMs === null) {
        process.stderr.write(`error: cannot read --since '${args.since}' — try 30s, 10min, 2h, 1d\n`);
        return 2;
      }
      const source = args.source ?? "all";
      if (source !== "daemon" && source !== "hook" && source !== "all") {
        process.stderr.write(`error: --source must be daemon, hook or all (got '${source}')\n`);
        return 2;
      }
      const lines = args.lines === null ? 200 : Number(args.lines);
      if (!Number.isFinite(lines) || lines <= 0) {
        process.stderr.write(`error: --lines must be a positive number (got '${args.lines}')\n`);
        return 2;
      }
      // --stats reads the same files, but aggregated instead of line by line.
      // Default window is wider: a per-lane rate needs days, not five minutes.
      if (args.stats) {
        const statsSince = args.since === null ? 7 * 86_400_000 : sinceMs;
        return cmdLogStats({ sinceMs: statsSince });
      }
      return cmdLogs({ follow: args.follow, sinceMs, source, lines: Math.floor(lines) });
    }
    default:
      process.stderr.write(`error: unknown command '${args.command}' — run 'bastra help'\n`);
      return 2;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const code = await dispatch(args);

  // After every subcommand: optionally emit a dim update hint to stderr.
  // Skip for `bastra update` itself (the user is already mid-update), for
  // help/version (low-noise commands; users hit them often), and for the
  // no-arg panel + config (the panel already shows update status inline).
  const skipHint =
    !args.command ||
    args.command === "update" ||
    args.command === "config" ||
    args.command === "token" ||
    args.command === "help" ||
    args.command === "version" ||
    args.showHelp ||
    args.showVersion;
  if (!skipHint) {
    try { await maybeEmitUpdateHint(); } catch { /* never break the CLI over this */ }
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
