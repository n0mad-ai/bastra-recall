/**
 * Skills registry (#215) — declare-once identities for link targets that live
 * on another surface (a Claude Code skill, an external doc), so the map stops
 * rendering them as "unwritten" ghosts and gives them their own `skills` ring.
 *
 * Deliberately the floors.ts shape: a tiny daemon-side JSON state file, atomic
 * tmp+rename, NOT frontmatter — the vault files stay untouched. And
 * deliberately NOT a sync: no path is ever read, no folder scanned, no watcher
 * started. The user declares an id once; recall never opens the file behind
 * it. That is the whole contract — reference, not ingestion.
 *
 * Persistence: ~/.bastra/skills.json (override: BASTRA_SKILLS_PATH).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillRef } from "@bastra-recall/core";
import { withPathLock } from "./path-lock.js";
import { sendJsonPlain } from "./webui.js";
import { getUiEnabled } from "./settings.js";

export interface SkillEntry extends SkillRef {
  /** ISO timestamp, stamped on add. */
  added_at: string;
}

/** Same charset as body wikilinks (save.ts WIKILINK_RE) — the id IS the link
 *  slug the user already writes as [[id]], nothing else resolves. */
const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** Generous cap — the registry classifies graph nodes, it costs no context;
 *  the cap only guards against a runaway script filling the file. */
export const MAX_SKILLS = 64;

export function skillsFilePath(): string {
  return process.env.BASTRA_SKILLS_PATH ?? join(homedir(), ".bastra", "skills.json");
}

function isSkillEntry(v: unknown): v is SkillEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && SKILL_ID_RE.test(e.id) && typeof e.added_at === "string";
}

/** Missing/empty → []; corrupt → loud stderr + [], next write repairs it. */
async function readRegistry(path: string): Promise<SkillEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `[bastra-recall] skills.json is corrupt (${(e as Error).message}) — treating as empty. Fix or delete ${path}\n`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isSkillEntry);
}

async function writeRegistry(entries: SkillEntry[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(entries, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Adds (or updates, upsert by id) a declared skill.
 *
 * #533: this repeated the read-modify-write race #240/A9 fixed for floors.
 * Concurrent calls all read the same snapshot, all returned their entry as a
 * success, and the last rename left one arbitrary winner — measured, 40 unique
 * adds reported 40 successes and persisted 1. `MAX_SKILLS` was defeated the
 * same way, because every read saw the same stale registry.
 *
 * Serialised on the shared per-path lock (path-lock.ts), so the snapshot, the
 * cap check and the rename are one step: the cap is enforced against the
 * DURABLE state, and the returned entry is in the persisted union by the time
 * the promise resolves.
 *
 * CROSS-PROCESS, not just in-process: this file really does have a second
 * writer. `bastra skills add|remove` (cli/skills-cmd.ts) writes
 * ~/.bastra/skills.json from the CLI process, while the daemon writes it from
 * `POST /ui/skills` — the map's "mark as skill" button. A promise chain inside
 * one process cannot see the other, so both mutations take the lock file too.
 */
export async function addSkill(
  input: { id: string; label?: string; note?: string },
  path: string = skillsFilePath(),
): Promise<SkillEntry> {
  const id = input.id?.trim() ?? "";
  if (!SKILL_ID_RE.test(id)) {
    throw new Error(
      `invalid skill id ${JSON.stringify(input.id)} — must be a lowercase link slug ` +
        `([a-z0-9_-], max 80 chars), exactly what you write as [[id]]`,
    );
  }
  const label = input.label?.trim();
  const note = input.note?.trim();
  return withPathLock(
    path,
    async () => {
      const entries = await readRegistry(path);
      const existing = entries.findIndex((e) => e.id === id);
      if (existing === -1 && entries.length >= MAX_SKILLS) {
        throw new Error(`skills cap reached (${MAX_SKILLS}) — remove one first: bastra skills remove <id>`);
      }
      const entry: SkillEntry = {
        id,
        ...(label ? { label } : {}),
        ...(note ? { note } : {}),
        added_at: existing >= 0 ? entries[existing].added_at : new Date().toISOString(),
      };
      if (existing >= 0) entries[existing] = entry;
      else entries.push(entry);
      await writeRegistry(entries, path);
      return entry;
    },
    { crossProcess: true },
  );
}

/** Removes a declared skill; returns whether it existed. The node drops back
 *  to ordinary ghost behavior — nothing else changes, nothing is deleted. */
export async function removeSkill(id: string, path: string = skillsFilePath()): Promise<boolean> {
  const target = id?.trim() ?? "";
  if (!target) throw new Error("id is required");
  return withPathLock(
    path,
    async () => {
      const entries = await readRegistry(path);
      const next = entries.filter((e) => e.id !== target);
      if (next.length === entries.length) return false;
      await writeRegistry(next, path);
      return true;
    },
    { crossProcess: true },
  );
}

export async function listSkills(path: string = skillsFilePath()): Promise<SkillEntry[]> {
  return readRegistry(path);
}

/**
 * GET/POST /ui/skills — the map's declare-a-skill surface ("mark as skill" on
 * a ghost node). GET lists the registry; POST {id, label?, note?} declares.
 * ui-gated + loopback-only like the rest of /ui.
 */
export async function handleUiSkills(
  req: IncomingMessage,
  res: ServerResponse,
  settingsPath?: string,
  registryPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  if (req.method === "GET") {
    sendJsonPlain(res, 200, { skills: await listSkills(registryPath ?? skillsFilePath()) });
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      sendJsonPlain(res, 413, { error: "body too large" });
      return;
    }
  }
  let body: { id?: unknown; label?: unknown; note?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    sendJsonPlain(res, 400, { error: "invalid JSON body" });
    return;
  }
  try {
    const entry = await addSkill(
      {
        id: typeof body.id === "string" ? body.id : "",
        label: typeof body.label === "string" ? body.label : undefined,
        note: typeof body.note === "string" ? body.note : undefined,
      },
      registryPath ?? skillsFilePath(),
    );
    sendJsonPlain(res, 200, { skill: entry });
  } catch (err) {
    sendJsonPlain(res, 400, { error: (err as Error).message });
  }
}
