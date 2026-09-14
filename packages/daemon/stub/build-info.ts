/**
 * What a compiled `bastra-hook` says about its own build (#546).
 *
 * `scripts/build-stub.mjs` overwrites this file with the real values just
 * before `deno compile` runs, and restores the placeholder below afterwards —
 * so the stamp is baked into the binary without the build leaving a dirty
 * working tree behind. Running the stub from source (`node stub/bastra-hook.ts`,
 * `npx tsx stub/bastra-hook.ts`) therefore reports an empty digest, which is
 * the truth: there is no build, so there is no built revision to report. The
 * same distinction `ownBuildStamp()` makes for `dist` (#528).
 *
 * `bastra-hook version` prints this as JSON. That is the only way to ask a
 * compiled binary which sources it came from — the binary installed on the dev
 * host was from 29.08. and had run for two weeks against sources that had long
 * moved on, and nothing could see it.
 */
export interface StubBuildInfo {
  /** sha256 over the stub's source closure — see scripts/stub-source-digest.mjs.
   *  Empty string when running from source rather than from a compiled binary. */
  source_digest: string;
  /** Commit the binary was built from, or null when there was no git. */
  revision: string | null;
  /** Did the stub's OWN sources differ from HEAD at build time? Scoped to the
   *  files that go into the binary, not to the repo: an unrelated scratch file
   *  in the checkout made every clean build report `true`, and a flag that is
   *  always `true` cannot show anyone a build that really was dirty (#546).
   *  See `stubSourcesDirty()` in scripts/stub-source-digest.mjs. */
  dirty: boolean;
  /** ISO timestamp of the build, or null when running from source. */
  built_at: string | null;
}

export const STUB_BUILD_INFO: StubBuildInfo = {
  source_digest: "",
  revision: null,
  dirty: false,
  built_at: null,
};
