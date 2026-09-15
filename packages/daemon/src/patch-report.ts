/**
 * What a patch run leaves behind for people: the last-run record, the one-line
 * rendering shared by `bastra patches` and `bastra update`, and the session
 * notice for patches that are still waiting. Split out of patch-registry.ts,
 * which holds the series and the git mechanics (file-size convention).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { activePatches, lastRunPath, patchesDir, readLastRun, type ApplyOutcome, type LastRun } from "./patch-registry.js";

export function writeLastRun(o: ApplyOutcome, home = homedir()): void {
  try {
    mkdirSync(patchesDir(home), { recursive: true, mode: 0o700 });
    const rec: LastRun = {
      at: new Date().toISOString(),
      // A kept patch is still on the tree, so it counts as applied for the next run.
      applied: [...o.applied, ...(o.kept ?? [])].map((e) => e.id),
      retired: o.retired.map((e) => e.id),
      setAside: o.setAside.map((s) => ({ id: s.entry.id, subject: s.entry.subject, detail: s.detail })),
      rolledBack: o.rolledBack,
      ...(o.unrestored?.length ? { unrestored: o.unrestored } : {}),
      ...(o.smokeError ? { smokeError: o.smokeError } : {}),
      ...(o.tree ? { root: o.tree.root, ...(o.tree.version ? { version: o.tree.version } : {}) } : {}),
    };
    writeFileSync(lastRunPath(home), JSON.stringify(rec, null, 2) + "\n", "utf8");
  } catch {
    // A record that cannot be written costs a notice, never an update.
  }
}

/**
 * The part of the last run that still stands, as one block of text — or null.
 *
 * Filtered against the CURRENT series on purpose: a patch the user removed or
 * fixed since the update must stop being reported, and the record itself has no
 * way to know that happened. Reporting a resolved problem forever is how a
 * notice surface teaches people to ignore it.
 */
export function pendingPatchNotice(home = homedir()): string | null {
  const rec = readLastRun(home);
  if (!rec) return null;
  const stillActive = new Set(activePatches(home).map((p) => p.id));
  const aside = rec.setAside.filter((s) => stillActive.has(s.id));
  const unrestored = rec.unrestored ?? [];
  if (aside.length === 0 && !rec.rolledBack && unrestored.length === 0) return null;

  const lines: string[] = [];
  if (rec.rolledBack) {
    // Patches kept from an earlier run were never touched by the reversal, and
    // the record lists exactly those as still applied.
    const stillOn = rec.applied.length;
    lines.push(
      `The last update reapplied local patches, the patched install failed its boot check, ` +
        `and every patch applied in that run was reversed. ` +
        (stillOn > 0
          ? `${stillOn} patch${stillOn === 1 ? "" : "es"} from an earlier run ${stillOn === 1 ? "is" : "are"} still on this install.`
          : `bastra is running unpatched.`),
    );
    if (rec.smokeError) lines.push(`Boot error: ${rec.smokeError.split("\n")[0]}`);
  } else if (unrestored.length > 0) {
    // The one notice that must not read like the line above it: "running
    // unpatched" would send the operator looking in the wrong place entirely.
    lines.push(
      `The last update reapplied local patches, the patched install failed its boot check, and ` +
        `reversing that run did not put everything back. This install is now neither patched nor the ` +
        `one the updater produced — what did not go back:`,
    );
    for (const u of unrestored) lines.push(`  · ${u}`);
    lines.push(
      `A 3-way merge cannot be undone by reversing the patch, which is why the reversal stopped short. ` +
        `The pre-update backup under ~/.bastra/update-backups still holds these files as they were — ` +
        `put them back by hand before trusting this install.`,
    );
    if (rec.smokeError) lines.push(`Boot error: ${rec.smokeError.split("\n")[0]}`);
  }
  if (aside.length > 0) {
    lines.push(
      `${aside.length} local patch${aside.length === 1 ? "" : "es"} could not be reapplied after the last update ` +
        `(${rec.at.slice(0, 10)}) and ${aside.length === 1 ? "was" : "were"} set aside, never forced:`,
    );
    for (const s of aside) lines.push(`  · ${s.id} — ${s.subject}`);
    lines.push(
      `Upstream most likely moved the code they touch. 'bastra patches status' shows the conflicting hunks; ` +
        `the pre-update backup under ~/.bastra/update-backups still holds the files as they were.`,
    );
  }
  return lines.join("\n");
}

/** One-line-per-fact rendering, shared by `bastra patches status` and the
 *  update path so both report a series the same way. */
export function formatApplyOutcome(o: ApplyOutcome): string {
  if (o.skipped) return `  ${o.skipped}\n`;
  const lines: string[] = [];
  for (const e of o.applied) lines.push(`  ✓ applied   ${e.id} — ${e.subject}`);
  for (const e of o.kept ?? []) lines.push(`  = kept      ${e.id} — still on this install from the last run`);
  for (const e of o.retired) lines.push(`  ↩ retired   ${e.id} — merged upstream, dropped from the series`);
  for (const s of o.setAside) {
    lines.push(`  ⚠ set aside ${s.entry.id} — ${s.entry.subject}`);
    const first = s.detail.split("\n")[0]?.trim();
    if (first) lines.push(`              ${first}`);
  }
  if (o.rolledBack) {
    lines.push(`  ✗ the patched install did not boot — every patch from this run was reversed`);
    if (o.smokeError) lines.push(`    ${o.smokeError.split("\n")[0]}`);
  } else if (o.unrestored?.length) {
    lines.push(`  ✗ the patched install did not boot, and the reversal did not put everything back:`);
    for (const u of o.unrestored) lines.push(`    · ${u}`);
    if (o.smokeError) lines.push(`    ${o.smokeError.split("\n")[0]}`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}
