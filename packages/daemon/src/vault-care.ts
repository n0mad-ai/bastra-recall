/**
 * Vault care file format — `vault-care.md` at the vault root (#207).
 *
 * The map never edits memories. Instead the user flags them ("delete",
 * "edit", "write this unwritten note", free note); each flag is appended to
 * `vault-care.md` — plain markdown with checkbox lines and wikilinks, readable
 * by Obsidian, any AI session, and any viewer (#140). An AI session works the
 * list off together with the user and ticks entries `[x]`; the map only shows
 * unticked ones. The routes live in webui.ts; this module owns the format:
 * reading, formatting, and replacing the note of one entry in place.
 */
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export const CARE_FILE = "vault-care.md";
export const CARE_KINDS = ["delete", "edit", "write", "note"] as const;
export type CareKind = (typeof CARE_KINDS)[number];

export const CARE_HEADER = `# Vault Care

Flags from the vault map. In an AI session, say "let's work off the vault
care list" — go through the open entries together, apply them via the memory
tools, and tick them \`[x]\` here when done.

`;
const CARE_LINE_RE = /^- \[([ x])\] (\d{4}-\d{2}-\d{2}) · (\w+) · \[\[([^\]]+)\]\](?: — (.*))?$/;

export interface CareEntry {
  done: boolean;
  date: string;
  kind: string;
  id: string;
  note: string;
}

/** Multi-line notes: the entry line carries the first line, every further line
 *  follows indented by two spaces (a markdown list-item continuation, so
 *  Obsidian and agents read it as one entry). Blank note lines stay empty. */
const CARE_CONT = "  ";

export function formatCareEntry(e: Omit<CareEntry, "done"> & { done?: boolean }): string {
  const [first, ...rest] = e.note.split("\n");
  const head = `- [${e.done ? "x" : " "}] ${e.date} · ${e.kind} · [[${e.id}]]${first ? ` — ${first}` : ""}`;
  return [head, ...rest.map((l) => (l ? CARE_CONT + l : ""))].join("\n") + "\n";
}

/** One parsed entry plus the line span it occupies: `start` is the entry
 *  line, `end` the last continuation line (inclusive). Blank lines after the
 *  last continuation are not part of the entry. */
interface CareSpan extends CareEntry {
  start: number;
  end: number;
}

function scanCareLines(lines: string[]): CareSpan[] {
  const out: CareSpan[] = [];
  let blanks = 0;
  let open = false; // the last entry may still take continuation lines
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const m = CARE_LINE_RE.exec(line.trimEnd());
    if (m) {
      out.push({ done: m[1] === "x", date: m[2], kind: m[3], id: m[4], note: m[5] ?? "", start: i, end: i });
      blanks = 0;
      open = true;
    } else if (line.trim() === "") {
      blanks++;
    } else if (open && line.startsWith(CARE_CONT)) {
      const last = out[out.length - 1];
      last.note += "\n".repeat(blanks + 1) + line.slice(CARE_CONT.length);
      last.end = i;
      blanks = 0;
    } else {
      open = false;
    }
  });
  return out;
}

export function parseCareFile(content: string): CareEntry[] {
  return scanCareLines(content.split("\n")).map(({ start: _s, end: _e, ...entry }) => entry);
}

/** The entry the user edits, as the UI last read it. */
export type CareTarget = Pick<CareEntry, "id" | "kind" | "date" | "note">;

/**
 * Replace the note of exactly one entry. The entry is found by its full
 * content (memory id, kind, date and note as last read) — the file has no
 * entry ids, and matching the content means an entry that was edited or
 * removed meanwhile (Obsidian, an AI session) is not found: `null`, nothing
 * changes. Of several identical entries the first is taken; they are
 * indistinguishable. Kind, date and the done tick stay; every line outside
 * the entry's span stays byte-identical.
 */
export function replaceCareNote(content: string, target: CareTarget, note: string): string | null {
  const lines = content.split("\n");
  const hit = scanCareLines(lines).find(
    (e) => e.id === target.id && e.kind === target.kind && e.date === target.date && e.note === target.note
  );
  if (!hit) return null;
  const cr = lines[hit.start].endsWith("\r") ? "\r" : "";
  const fresh = formatCareEntry({ ...hit, note })
    .slice(0, -1)
    .split("\n")
    .map((l) => l + cr);
  lines.splice(hit.start, hit.end - hit.start + 1, ...fresh);
  return lines.join("\n");
}

export class CareConflictError extends Error {}

/**
 * Rewrite `vault-care.md` with one note replaced: temp file next to it, then
 * rename (atomic on the same volume), keeping the file mode. The file is read
 * again right before the rename; when it changed in between (a flag was
 * appended, Obsidian saved), the temp file is dropped and CareConflictError
 * thrown — never a blind overwrite.
 */
export async function rewriteCareNote(file: string, target: CareTarget, note: string): Promise<CareEntry> {
  const before = await readFile(file, "utf8");
  const next = replaceCareNote(before, target, note);
  if (next === null) throw new CareConflictError("entry changed or removed");
  const tmp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, next, { encoding: "utf8", mode: (await stat(file)).mode & 0o777, flag: "wx" });
  try {
    if ((await readFile(file, "utf8")) !== before) throw new CareConflictError("file changed meanwhile");
    await rename(tmp, file);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  const entry = parseCareFile(next).find(
    (e) => e.id === target.id && e.kind === target.kind && e.date === target.date && e.note === note
  );
  return entry ?? { done: false, ...target, note };
}
