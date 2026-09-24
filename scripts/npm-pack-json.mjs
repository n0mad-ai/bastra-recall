/**
 * The entry for package `name` in the stdout of `npm pack --json`.
 *
 * npm ≤ 11 prints an array of entries, npm 12 an object keyed by package name.
 * Either is read, the entry is picked by name (a workspace pack lists several),
 * and anything else throws: a reader that shrugs returns `undefined` fields,
 * and two `undefined` digests compare equal.
 *
 * Lifecycle output may precede the JSON; the JSON starts at the first line that
 * opens with `[` or `{`.
 *
 * @param {string} stdout
 * @param {string} name
 * @returns {{ name: string, integrity?: string, shasum?: string, files?: Array<{ path: string }> }}
 */
export function packEntry(stdout, name) {
  const start = stdout.search(/^[[{]/m);
  let parsed;
  try {
    parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch (err) {
    throw new Error(`npm pack --json for ${name}: unreadable output (${err.message}): ${stdout.slice(0, 200)}`);
  }
  const entry = Array.isArray(parsed) ? parsed.find((e) => e?.name === name) : parsed?.[name];
  if (entry?.name !== name) {
    throw new Error(`npm pack --json: no entry for ${name} in: ${stdout.slice(0, 200)}`);
  }
  return entry;
}
