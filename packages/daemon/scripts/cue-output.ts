import { randomUUID } from "node:crypto";
import { link, rename } from "node:fs/promises";

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
