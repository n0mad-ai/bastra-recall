/**
 * What may NOT enter the delivered-impact population, and why (#582).
 *
 * The measurement compares an agent with the code-awareness tool against an
 * agent with grep. Its population has to be blind in two directions at once,
 * and each direction excludes different things:
 *
 *   BURNED BY EARLIER MEASUREMENTS. Every file that was already a scenario's
 *   changed file in the v3 archive (45 scenarios) or the v4 archive (9) has
 *   had its truth set adjudicated by hand and read while tuning adoption. The
 *   exclusion is at FILE level, not commit level: a second change to the same
 *   file is still a change to code whose impact has been looked at, and the
 *   thresholds were moved against exactly that evidence. Same for the two
 *   pilot commits of registration 3, which the pilot's own author read.
 *
 *   THE CODE BEING WORKED ON. `packages/daemon/src/code-graph/` is the product
 *   under measurement and `packages/eval/` is the measurement apparatus. Both
 *   are being changed while this population is mined. A scenario there would
 *   ask the tool about its own source, and its truth set would depend on which
 *   half-finished state happened to be on disk — so neither can be a scenario,
 *   whatever it would score.
 *
 * The list is data, not judgement: it is read from the archives at run time and
 * hashed into `population.json`, so a later run against a different exclusion
 * set is visibly a different population rather than silently the same one.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Scenario archives whose changed files are spent. */
export const BURNED_ARCHIVES = [
  resolve(homedir(), ".bastra", "eval", "code-roi-v2", "scenarios.json"),
  resolve(homedir(), ".bastra", "eval", "code-roi-v4", "scenarios.json"),
];

/** Path prefixes that are never a scenario, with the reason each is out. */
export const EXCLUDED_PREFIXES = [
  ["packages/daemon/src/code-graph/", "the product under measurement"],
  ["packages/eval/", "the measurement apparatus itself"],
];

/**
 * The pilot of registration 3: two commits and the two files they changed.
 * Read from the registration rather than repeated here, so the exclusion
 * cannot drift away from the document that declared it.
 */
function pilotOf(registrationPath) {
  try {
    const reg = JSON.parse(readFileSync(registrationPath, "utf8"));
    const pilot = reg?.sample?.excluded_pilot ?? {};
    return { commits: pilot.commits ?? [], files: pilot.files ?? [] };
  } catch {
    return { commits: [], files: [] };
  }
}

/**
 * Build the exclusion set.
 *
 * A missing archive is an ERROR, not an empty exclusion: a population mined
 * without the burned list would look like a valid sample and quietly reuse
 * scenarios the thresholds were tuned on.
 */
export function buildExclusions({
  archives = BURNED_ARCHIVES,
  registration = new URL("../../registrations/code-awareness-change-impact.json", import.meta.url).pathname,
  extraFiles = [],
} = {}) {
  const files = new Set(extraFiles);
  const sources = [];
  for (const path of archives) {
    if (!existsSync(path)) {
      throw new Error(
        `exclusion archive missing: ${path}. Refusing to mine — without it the ` +
          `population would silently reuse scenarios the thresholds were tuned on.`,
      );
    }
    const scenarios = JSON.parse(readFileSync(path, "utf8")).scenarios ?? [];
    for (const s of scenarios) if (typeof s.file === "string") files.add(s.file);
    sources.push({ path, scenarios: scenarios.length });
  }

  const pilot = pilotOf(registration);
  for (const f of pilot.files) files.add(f);

  return {
    files: [...files].sort(),
    commits: [...pilot.commits].sort(),
    prefixes: EXCLUDED_PREFIXES.map(([prefix]) => prefix),
    reasons: Object.fromEntries(EXCLUDED_PREFIXES),
    sources,
  };
}

/** True when a candidate file is excluded, by file identity or by prefix. */
export function isExcludedFile(exclusions, file) {
  return exclusions.files.includes(file) || exclusions.prefixes.some((p) => file.startsWith(p));
}

/**
 * A hash over the whole exclusion set, for `population.json`. Changing the set
 * changes the population, and this is what makes that visible.
 */
export function exclusionsHash(exclusions) {
  return createHash("sha256")
    .update([...exclusions.files, "--", ...exclusions.commits, "--", ...exclusions.prefixes].join("\n"))
    .digest("hex");
}

/** Where the archives live, for a message that has to say what is missing. */
export const ARCHIVE_ROOT = resolve(homedir(), ".bastra", "eval");
export const archivePath = (name) => join(ARCHIVE_ROOT, name, "scenarios.json");
