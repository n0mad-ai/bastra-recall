import { createHash } from "node:crypto";

/** Shared locale-independent task JSON: object keys use UTF-16 code-unit order. */
export function canonicalTaskValue(value: unknown): string {
  if (Array.isArray(value)) return `[${Array.from(value, canonicalTaskValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalTaskValue(v)}`)
      .join(",")}}`;
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/** SHA-256 hex of a task value; the primitive below task events and freshness (#1515 B6). */
export function taskValueHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
