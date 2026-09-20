/**
 * Whether the UserPromptSubmit lane may deliver the change-impact block
 * (#607, experimental). Default OFF.
 *
 * WHY OFF BY DEFAULT. The v3 delivered-run registration
 * (`packages/eval/registrations/code-awareness-delivered.json`, result written
 * 2026-09-20) measured exactly this delivery point — `promptImpactNote()`
 * called from the prompt lane, unasked, before the agent's first search —
 * against grep on 44 historical bastra-recall scenarios. Context came back
 * `underpowered` (no repeatable saving shown) and use came back `fail` (the
 * recall guard's confidence interval crossed zero, and arm A independently
 * overlapped the delivered block's own files exactly as often as arm D did —
 * an incremental overlap of zero). See `packages/eval/code-roi/v2/BEFUND.md`,
 * section "Zustellung v3 Endergebnis (20.09.2026)", for the full numbers. A
 * feature not shown to help does not ship enabled by default.
 *
 * WHY THIS IS A SEPARATE FLAG FROM `BASTRA_CODE_AWARENESS`. That kill switch
 * (`enabled-repos.ts`) turns the whole code-awareness feature off, Write/Edit
 * block included — deliberately, so one setting cannot half-disable the
 * feature. The Write/Edit block (`impact-block.ts`, write-lane.ts) was NOT the
 * object of the measurement above and stays on by default; only the prompt
 * lane's own delivery needed a new, narrower switch.
 *
 * WHY THIS FILE AND NOT `settings.ts`. `settings.ts` is already over the
 * 800-line size ceiling; it keeps only the `promptImpact` field's schema
 * (`CliSettings.promptImpact`), and every setter for a feature past that
 * ceiling lives in its own module and goes through the shared
 * `mutateSettings`/`readSettings` transaction — the same split `enabled-repos.ts`
 * already uses for `code.repos`.
 *
 * WHY `promptImpactNote()` ITSELF IS NOT GATED HERE. That function is also
 * called directly by the code-roi measurement harness
 * (`packages/eval/code-roi/v2/delivered-block.mjs`), bypassing the lane
 * entirely, to render arm D from the product's own compiled code regardless of
 * this default — the harness measures the block AS IT SHIPS, not the
 * lane-level opt-in around it. Gating `promptImpactNote()` would silence the
 * harness along with the live lane. The gate therefore lives one level up, in
 * `deliverPromptImpact()` (`prompt-impact.ts`), which only the live prompt
 * lane calls.
 */
import { mutateSettings, readSettings, settingsFilePath } from "../settings.js";

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no"]);

export const PROMPT_IMPACT_DEFAULT = false;

/**
 * The effective on/off state: `BASTRA_PROMPT_IMPACT` wins when set to a
 * recognized value, else the stored setting, else the default (off).
 */
export async function getPromptImpactEnabled(
  path: string = settingsFilePath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const raw = (env.BASTRA_PROMPT_IMPACT ?? "").toLowerCase();
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return (await readSettings(path)).promptImpact?.enabled ?? PROMPT_IMPACT_DEFAULT;
}

/** Persists the opt-in atomically, merging into existing settings. */
export async function setPromptImpactEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, promptImpact: { enabled: on } }));
}
