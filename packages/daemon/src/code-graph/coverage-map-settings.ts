/**
 * Whether the Bash lane may collect coverage from the agent's own test runs
 * (#629, experimental). Default OFF.
 *
 * WHY ITS OWN SWITCH, NEXT TO `promptImpact.enabled`. Collecting means the
 * hook rewrites a command the agent wrote — `export NODE_V8_COVERAGE=…;` in
 * front of `npm test`. That is a change to someone else's command and must
 * only ever happen when the user asked for exactly that (owner decision in
 * #629), not as a side effect of enabling code awareness for a repository.
 * Code awareness per repository (`code.repos`) is still required on top: a
 * repository nobody enabled gets no map, switch or no switch.
 *
 * Same resolution as the other opt-ins: `BASTRA_COVERAGE_MAP` wins when it is
 * a recognised value, else the stored setting, else off.
 */
import { mutateSettings, readSettings, settingsFilePath } from "../settings.js";
import { isOffValue, isOnValue } from "../env.js";
import { foldCoverage } from "./coverage-map.js";
import { isRepoEnabledSync } from "./enabled-repos.js";

export const COVERAGE_MAP_DEFAULT = false;

export async function getCoverageMapEnabled(
  path: string = settingsFilePath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isOnValue(env.BASTRA_COVERAGE_MAP)) return true;
  if (isOffValue(env.BASTRA_COVERAGE_MAP)) return false;
  return (await readSettings(path)).coverageMap?.enabled ?? COVERAGE_MAP_DEFAULT;
}

/** Persists the opt-in atomically, merging into existing settings. */
export async function setCoverageMapEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, coverageMap: { enabled: on } }));
}

/** Recheck when the debounce fires: the owner may have disabled collection
 * since enqueue. Leave pending raw files and any existing map untouched. */
export async function foldCoverageIfEnabled(repoRoot: string): Promise<unknown> {
  if (!(await getCoverageMapEnabled()) || !isRepoEnabledSync(repoRoot)) return;
  return foldCoverage(repoRoot);
}
