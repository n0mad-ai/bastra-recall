/**
 * #1484: read before the schema parse — `SaveMemoryInput` strips unknown keys,
 * so a `dry_run` the schema never saw would silently turn into a real write.
 * A non-boolean value is refused for the same reason: guessing "false" writes.
 */
export function isDryRun(rawArgs: unknown): boolean {
  if (!rawArgs || typeof rawArgs !== "object") return false;
  const value = (rawArgs as Record<string, unknown>).dry_run;
  if (value === undefined || typeof value === "boolean") return value === true;
  throw new Error("save_memory: dry_run must be true or false. Nothing was written.");
}
