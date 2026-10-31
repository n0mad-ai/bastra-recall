/** Strict runtime-evidence gate: each listed CLI version was separately probed.
 * Older, newer and unknown runtimes remain preparation only until verified.
 * Current docs are not a version-pinned runtime guarantee. */
export const CODEX_GATE_VERIFIED_VERSION = "0.162.1";
export const CODEX_GATE_VERIFIED_VERSIONS: readonly string[] = [CODEX_GATE_VERIFIED_VERSION, "0.166.0"];
/** Smallest verified version, not an open-ended supported range. */
export const CODEX_GATE_MIN_VERSION = CODEX_GATE_VERIFIED_VERSION;

export function codexGateSupported(version: string | null | undefined): boolean {
  return typeof version === "string" && CODEX_GATE_VERIFIED_VERSIONS.includes(version);
}
