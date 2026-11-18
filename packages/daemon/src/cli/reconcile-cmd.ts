/**
 * `bastra reconcile <other-store> [--dry-run | --yes] [--json]` (#339) — compare
 * two stores of the same vault and say which copy of each memory is ahead.
 * Dry run is the default; `--yes` copies the unambiguous cases with a backup.
 * Conflicts are listed and left alone. The comparison lives in
 * core/src/store-reconcile.ts.
 *
 * Without `<other-store>` it lists the copies store discovery finds
 * (store-discovery.ts: settings, symlinks, sync folders) and, when exactly one
 * other copy exists, prints the dry run against it. Writing (`--yes`) always
 * takes the store as an argument.
 */
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyReconcile,
  backupStamp,
  loadStore,
  planReconcile,
  type PlanItem,
  type ReconcilePlan,
} from "@bastra-recall/core";
import { resolveVault } from "./helpers.js";
import {
  defaultStoreDiscoveryEnv,
  discoverStores,
  formatDiscovery,
  type StoreDiscoveryEnv,
} from "./store-discovery.js";
import type { ParsedArgs } from "./types.js";
import { usageBlocksIn } from "./usage-block-words.js";
import { reconcileCmdWordsIn, type ReconcileCmdWords } from "./reconcile-cmd-words.js";
import { taskCliLanguage } from "./task-cli-words.js";

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function describeDiff(
  d: { fields: string[]; paragraphsOnlyA: number; paragraphsOnlyB: number } | undefined,
  w: ReconcileCmdWords
): string {
  if (!d) return "";
  const parts: string[] = [];
  if (d.paragraphsOnlyA || d.paragraphsOnlyB) parts.push(w.paragraphs(d.paragraphsOnlyA, d.paragraphsOnlyB));
  if (d.fields.length) parts.push(w.fields(d.fields.join(", ")));
  return parts.length ? `  (${parts.join("; ")})` : "";
}

export function formatPlan(plan: ReconcilePlan, w: ReconcileCmdWords = reconcileCmdWordsIn("en")): string {
  const count = (s: { files: Map<string, unknown[]> }) => [...s.files.values()].reduce((n, l) => n + l.length, 0);
  const same = plan.items.filter((i): i is Extract<PlanItem, { kind: "same" }> => i.kind === "same");
  const copies = plan.items.filter((i): i is Extract<PlanItem, { kind: "copy" }> => i.kind === "copy");
  const conflicts = plan.items.filter((i): i is Extract<PlanItem, { kind: "conflict" }> => i.kind === "conflict");
  const lines = [
    w.thisStore(plan.a.root, count(plan.a)),
    w.otherStore(plan.b.root, count(plan.b)),
    w.same(same.length) +
      (same.some((s) => s.bytesDiffer) ? w.generatedOnly(same.filter((s) => s.bytesDiffer).length) : ""),
  ];
  const group = (title: string, items: Extract<PlanItem, { kind: "copy" }>[]) => {
    if (items.length === 0) return;
    lines.push(`${title}: ${items.length}`);
    for (const i of items) {
      const audit = i.carryAudit.length ? w.auditEntries(i.carryAudit.length) : "";
      lines.push(`  ${i.id}  ${i.source.rel}${audit}${describeDiff(i.diff, w)}`);
    }
  };
  group(
    w.thisAhead,
    copies.filter((c) => c.from === "a" && c.why === "ahead")
  );
  group(
    w.otherAhead,
    copies.filter((c) => c.from === "b" && c.why === "ahead")
  );
  group(
    w.onlyHere,
    copies.filter((c) => c.from === "a" && c.why === "only-here")
  );
  group(
    w.onlyThere,
    copies.filter((c) => c.from === "b" && c.why === "only-here")
  );
  if (conflicts.length) {
    lines.push(w.conflicts(conflicts.length));
    for (const c of conflicts) {
      const where = [
        ...(c.a ?? []).map((f) => `${w.here}:${f.rel}`),
        ...(c.b ?? []).map((f) => `${w.there}:${f.rel}`),
      ].join(" ");
      lines.push(`  ${c.id}  ${w.reason[c.reason]}  ${where}${describeDiff(c.diff, w)}`);
    }
  }
  const blind = [...plan.a.unreadable, ...plan.b.unreadable];
  if (blind.length) lines.push(w.unreadable(blind.join(", ")));
  return lines.join("\n");
}

