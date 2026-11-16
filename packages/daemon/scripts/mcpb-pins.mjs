/**
 * The repo's version pins (`overrides` in the root package.json) checked
 * against what the .mcpb staging install actually got. Kept apart from
 * build-mcpb.mjs so it can be tested without running the build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every installed copy of an overridden package, nested copies included,
 * matches its pin. Throws on the first miss. */
export function assertOverrides(serverDir, pins) {
  const lock = JSON.parse(readFileSync(join(serverDir, "package-lock.json"), "utf8"));
  assertLockPackages(lock.packages ?? {}, pins);
}

/** `packages` of a lockfile v2/v3: `node_modules/a/node_modules/hono` is a
 * nested copy of `hono` and is checked like the top-level one. */
export function assertLockPackages(packages, pins) {
  for (const [path, meta] of Object.entries(packages)) {
    if (!path) continue; // the root project itself
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const pin = pins[name];
    if (typeof pin !== "string" || satisfiesPin(meta.version, pin)) continue;
    throw new Error(`${path}@${meta.version} does not satisfy the repo pin ${name}@${pin}`);
  }
}

/** An exact version, or a caret range (`^1.2.3`, `^0.2.6`) as npm reads it. A
 * prerelease (`4.13.19-beta.1`) never satisfies a pin without one: it sorts
 * below its release, and npm keeps prereleases out of a plain caret range. */
export function satisfiesPin(version, pin) {
  if (typeof version !== "string") return false;
  if (!pin.startsWith("^")) return version === pin;
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null;
  };
  const [have, want] = [parse(version), parse(pin.slice(1))];
  if (!have || !want) return false;
  // The pins carry no prerelease; one in the install is never "at least" the pin.
  if (have.pre !== undefined || want.pre !== undefined) return false;
  // Caret: same leftmost non-zero part, and not below the pinned version.
  const fixed = want.parts[0] > 0 ? 1 : want.parts[1] > 0 ? 2 : 3;
  for (let i = 0; i < fixed; i++) if (have.parts[i] !== want.parts[i]) return false;
  for (let i = fixed; i < 3; i++) if (have.parts[i] !== want.parts[i]) return have.parts[i] > want.parts[i];
  return true;
}
