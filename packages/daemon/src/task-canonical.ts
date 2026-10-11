/** Shared locale-independent task JSON: object keys use UTF-16 code-unit order. */
export function canonicalTaskValue(value: unknown): string {
  if (Array.isArray(value)) return `[${Array.from(value, canonicalTaskValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalTaskValue(v)}`).join(",")}}`;
  return value === undefined ? "undefined" : JSON.stringify(value);
}
