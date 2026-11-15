/**
 * `bastra skills` (#215) — declare-once registry of link targets that live on
 * another surface (Claude Code skills, external docs). Declared ids render as
 * first-class nodes in the map's skills ring instead of "unwritten" ghosts,
 * and the curator stops reporting them as dangling links. No path, no scan,
 * no sync — the id is the whole declaration.
 */
import { Vault, extractWikilinks } from "@bastra-recall/core";
import { addSkill, listSkills, removeSkill, skillsFilePath } from "../skills-registry.js";
import { resolveVault } from "./helpers.js";
import type { ParsedArgs } from "./types.js";

const USAGE =
  "usage: bastra skills list\n" +
  "       bastra skills add <id> [label…]     declare a skill (id = the ghost node it should adopt)\n" +
  "       bastra skills remove <id>           back to ordinary ghost behavior\n";

/** #223: what `skills add <input>` actually resolved to.
 *  - `exact`      the input IS a ghost node id
 *  - `namespaced` the input is the bare slug of exactly one namespaced ghost
 *                 (`uncertainty-check` → `memory-uncertainty-check`), which is
 *                 what an imported vault produces: bodies link the namespaced
 *                 id, the user knows the bare name
 *  - `ambiguous`  more than one ghost ends in that slug — refuse and list them,
 *                 because picking one would be a coin flip the user cannot see
 *  - `unmatched`  no ghost by that name; declaring ahead of the link is fine,
 *                 it just must not be announced as an adoption */
export interface SkillTargetResolution {
  input: string;
  id: string | null;
  kind: "exact" | "namespaced" | "ambiguous" | "unmatched";
  candidates: string[];
}

export function resolveSkillTarget(input: string, ghostIds: readonly string[]): SkillTargetResolution {
  const needle = input.trim().toLowerCase();
  if (ghostIds.some((g) => g.toLowerCase() === needle)) {
    return { input, id: ghostIds.find((g) => g.toLowerCase() === needle)!, kind: "exact", candidates: [] };
  }
  // Separator-anchored on purpose: without the dash, `check` would also claim
  // `memory-recheck`, and a wrong adoption is worse than no adoption.
  const suffix = `-${needle}`;
  const matches = ghostIds.filter((g) => g.toLowerCase().endsWith(suffix));
  if (matches.length === 1) return { input, id: matches[0], kind: "namespaced", candidates: matches };
  if (matches.length > 1) return { input, id: null, kind: "ambiguous", candidates: matches };
  return { input, id: input.trim(), kind: "unmatched", candidates: [] };
}

/** Every wikilink target in the vault that has no memory behind it — the
 *  ghosts the map draws and the curator reports as dangling. Returns null when
 *  no vault can be resolved: the declaration still works then, it just cannot
 *  be checked, and the output says so rather than claiming an adoption. */
async function collectGhostIds(vaultPath: string | null): Promise<string[] | null> {
  if (!vaultPath) return null;
  try {
    const vault = new Vault(vaultPath);
    await vault.init();
    const known = new Set(vault.list().map((m) => String(m.fm.id)));
    const ghosts = new Set<string>();
    for (const m of vault.list()) {
      for (const target of extractWikilinks(m.body ?? "")) {
        if (!known.has(target)) ghosts.add(target);
      }
    }
    await vault.stop?.();
    return [...ghosts];
  } catch {
    return null; // unreadable vault — fall back to declaring verbatim
  }
}

export async function cmdSkills(args: ParsedArgs): Promise<number> {
  const sub = args.surface;
  if (sub === "list" || sub === null) {
    const entries = await listSkills();
    if (entries.length === 0) {
      process.stdout.write(`no skills declared — ${USAGE}`);
      return 0;
    }
    for (const e of entries) {
      process.stdout.write(`  ${e.id}${e.label ? ` — ${e.label}` : ""}${e.note ? ` (${e.note})` : ""}\n`);
    }
    process.stdout.write(`${entries.length} skill(s) · ${skillsFilePath()}\n`);
    return 0;
  }
  if (sub === "add") {
    const id = args.positional[2];
    if (!id) {
      process.stderr.write(USAGE);
      return 2;
    }
    const label = args.positional.slice(3).join(" ") || undefined;
    // #223: resolve against the ghosts that actually exist before declaring
    // anything. In a native vault `[[slug]]` and the node id are the same
    // string; after an import they are not, and the old command happily minted
    // a fresh degree-0 node next to the untouched ghost — while printing that
    // the ghost was now a skill.
    const vault = await resolveVault({ vaultPath: args.vaultPath } as Parameters<typeof resolveVault>[0]);
    const ghosts = await collectGhostIds("path" in vault ? vault.path : null);
    const resolution = ghosts ? resolveSkillTarget(id, ghosts) : null;
    if (resolution?.kind === "ambiguous") {
      process.stderr.write(
        `✗ "${id}" matches ${resolution.candidates.length} ghosts — declare the one you mean:\n` +
          resolution.candidates.map((c) => `    bastra skills add ${c}\n`).join("")
      );
      return 1;
    }
    const targetId = resolution?.id ?? id;
    try {
      const entry = await addSkill({ id: targetId, label });
      const head = `✓ declared skill ${entry.id}${entry.label ? ` — ${entry.label}` : ""}\n`;
      if (resolution?.kind === "namespaced") {
        process.stdout.write(
          head +
            `  resolved "${resolution.input}" → ${entry.id} (the id your notes actually link).\n` +
            `  that ghost now renders in the map's skills ring instead of as an unwritten one.\n`
        );
      } else if (resolution?.kind === "exact") {
        process.stdout.write(
          head + `  that ghost now renders in the map's skills ring instead of as an unwritten one.\n`
        );
      } else if (resolution?.kind === "unmatched") {
        process.stdout.write(
          head +
            `  note: no ghost with this id exists yet — nothing was adopted. It will render as a skill\n` +
            `  as soon as a note links [[${entry.id}]]. Check the id with: bastra map (or 'Mark as skill' there).\n`
        );
      } else {
        process.stdout.write(
          head +
            `  note: no vault could be read, so the id was declared verbatim and not checked against your ghosts.\n`
        );
      }
      return 0;
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      return 1;
    }
  }
  if (sub === "remove") {
    const id = args.positional[2];
    if (!id) {
      process.stderr.write(USAGE);
      return 2;
    }
    const removed = await removeSkill(id);
    process.stdout.write(removed ? `✓ removed ${id}\n` : `not declared: ${id}\n`);
    return removed ? 0 : 1;
  }
  process.stderr.write(USAGE);
  return 2;
}
