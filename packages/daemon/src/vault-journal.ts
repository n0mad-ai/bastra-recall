/**
 * Monthly journal (#288) — a human-readable markdown projection of the audit
 * log (#206), one file per month at `<vault>/journal/YYYY-MM.md`.
 *
 * Strictly derived from `.bastra/audit-log.ndjson`: a projection, never a
 * second source of truth — every file is regenerable from scratch without
 * loss, so a whole-file rewrite per month IS the regeneration strategy (the
 * render carries no run timestamp, identical data renders byte-identical and
 * is skipped). Plain markdown with [[wikilinks]], no viewer-specific syntax.
 *
 * The files carry no memory frontmatter, so the vault loader skips them
 * (NotAMemoryFile) — the journal is meta, not memory, and never enters the
 * recall index.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AuditLog, type AuditEntry } from "@bastra-recall/core";

export const JOURNAL_DIR = "journal";

const ANCHOR = "<!-- bastra-journal:start — generated from the audit log; edits here are overwritten on the next curator pass -->";

function fmtLine(e: AuditEntry): string {
  const time = e.timestamp.slice(11, 16);
  const actor = e.actor_detail ? `${e.actor} · ${e.actor_detail}` : e.actor;
  const reason = e.reason ? ` — ${e.reason}` : "";
  return `- ${time} **${e.operation}** [[${e.memory_id}]] (${actor})${reason}`;
}

/** Render one month. Entries must be ascending by timestamp (readAll order);
 *  deterministic for identical data — no generated-at stamp on purpose. */
export function renderMonthlyJournal(month: string, entries: AuditEntry[]): string {
  const L: string[] = [];
  L.push(ANCHOR);
  L.push(`# Journal ${month}`);
  L.push("");
  L.push(
    `${entries.length} write${entries.length === 1 ? "" : "s"} this month — projected from the audit log, which stays the source of truth.`,
  );
  let day = "";
  for (const e of entries) {
    const d = e.timestamp.slice(0, 10);
    if (d !== day) {
      day = d;
      L.push("");
      L.push(`## ${d}`);
      L.push("");
    }
    L.push(fmtLine(e));
  }
  L.push("");
  return L.join("\n");
}

/**
 * Project every month of the audit log into `<vault>/journal/`. Atomic
 * write per file; a pre-existing file without our anchor is never clobbered
 * (same guard as REPORT.md); an unchanged month is not rewritten. Never
 * throws. Returns the months that were (re)written.
 */
export async function writeVaultJournal(vaultRoot: string): Promise<string[]> {
  try {
    const all = await new AuditLog(vaultRoot).readAll();
    if (all.length === 0) return [];
    const byMonth = new Map<string, AuditEntry[]>();
    for (const e of all) {
      const month = typeof e.timestamp === "string" ? e.timestamp.slice(0, 7) : "";
      if (!/^\d{4}-\d{2}$/.test(month)) continue; // corrupt line — the log scan already tolerates those
      const bucket = byMonth.get(month);
      if (bucket) bucket.push(e);
      else byMonth.set(month, [e]);
    }
    const dir = join(vaultRoot, JOURNAL_DIR);
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const [month, entries] of byMonth) {
      const target = join(dir, `${month}.md`);
      const next = renderMonthlyJournal(month, entries);
      let existing: string | null = null;
      try {
        existing = await readFile(target, "utf8");
      } catch {
        /* no existing file — free to create */
      }
      if (existing !== null && !existing.includes("<!-- bastra-journal:start")) continue;
      if (existing === next) continue;
      // Zufallsanteil statt nur der PID (#532-Scan): derselbe Grund wie in
      // vault-report.ts — zwei überlappende Curator-Pässe im selben Prozess.
      const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      await writeFile(tmp, next, "utf8");
      await rename(tmp, target);
      written.push(month);
    }
    return written;
  } catch {
    return [];
  }
}
