/**
 * The one reading of an on/off env value, for core and the daemon alike
 * (the daemon's `env.ts` re-exports both): 0 | false | off | no is off,
 * 1 | true | on | yes is on — any case, surrounding whitespace ignored.
 * Anything else, unset included, is neither.
 */
export function isOffValue(raw: string | undefined | null): boolean {
  return ["0", "false", "off", "no"].includes((raw ?? "").trim().toLowerCase());
}

/** The counterpart for opt-ins: 1 | true | on | yes. */
export function isOnValue(raw: string | undefined | null): boolean {
  return ["1", "true", "on", "yes"].includes((raw ?? "").trim().toLowerCase());
}
