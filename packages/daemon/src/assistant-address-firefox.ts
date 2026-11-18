/**
 * The Firefox side of the assistant address: which profiles' user.js the
 * address touches, which retired preferences it owns, and writing or
 * restoring exactly its own edits while Firefox is closed. Split out of
 * assistant-address.ts (#1532); the lifecycle there decides when.
 */
import { execFile } from "node:child_process";
import { join, dirname, resolve, sep } from "node:path";
import { rm } from "node:fs/promises";
import { withPathLock } from "./path-lock.js";
import { patchFirefoxUserJs, retiredFirefoxPreference } from "./assistant-address-files.js";
import { assistantAddressOptions, atomic, optional, state } from "./assistant-address-options.js";
import { addressWords } from "./assistant-address-words.js";

type AddressState = Awaited<ReturnType<typeof state>>;

export function profileAllowed(path: string, root: string) {
  const p = resolve(path),
    r = resolve(root);
  return p.startsWith(r + sep) && p.endsWith(sep + "user.js");
}
/** The user.js files of the profiles in profiles.ini, plus the ones the address wrote before. */
async function profileUserFiles(o: ReturnType<typeof assistantAddressOptions>, previous: AddressState) {
  const files = new Set((previous?.firefoxFiles ?? []).filter((p) => profileAllowed(p, o.firefoxRoot)));
  const ini = await optional(join(o.firefoxRoot, "profiles.ini"));
  if (ini)
    for (const section of ini.split(/^\[/m)) {
      const path = /^Path=(.+)$/m.exec(section)?.[1]?.trim();
      if (!path) continue;
      const relative = /^IsRelative=1\s*$/m.test(section),
        file = join(relative ? resolve(o.firefoxRoot, path) : resolve(path), "user.js");
      if (profileAllowed(file, o.firefoxRoot)) files.add(file);
    }
  return files;
}
export async function profileEdits(o: ReturnType<typeof assistantAddressOptions>, name: string | null) {
  const previous = await state(o),
    files = await profileUserFiles(o, previous);
  const edits = [];
  for (const path of files) {
    const before = await optional(path);
    edits.push({ path, before, after: patchFirefoxUserJs(before ?? "", name, o.uid) });
    if (before && previous?.firefoxOwnedPrefs?.[path]?.includes(previous.name ?? "")) {
      const prefs = join(dirname(path), "prefs.js"),
        persisted = await optional(prefs);
      if (persisted !== null) {
        const after = retiredFirefoxPreference(persisted, before, name, o.uid, true);
        if (after !== persisted) edits.push({ path: prefs, before: persisted, after });
      }
    }
  }
  return edits;
}
export async function firefoxOwnership(
  o: ReturnType<typeof assistantAddressOptions>,
  name: string,
  profiles: Array<{ path: string }>
) {
  const previous = await state(o),
    result: Record<string, string[]> = {};
  for (const { path } of profiles.filter((p) => p.path.endsWith(sep + "user.js"))) {
    const persisted = (await optional(join(dirname(path), "prefs.js"))) ?? "";
    const key = `browser.fixup.domainwhitelist.${name}`;
    const alreadyOwned = previous?.firefoxOwnedPrefs?.[path]?.includes(name);
    // A preference present before installation is user-owned, including false.
    if (alreadyOwned || !persisted.includes(key)) result[path] = [name];
  }
  return result;
}
export async function requireFirefoxClosed(
  o: ReturnType<typeof assistantAddressOptions>,
  edits: Array<{ before: string | null; after: string }>
) {
  if (!edits.some((e) => e.before !== e.after)) return;
  const running = o.firefoxRunning
    ? await o.firefoxRunning()
    : await new Promise<boolean>((resolve, reject) => {
        if (o.platform !== "darwin") {
          resolve(false);
          return;
        }
        execFile("/usr/bin/pgrep", ["-ix", "firefox"], (error) => {
          if (!error) resolve(true);
          else if ((error as { code?: number | string }).code === 1) resolve(false);
          else reject(new Error(addressWords(o.language).firefoxUnknown));
        });
      });
  if (running) throw new Error(addressWords(o.language).firefoxOpen);
}
export async function applyProfiles(edits: Array<{ path: string; before: string | null; after: string }>) {
  for (const e of edits)
    if (e.before !== e.after) {
      await withPathLock(e.path, async () => {
        if ((await optional(e.path)) !== e.before) throw new Error("Firefox preference changed during setup — retry");
        if (!e.after) {
          if (e.before !== null) await rm(e.path);
        } else await atomic(e.path, e.after);
      });
    }
}
export async function restoreProfiles(edits: Array<{ path: string; before: string | null; after: string }>) {
  for (const e of [...edits].reverse())
    await withPathLock(e.path, async () => {
      // Never undo a user's concurrent edit; restore only our exact output.
      if ((await optional(e.path)) !== e.after) return;
      if (e.before === null) await rm(e.path, { force: true });
      else await atomic(e.path, e.before);
    });
}
