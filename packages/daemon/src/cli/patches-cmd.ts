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
import { usageBlocks } from "./usage-block-words.js";
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
} from "../patch-registry.js";
import { formatApplyOutcome } from "../patch-report.js";
import { patchesCmdWordsIn } from "./patches-cmd-words.js";
import { taskCliLanguage } from "./task-cli-words.js";

const out = (s: string) => process.stdout.write(s);

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
  const w = patchesCmdWordsIn(await taskCliLanguage().catch(() => "en"));

  if (sub === "help" || args.showHelp) {
    out((await usageBlocks()).patches);
    return 0;
  }

  if (sub === "list") {
    const idx = readIndex();
    const active = idx.patches.filter((p) => !p.retired_at);
    const retired = idx.patches.filter((p) => p.retired_at);
    if (idx.patches.length === 0) {
      out(w.noneRegistered(patchesDir()));
      return 0;
    }
    out(w.series(active.length));
    for (const p of active) out(`  ${p.id}\n      ${p.subject}\n      ${w.added(p.added_at.slice(0, 10))}\n`);
    if (retired.length) {
      out(w.retiredHeader(retired.length));
      for (const p of retired)
        out(`  ${p.id} — ${p.retired_reason ?? w.retired} ${p.retired_at?.slice(0, 10) ?? ""}\n`);
    }
    return 0;
  }

  if (sub === "add") {
    const file = arg;
    if (!file) {
      process.stderr.write(w.addUsage);
      return 2;
    }
    try {
      const { entry, path } = addPatch(file);
      out(w.registered(entry.id, entry.subject, path));
      // Registering a patch that does not apply is not an error — it may be
      // meant for a version that is not installed yet — but it is the single
      // most useful thing to know at this moment, so it is not left for later.
      const root = installRoot();
      const [status] = statusAll(root, undefined, installedVersion(root)).filter((s) => s.entry.id === entry.id);
      if (status) {
        out(w.againstInstall(w.state[status.state]));
        if (status.detail) out(`  ${status.detail.split("\n")[0]}\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(w.error((e as Error).message));
      return 1;
    }
  }

  if (sub === "remove") {
    const id = arg;
    if (!id) {
      process.stderr.write(w.removeUsage);
      return 2;
    }
    if (!removePatch(id)) {
      process.stderr.write(w.noSuchPatch(id));
      return 1;
    }
    out(w.removed(id));
    return 0;
  }

  if (sub === "status") {
    const root = installRoot();
    const series = activePatches();
    if (series.length === 0) {
      out(w.nothingToCheck);
      return 0;
    }
    // Both roots when they differ, because which directory the patches are
    // addressed from is the first thing to check when every verdict looks wrong.
    const roots = resolveRoots(root);
    out(w.installation(roots.boot));
    if (roots.apply !== roots.boot) out(w.applyFrom(roots.apply));
    out(`\n`);
    let conflicts = 0;
    for (const s of statusAll(root, undefined, installedVersion(root))) {
      out(`  ${w.state[s.state]}  ${s.entry.id}\n      ${s.entry.subject}\n`);
      if (s.detail) out(`      ${s.detail.split("\n")[0]}\n`);
      if (s.state === "conflict") conflicts++;
    }
    // A dry run over the whole series says something the per-patch probes cannot:
    // which ones would be retired, in the order they would actually run.
    const plan = applySeries(root, { dryRun: true, version: installedVersion(root) });
    if (plan.retired.length || plan.applied.length || plan.setAside.length) {
      out(`${w.nextUpdate}${formatApplyOutcome(plan)}`);
    }
    return conflicts > 0 ? 1 : 0;
  }

  process.stderr.write(w.unknownSub(sub));
  out((await usageBlocks()).patches);
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
