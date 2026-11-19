/**
 * Where bastra's shims live (#650) and the PATH without them. The archiving
 * `rm` and the git snapshots both build on this; it imports neither.
 * Lives next to rm-archive.ts in src/ (and dist/), so `../shims` resolves to
 * the same directory from either file.
 */
import { realpathSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

export const SHIM_DIR = fileURLToPath(new URL("../shims", import.meta.url));

/** PATH with bastra's shims/ taken out. */
export function withoutShims(path: string | undefined): string {
  let shims = SHIM_DIR;
  try {
    shims = realpathSync(SHIM_DIR);
  } catch {
    /* as configured */
  }
  return (path ?? "")
    .split(delimiter)
    .filter((d) => {
      try {
        return realpathSync(d) !== shims;
      } catch {
        return d !== SHIM_DIR;
      }
    })
    .join(delimiter);
}
