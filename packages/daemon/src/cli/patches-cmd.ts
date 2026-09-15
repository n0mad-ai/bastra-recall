/**
 * `bastra patches` (#269) — the user-facing half of the local patch registry.
 *
 * The series itself and everything that decides an outcome live in
 * ../patch-registry.ts; this file only parses a sub-command and renders. That
 * split is deliberate: the update path calls the same functions unattended, and
 * a decision that only exists inside a CLI renderer is a decision the
 * unattended path silently does not make.
 */
import { homedir } from "node:os";
import type { ParsedArgs } from "./types.js";
import { detectInstallMode, installedVersion, packageRootFromCliPath } from "./update.js";
import {
  activePatches,
  addPatch,
  applySeries,
  patchesDir,
  readIndex,
  removePatch,
  resolveRoots,
  statusAll,
  type PatchState,
} from "../patch-registry.js";
import { formatApplyOutcome } from "../patch-report.js";

const out = (s: string) => process.stdout.write(s);

function usage(): void {
  out(
    "usage: bastra patches [list|add <file>|remove <id>|status]\n" +
      "  list            the series, in apply order (default)\n" +
      "  add <file>      register a git-format patch\n" +
      "  remove <id>     drop a patch from the series\n" +
      "  status          probe every patch against the current installation\n\n" +
      "Registered patches are reapplied automatically after 'bastra update'.\n" +
      "A patch upstream has absorbed is retired; one that no longer applies is\n" +
      "set aside and reported, never forced.\n",
  );
}

const STATE_LABEL: Record<PatchState, string> = {
  clean: "✓ applies cleanly",
  "already-upstream": "↩ already upstream",
  "applied-here": "✓ applied (by the last update on this install)",
  conflict: "⚠ conflicts",
  unknown: "? cannot tell",
};

/** The installation this CLI runs from — the same root the update path patches. */
function installRoot(): string {
  return packageRootFromCliPath(detectInstallMode().cliPath);
}

export async function cmdPatches(args: ParsedArgs): Promise<number> {
  // positional is ["patches", <sub>, <arg>…] — same shape config-cmd and
  // import-cmd read. Filtering the sub-command out by value instead of by
  // position looks equivalent and is not: `patches add patches` would drop the
  // argument along with the sub-command.
  const sub = args.positional[1] ?? "list";
  const arg = args.positional[2];

  if (sub === "help" || args.showHelp) {
    usage();
    return 0;
  }

  if (sub === "list") {
    const idx = readIndex();
    const active = idx.patches.filter((p) => !p.retired_at);
    const retired = idx.patches.filter((p) => p.retired_at);
    if (idx.patches.length === 0) {
      out("No patches registered.\n\n");
      out(`Register one with:  bastra patches add <file.patch>\n`);
      out(`They live in ${patchesDir()} and are reapplied after every update.\n`);
      return 0;
    }
    out(`Series (${active.length}), in apply order:\n`);
    for (const p of active) out(`  ${p.id}\n      ${p.subject}\n      added ${p.added_at.slice(0, 10)}\n`);
    if (retired.length) {
      out(`\nRetired (${retired.length}) — kept as history, no longer applied:\n`);
      for (const p of retired) out(`  ${p.id} — ${p.retired_reason ?? "retired"} ${p.retired_at?.slice(0, 10) ?? ""}\n`);
    }
    return 0;
  }

  if (sub === "add") {
    const file = arg;
    if (!file) {
      process.stderr.write("error: bastra patches add <file>\n");
      return 2;
    }
    try {
      const { entry, path } = addPatch(file);
      out(`✓ registered ${entry.id}\n    ${entry.subject}\n    ${path}\n\n`);
      // Registering a patch that does not apply is not an error — it may be
      // meant for a version that is not installed yet — but it is the single
      // most useful thing to know at this moment, so it is not left for later.
      const root = installRoot();
      const [status] = statusAll(root, undefined, installedVersion(root)).filter((s) => s.entry.id === entry.id);
      if (status) {
        out(`Against the current installation: ${STATE_LABEL[status.state]}\n`);
        if (status.detail) out(`  ${status.detail.split("\n")[0]}\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      return 1;
    }
  }

  if (sub === "remove") {
    const id = arg;
    if (!id) {
      process.stderr.write("error: bastra patches remove <id>\n");
      return 2;
    }
    if (!removePatch(id)) {
      process.stderr.write(`error: no patch with id '${id}' — 'bastra patches list' shows the series\n`);
      return 1;
    }
    out(`✓ removed ${id}\n`);
    return 0;
  }

  if (sub === "status") {
    const root = installRoot();
    const series = activePatches();
    if (series.length === 0) {
      out("No patches registered — nothing to check.\n");
      return 0;
    }
    // Both roots when they differ, because which directory the patches are
    // addressed from is the first thing to check when every verdict looks wrong.
    const roots = resolveRoots(root);
    out(`Installation: ${roots.boot}\n`);
    if (roots.apply !== roots.boot) out(`Patches apply from: ${roots.apply}\n`);
    out(`\n`);
    let conflicts = 0;
    for (const s of statusAll(root, undefined, installedVersion(root))) {
      out(`  ${STATE_LABEL[s.state]}  ${s.entry.id}\n      ${s.entry.subject}\n`);
      if (s.detail) out(`      ${s.detail.split("\n")[0]}\n`);
      if (s.state === "conflict") conflicts++;
    }
    // A dry run over the whole series says something the per-patch probes cannot:
    // which ones would be retired, in the order they would actually run.
    const plan = applySeries(root, { dryRun: true, version: installedVersion(root) });
    if (plan.retired.length || plan.applied.length || plan.setAside.length) {
      out(`\nOn the next update:\n${formatApplyOutcome(plan)}`);
    }
    return conflicts > 0 ? 1 : 0;
  }

  process.stderr.write(`error: unknown sub-command '${sub}'\n\n`);
  usage();
  return 2;
}

/** Compact line for the status panel / SessionStart hint — empty when there is
 *  nothing worth saying, so neither surface prints a header for no content. */
export function patchesSummaryLine(home = homedir()): string {
  const idx = readIndex(home);
  const active = idx.patches.filter((p) => !p.retired_at);
  if (active.length === 0) return "";
  return `${active.length} local patch${active.length === 1 ? "" : "es"} registered — reapplied after each update (bastra patches status)`;
}
