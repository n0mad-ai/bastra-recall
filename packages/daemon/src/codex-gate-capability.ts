/** Strict runtime-evidence gate (#1300): only codex-cli 0.162.1 was probed.
 * Older, newer and unknown runtimes remain preparation only until verified.
 * Current docs are not a version-pinned runtime guarantee. */
export const CODEX_GATE_VERIFIED_VERSION = "0.162.1";
/** Smallest verified version, not an open-ended supported range. */
export const CODEX_GATE_MIN_VERSION = CODEX_GATE_VERIFIED_VERSION;

export function codexGateSupported(version: string | null | undefined): boolean {
  return version === CODEX_GATE_VERIFIED_VERSION;
}
