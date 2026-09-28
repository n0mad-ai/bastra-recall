/**
 * `bastra reconcile <other-store> [--dry-run | --yes] [--json]` (#339) — compare
 * two stores of the same vault and say which copy of each memory is ahead.
 * Dry run is the default; `--yes` copies the unambiguous cases with a backup.
 * Conflicts are listed and left alone. The comparison lives in
 * core/src/store-reconcile.ts.
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
import type { ParsedArgs } from "./types.js";

const USAGE =
  "usage: bastra reconcile <other-store> [--vault <this-store>]   show which copy is ahead (dry run)\n" +
  "       bastra reconcile <other-store> --yes                     copy the unambiguous ones, with backup";

const REASON: Record<string, string> = {
  "both-changed": "both sides have audited writes the other lacks",
  unrecorded: "content differs, neither audit log says why (edited outside bastra?)",
  "deleted-on-one-side": "deleted on one side, still present on the other",
  "duplicate-id": "two files with this id in one store",
  "path-taken": "the other store already has a different file at this path",
};

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function describeDiff(d: { fields: string[]; paragraphsOnlyA: number; paragraphsOnlyB: number } | undefined): string {
  if (!d) return "";
  const parts: string[] = [];
  if (d.paragraphsOnlyA || d.paragraphsOnlyB) parts.push(`paragraphs: ${d.paragraphsOnlyA} only here, ${d.paragraphsOnlyB} only there`);
  if (d.fields.length) parts.push(`fields: ${d.fields.join(", ")}`);
  return parts.length ? `  (${parts.join("; ")})` : "";
}

export function formatPlan(plan: ReconcilePlan): string {
  const count = (s: { files: Map<string, unknown[]> }) => [...s.files.values()].reduce((n, l) => n + l.length, 0);
  const same = plan.items.filter((i): i is Extract<PlanItem, { kind: "same" }> => i.kind === "same");
  const copies = plan.items.filter((i): i is Extract<PlanItem, { kind: "copy" }> => i.kind === "copy");
  const conflicts = plan.items.filter((i): i is Extract<PlanItem, { kind: "conflict" }> => i.kind === "conflict");
  const lines = [
    `this store:  ${plan.a.root}  (${count(plan.a)} memories)`,
    `other store: ${plan.b.root}  (${count(plan.b)} memories)`,
    `same:        ${same.length}` +
      (same.some((s) => s.bytesDiffer) ? `  (${same.filter((s) => s.bytesDiffer).length} differ only in generated fields/blocks)` : ""),
  ];
  const group = (title: string, items: Extract<PlanItem, { kind: "copy" }>[]) => {
    if (items.length === 0) return;
    lines.push(`${title}: ${items.length}`);
    for (const i of items) {
      const audit = i.carryAudit.length ? `  [${i.carryAudit.length} audit entr${i.carryAudit.length === 1 ? "y" : "ies"} the other lacks]` : "";
      lines.push(`  ${i.id}  ${i.source.rel}${audit}${describeDiff(i.diff)}`);
    }
  };
  group("this ahead → copy to other", copies.filter((c) => c.from === "a" && c.why === "ahead"));
  group("other ahead → copy here", copies.filter((c) => c.from === "b" && c.why === "ahead"));
  group("only here → copy to other", copies.filter((c) => c.from === "a" && c.why === "only-here"));
  group("only there → copy here", copies.filter((c) => c.from === "b" && c.why === "only-here"));
  if (conflicts.length) {
    lines.push(`conflicts (left alone, decide by hand): ${conflicts.length}`);
    for (const c of conflicts) {
      const where = [...(c.a ?? []).map((f) => `here:${f.rel}`), ...(c.b ?? []).map((f) => `there:${f.rel}`)].join(" ");
      lines.push(`  ${c.id}  ${REASON[c.reason]}  ${where}${describeDiff(c.diff)}`);
    }
  }
  const blind = [...plan.a.unreadable, ...plan.b.unreadable];
  if (blind.length) lines.push(`unreadable (not compared): ${blind.join(", ")}`);
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
          kind: i.kind, id: i.id, from: i.from === "a" ? "this" : "other", why: i.why,
          source: i.source.rel, target: i.target?.rel ?? i.source.rel, audit_entries: i.carryAudit.length, diff: i.diff,
        };
      }
      return {
        kind: i.kind, id: i.id, reason: i.reason,
        here: (i.a ?? []).map((f) => f.rel), there: (i.b ?? []).map((f) => f.rel),
        audit_only_here: i.onlyA, audit_only_there: i.onlyB, diff: i.diff,
      };
    }),
    unreadable: [...plan.a.unreadable, ...plan.b.unreadable],
  };
}

export async function cmdReconcile(args: ParsedArgs, now: Date = new Date()): Promise<number> {
  const otherArg = args.positional[1];
  if (!otherArg) {
    console.error(USAGE);
    return 2;
  }
  if (args.yes && args.dryRun) {
    console.error("bastra reconcile: --yes and --dry-run exclude each other");
    return 2;
  }
  const vault = await resolveVault({ dryRun: true, vaultPath: args.vaultPath });
  if ("error" in vault) {
    console.error(`bastra reconcile: ${vault.error}`);
    return 2;
  }
  const here = resolve(vault.path);
  const there = resolve(otherArg);
  for (const p of [here, there]) {
    if (!(await isDir(p))) {
      console.error(`bastra reconcile: not a directory: ${p}`);
      return 2;
    }
  }
  if ((await realpath(here)) === (await realpath(there))) {
    console.error("bastra reconcile: both paths are the same store");
    return 2;
  }
  const plan = await planReconcile(await loadStore(here), await loadStore(there));
  if (!args.yes) {
    if (args.json) console.log(JSON.stringify({ dry_run: true, ...(planJson(plan) as object) }));
    else {
      console.log(formatPlan(plan));
      const n = plan.items.filter((i) => i.kind === "copy").length;
      console.log(n
        ? `\ndry run — nothing written. 'bastra reconcile ${otherArg} --yes' copies the ${n} above; ` +
          `overwritten files go to <store>/.bastra/reconcile-backup/${backupStamp(now)}/ first.`
        : "\nnothing to copy.");
    }
    return 0;
  }
  const results = await applyReconcile(plan, now);
  if (args.json) {
    console.log(JSON.stringify({ dry_run: false, ...(planJson(plan) as object), results }));
  } else {
    console.log(formatPlan(plan));
    console.log("");
    for (const r of results) {
      console.log(r.status === "copied"
        ? `copied   ${r.id} → ${r.target}${r.backup ? `  (backup: ${r.backup})` : ""}`
        : `skipped  ${r.id}: ${r.reason}`);
    }
    if (results.length === 0) console.log("nothing to copy.");
  }
  return results.some((r) => r.status === "skipped") ? 1 : 0;
}