function planJson(plan: ReconcilePlan): unknown {
  return {
    this: plan.a.root,
    other: plan.b.root,
    items: plan.items.map((i) => {
      if (i.kind === "same") return i;
      if (i.kind === "copy") {
        return {
          kind: i.kind,
          id: i.id,
          from: i.from === "a" ? "this" : "other",
          why: i.why,
          source: i.source.rel,
          target: i.target?.rel ?? i.source.rel,
          audit_entries: i.carryAudit.length,
          diff: i.diff,
        };
      }
      return {
        kind: i.kind,
        id: i.id,
        reason: i.reason,
        here: (i.a ?? []).map((f) => f.rel),
        there: (i.b ?? []).map((f) => f.rel),
        audit_only_here: i.onlyA,
        audit_only_there: i.onlyB,
        diff: i.diff,
      };
    }),
    unreadable: [...plan.a.unreadable, ...plan.b.unreadable],
  };
}

export async function cmdReconcile(
  args: ParsedArgs,
  now: Date = new Date(),
  discoveryEnv?: StoreDiscoveryEnv
): Promise<number> {
  const otherArg = args.positional[1];
  const language = await taskCliLanguage().catch(() => "en");
  const w = reconcileCmdWordsIn(language);
  if (args.yes && args.dryRun) {
    console.error(w.exclusive);
    return 2;
  }
  if (!otherArg && args.yes) {
    console.error(w.needsOther);
    console.error(usageBlocksIn(language).reconcile);
    return 2;
  }
  const vault = await resolveVault({ dryRun: true, vaultPath: args.vaultPath });
  if ("error" in vault) {
    console.error(w.failed(vault.error));
    return 2;
  }
  const here = resolve(vault.path);
  if (!otherArg) return listStores(here, discoveryEnv ?? (await defaultStoreDiscoveryEnv()), args.json === true, w);
  const there = resolve(otherArg);
  for (const p of [here, there]) {
    if (!(await isDir(p))) {
      console.error(w.notDir(p));
      return 2;
    }
  }
  if ((await realpath(here)) === (await realpath(there))) {
    console.error(w.sameStore);
    return 2;
  }
  const plan = await planReconcile(await loadStore(here), await loadStore(there));
  // Reconcile backups are exempt from the 0600 rule for installer backups
  // (#1524): `applyReconcile` MOVES the replaced vault file into the store's
  // own `.bastra/reconcile-backup/` (a rename, no copy), so the backup is the
  // user's file with the mode it already had. Forcing 0600 would mean a chmod
  // on that file, which is the opposite of keeping it unchanged.
  if (!args.yes) {
    if (args.json) console.log(JSON.stringify({ dry_run: true, ...(planJson(plan) as object) }));
    else {
      console.log(formatPlan(plan, w));
      const n = plan.items.filter((i) => i.kind === "copy").length;
      console.log(n ? w.dryRun(otherArg, n, backupStamp(now)) : w.nothingToCopyAfterPlan);
    }
    return 0;
  }
  const results = await applyReconcile(plan, now);
  if (args.json) {
    console.log(JSON.stringify({ dry_run: false, ...(planJson(plan) as object), results }));
  } else {
    console.log(formatPlan(plan, w));
    console.log("");
    for (const r of results) {
      console.log(
        r.status === "copied" ? w.copied(r.id, r.target, r.backup, r.warning) : w.skipped(r.id, r.reason, r.backup)
      );
    }
    if (results.length === 0) console.log(w.nothingToCopy);
  }
  return results.some((r) => r.status === "skipped") ? 1 : 0;
}

/** `bastra reconcile` without a store: what discovery finds, and the dry run
 *  against the other copy when there is exactly one. */
async function listStores(here: string, env: StoreDiscoveryEnv, json: boolean, w: ReconcileCmdWords): Promise<number> {
  if (!(await isDir(here))) {
    console.error(w.notDir(here));
    return 2;
  }
  const found = await discoverStores(here, env);
  const comparable = found.others.filter((s) => s.exists);
  const plan =
    comparable.length === 1 ? await planReconcile(await loadStore(here), await loadStore(comparable[0].path)) : null;
  if (json) {
    console.log(JSON.stringify({ stores: found, ...(plan ? { dry_run: true, ...(planJson(plan) as object) } : {}) }));
    return 0;
  }
  console.log(formatDiscovery(found));
  if (plan) {
    console.log(w.dryRunAgainst(comparable[0].path));
    console.log(formatPlan(plan, w));
    console.log(w.nothingWritten(comparable[0].path));
  } else if (comparable.length > 1) {
    console.log(w.compareOne);
  }
  return 0;
}
