/**
 * Which registration an archive belongs to, and which arms it runs (#606).
 *
 * WHY THIS EXISTS. Until now the pipeline knew exactly one registration —
 * `code-awareness-change-impact.json` — and exactly three arms, hard-coded in
 * `select.mjs` as `ARM_IDS` and in `run-arms-v3.mjs` as `ARMS`. #606 adds a
 * SECOND registration with a different arm set (grep + the delivered block),
 * and hard-coding a second list beside the first would mean the runner decides
 * what a measurement is made of. It does not: the registration does, and this
 * module is the one place that reads it.
 *
 * WHAT MUST NOT BREAK. The v6 archive stays scoreable from its own
 * registration, byte for byte. Two rules keep that true:
 *
 *   1. An archive names its registration in `scenarios.json` (`registration`).
 *      v6's scenario file predates the field, so an archive without it falls
 *      back to the change-impact registration — which is what it is.
 *   2. A registration that does not list `arms.ids` gets the frozen v6 list.
 *      The change-impact registration is COMPLETE and may not be amended to
 *      carry a field it never had; the default below is the record of what it
 *      ran, not a new decision.
 *
 * `CODE_ROI_REGISTRATION` overrides the lookup for a dry run against an
 * archive that has no scenario file yet. It cannot change what a started
 * archive is: the build pin carries the registration id and a later helping
 * that disagrees with it aborts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The registration every archive written before #606 belongs to. */
export const DEFAULT_REGISTRATION_ID = "code-awareness-change-impact";

/**
 * The arms of the change-impact registration, as they ran.
 *
 * NOT a default for new registrations — a new one lists its own `arms.ids` and
 * is rejected below if it does not. This is the frozen record of v6.
 */
export const V6_ARM_IDS = ["A", "B", "prefilled"];

export function registrationPath(id = DEFAULT_REGISTRATION_ID) {
  return new URL(`../../registrations/${id}.json`, import.meta.url).pathname;
}

export function loadRegistrationById(id = DEFAULT_REGISTRATION_ID) {
  return JSON.parse(readFileSync(registrationPath(id), "utf8"));
}

/**
 * The registration id an archive belongs to: its own scenario file first, the
 * environment only when there is no scenario file yet, the v6 default last.
 */
export function resolveRegistrationId(outDir) {
  const scenarioFile = join(outDir, "scenarios.json");
  if (existsSync(scenarioFile)) {
    try {
      const id = JSON.parse(readFileSync(scenarioFile, "utf8")).registration;
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      // An unreadable scenario file is the runner's problem a moment later,
      // when it reads it for real; here it simply says nothing about which
      // registration this is.
    }
  }
  const fromEnv = process.env.CODE_ROI_REGISTRATION;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return DEFAULT_REGISTRATION_ID;
}

/** The registration an archive belongs to, loaded. */
export function resolveRegistration(outDir) {
  const id = resolveRegistrationId(outDir);
  return { id, registration: loadRegistrationById(id) };
}

/**
 * The arm ids a registration runs, in the order the runner walks them when a
 * scenario carries no order of its own.
 *
 * A registration that states `arms.ids` decides; the change-impact one, which
 * is complete and unamendable, keeps the list it ran with.
 */
export function armIdsOf(registration, id = DEFAULT_REGISTRATION_ID) {
  const ids = registration?.arms?.ids;
  if (Array.isArray(ids) && ids.length > 0) return [...ids];
  if (id === DEFAULT_REGISTRATION_ID) return [...V6_ARM_IDS];
  throw new Error(
    `registration "${id}" lists no arms.ids — a measurement whose arms are not written down ` +
      `is a measurement whose arms the runner chose.`,
  );
}

/** The pilot commits a registration excludes from its own sample. */
export function excludedPilotCommitsOf(registration) {
  return new Set(registration?.sample?.excluded_pilot?.commits ?? []);
}
