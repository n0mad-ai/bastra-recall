import { randomUUID } from "node:crypto";
import { link, rename } from "node:fs/promises";
import type { CueBatchReport } from "@bastra-recall/core";

/** A per-run sibling: generation never touches another run's partial output. */
export function cuePartialPath(out: string): string {
  return `${out}.${process.pid}.${randomUUID()}.partial`;
}

/** Publish a complete sidecar atomically. Without overwrite, a hard link
 * claims the destination exclusively even if another run finished during
 * generation; the caller removes its temporary name in finally. */
export async function publishCueSidecar(partial: string, out: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    await rename(partial, out);
    return;
  }
  try {
    await link(partial, out);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${out} wurde während des Laufs angelegt — kein Overwrite ohne BASTRA_CUE_OVERWRITE=1`);
    }
    throw err;
  }
}

/** Publish only a successful run (#427). A run the generation brake stopped,
 * or one that wrote no cue although it saw memories, has failed: it throws
 * before publishing, and the previous sidecar stays. */
export async function publishCueRun(
  report: CueBatchReport,
  partial: string,
  out: string,
  overwrite: boolean,
): Promise<void> {
  if (report.stopped_early || (report.memories_seen > 0 && report.cues_written === 0)) {
    throw new Error(
      `Lauf nicht erfolgreich (${report.stopped_early ? "von der Generierungsbremse gestoppt" : "keine Cues geschrieben"}) — ` +
        `${JSON.stringify(report)} — bestehendes Sidecar unverändert`,
    );
  }
  await publishCueSidecar(partial, out, overwrite);
}

/** The end of a cue run (#427), as main() calls it: a run that lost the
 * vector arm fails, a dry run publishes nothing, everything else goes
 * through publishCueRun. */
export async function finishCueRun(
  report: CueBatchReport,
  opts: { armLost: string | undefined; dryRun: boolean; partial: string; out: string; overwrite: boolean },
): Promise<void> {
  if (opts.armLost !== undefined) {
    throw new Error(`der Vektorarm ist während des Laufs ausgefallen (${opts.armLost}) — kein Sidecar geschrieben`);
  }
  if (!opts.dryRun) await publishCueRun(report, opts.partial, opts.out, opts.overwrite);
}
