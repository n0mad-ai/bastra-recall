/**
 * Core's reading of an on/off env value: 0 | false | off | no is off,
 * 1 | true | on | yes is on — any case, surrounding whitespace ignored.
 * Anything else, unset included, is neither.
 *
 * A copy of `isOffValue` / `isOnValue` in the daemon's `env.ts`, and it has to
 * be one: core cannot import the daemon, and `env.ts` cannot import core — it
 * is compiled into the hook stub (`deno compile`), which carries no workspace
 * package. `env-switch-parity-787.test.ts` in the daemon holds the two to the
 * same answers.
 */
export function isOffValue(raw: string | undefined | null): boolean {
  return ["0", "false", "off", "no"].includes((raw ?? "").trim().toLowerCase());
}

/** The counterpart for opt-ins: 1 | true | on | yes. */
export function isOnValue(raw: string | undefined | null): boolean {
  return ["1", "true", "on", "yes"].includes((raw ?? "").trim().toLowerCase());
}
