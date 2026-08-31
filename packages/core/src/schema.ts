import { z } from "zod";
import { truncateSummaryTo, SUMMARY_MAX } from "./summary.js";
import { rescueFrontmatter, repairRequired } from "./frontmatter-rescue.js";

/** Fields `repairRequired` guarantees (#222). A validation error on one of
 *  these after the repair means something the loader cannot reason about, so
 *  it still throws rather than pretend. Everything else is optional and may be
 *  dropped to keep the node alive. */
const REQUIRED_FRONTMATTER_FIELDS = new Set([
  "id",
  "title",
  "type",
  "summary",
  "topic_path",
  "tags",
  "scope",
  "recall_when",
  "created",
  "updated",
]);

/**
 * YAML 1.1 parses bare `2026-05-01` as a JS Date.
 * Coerce back to the YYYY-MM-DD string we actually want.
 */
const dateString = z.preprocess((v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}, z.string());

export const MemoryTypeEnum = z.enum([
  "lesson",
  "preference",
  "project-fact",
  "meta-working",
  "decision",
  "workflow",
  "reference",
  "user-preference",
  "bookmark",
  "doc",
]);
export type MemoryType = z.infer<typeof MemoryTypeEnum>;

const MEMORY_TYPES: ReadonlySet<string> = new Set(MemoryTypeEnum.options);

/**
 * Thrown when a markdown file has no `type:` frontmatter that we recognize
 * as a memory marker. Callers silently ignore these — they're plain Obsidian
 * notes living next to memorys, not parse errors.
 */
export class NotAMemoryFile extends Error {
  constructor(public readonly filePath: string) {
    super(`not a memory file: ${filePath}`);
    this.name = "NotAMemoryFile";
  }
}

/**
 * Path-safety guard for values that end up as path components (`<id>.md`,
 * `memories/projects/<scope>/`, `.bastra/trash/<id>.md`). Deliberately loose:
 * it rejects only what can escape the vault (separators, `..`, NUL, leading
 * dot) — not unusual-but-harmless ids, so pre-existing vault files keep
 * loading instead of silently dropping out of the index.
 */
export function isPathSafeComponent(value: string): boolean {
  return (
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !value.includes("\0") &&
    !value.startsWith(".")
  );
}

const pathSafeMessage =
  "must not contain path separators, '..', or a leading dot";

/**
 * Tolerante aliases-Koerzierung (#188): Frontmatter ist in Obsidian hand-
 * editierbar, also kommen aliases auch als Bare-Scalar (`aliases: foo`),
 * Zahl (`aliases: [2024]`), YAML-Datum (`aliases: [2026-05-01]` → JS Date,
 * siehe dateString oben) oder dangling `aliases:` (null) an. Ein Memory darf
 * NIE über seine aliases aus dem Vault fallen — deshalb coercen statt
 * rejecten: null/leer → undefined, Scalar → [String], Date → YYYY-MM-DD.
 * Auch von save.ts genutzt, damit ein Overwrite bestehende Aliases erhält.
 */
export function coerceAliases(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr
    .filter((a) => a != null)
    .map((a) => (a instanceof Date ? a.toISOString().slice(0, 10) : String(a)));
  return out.length > 0 ? out : undefined;
}

export const FrontmatterSchema = z.object({
  id: z.string().min(1).refine(isPathSafeComponent, { message: pathSafeMessage }),
  title: z.string().min(1),
  type: MemoryTypeEnum,
  // Truncate instead of reject on load: a pre-existing vault file with a
  // >400-char summary (hand-edited in Obsidian, synced from a cloud drive, or
  // written by an older version) would otherwise fail parsing and be silently
  // skipped from the index — silent data loss. Clamp it in-memory instead.
  summary: z.string().min(1).transform((s) => truncateSummaryTo(s, SUMMARY_MAX)),
  topic_path: z.array(z.string()).min(1),
  tags: z.array(z.string()).min(1),
  scope: z.string().min(1),
  recall_when: z.array(z.string()).min(1),
  /**
   * doc2query write-time trigger expansion (#117): LLM-generated paraphrases of
   * title/summary/recall_when in *different* words than the author used, so a
   * reworded ("far") query weeks later still fires. Indexed at a lower BM25
   * weight than the hand-written `recall_when`. `recall_when_expanded_src` is a
   * short hash of the source fields — the expander regenerates only when it
   * changes, which also breaks the reindex→re-embed loop. Both written by the
   * TriggerExpander background service; absent on memories not yet expanded.
   */
  recall_when_expanded: z.array(z.string()).optional(),
  recall_when_expanded_src: z.string().optional(),
  related: z.array(z.string()).default([]),
  /**
   * Memory-Graph (#30 / #49): LLM-erkannte Beziehungen zu anderen Memories.
   * `id` ist die Ziel-Memory, `reason` ein kurzer Satz warum sie verbunden
   * sind, `score` ist die LLM-Confidence (0..1). Wird vom Auto-Related-
   * Detection-Background-Service in der Mac-App gefüllt, vom Multi-Hop-
   * Recall in `search.recall(expand_hops:)` gelesen.
   */
  related_via: z
    .array(
      z.object({
        id: z.string().min(1),
        reason: z.string().min(1),
        score: z.number().min(0).max(1),
      }),
    )
    .default([]),
  /**
   * Memory-Lifecycle (#74): Verfallsdatum + Staleness-Tracking. Bastra
   * markiert alte Decisions als „aging/stale/expired" damit der Recall sie
   * niedriger rankt und die UI zur Review auffordert. Defaults pro Type
   * werden in der Mac-App definiert (`MemoryLifecycle.defaultExpirationDays`).
   * - `valid_until`: explizites Ablaufdatum (überschreibt expires_after_days)
   * - `expires_after_days`: User-Override über die Type-Defaults
   * - `last_reviewed_at`: letzter „noch aktuell"-Klick (resetet die Staleness)
   * - `stale_status`: REINE PROJEKTION für die UI-Pill, kein Ranking-Input
   *   (#240/B9). `computeStaleness()` liest ausschließlich `updated`,
   *   `last_reviewed_at`, `valid_until`, `expires_after_days` und `type` —
   *   das persistierte Feld wird beim Ranking NIE gelesen. Ein von Hand auf
   *   „expired" gesetzter Wert ändert also nichts am Score. Absichtlich so:
   *   ein handgesetzter Wert würde die Live-Datumsrechnung dauerhaft
   *   überstimmen. Wer ein Memory herabstufen will, setzt `valid_until`.
   */
  valid_until: dateString.optional(),
  expires_after_days: z.number().int().positive().optional(),
  last_reviewed_at: dateString.optional(),
  stale_status: z.enum(["fresh", "aging", "stale", "expired"]).optional(),
  /**
   * Sensitivity-Level (#58): steuert, welche Surfaces das Memory sehen.
   * - `private`: nur Mac-App, NICHT für externe MCP-Clients.
   * - `team` (default): lokale KI-Tools (Claude Code, Cursor) dürfen es sehen.
   * - `public`: auch via Cross-Surface-Endpoints sichtbar.
   * Daemon filtert in recall/find_document/load_memory/list_memorys auf
   * `min_sensitivity` (default `team` für externe Caller, Mac-App ruft mit
   * `private` als Override).
   */
  sensitivity: z.enum(["private", "team", "public"]).default("team"),
  /**
   * Write-Provenance (#158): wer hat das Memory verfasst.
   * - `user-directed`: explizit vom Menschen diktiert („merk dir das") —
   *   für automatisierte Lifecycle-Pässe (Curator, Konsolidierung) tabu.
   * - `agent-session`: vom Agenten im Sessionfluss erfasst. Default-Semantik
   *   für alle Bestands-Memories ohne Feld.
   * - `capture-review`: aus einem Post-Session-Review-Pass (#157).
   */
  write_origin: z.enum(["user-directed", "agent-session", "capture-review"]).optional(),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  /**
   * Valenz (#217): emotionale Salience des Erfassungsmoments.
   * - `salience` 0..1: wie stark der Moment nachwirken soll. Hohe Salience
   *   verlangsamt das Altern (computeStaleness) und rankt höher (shadow-first,
   *   live nur env-gated).
   * - `emotion`: Ton des Moments; gespeist aus den Capture-Regeln (Frustration,
   *   hart erkämpfter Fix, Risiko); färbt den Glow-Core im Mindspace.
   * - `recall_mode`: `reflex` = darf ohne aktive Query injiziert werden, wenn
   *   ein recall_when-Trigger hart auf den Prompt matcht (budgetiert, nur nach
   *   expliziter User-Bestätigung setzen). Absent = `deliberate` — bewusst
   *   KEIN zod-Default, sonst schreibt jeder Re-Save das Feld in alle Files.
   */
  salience: z.number().min(0).max(1).optional(),
  emotion: z.enum(["frustration", "success", "risk", "neutral"]).optional(),
  recall_mode: z.enum(["reflex", "deliberate"]).optional(),
  created: dateString,
  updated: dateString,
  // Optional augmentation fields (see docs/memory-schema.md)
  affects_files: z.array(z.string()).default([]),
  status: z.string().optional(),
  issues: z.array(z.string()).default([]),
  /**
   * #235 — optional anchor command that can PROVE this memory's claim
   * (`test -f packages/daemon/src/reflex.ts`, `curl -s localhost:6723/health`).
   *
   * project-facts assert states of the world, and exactly those age silently
   * into false statements that keep getting recalled as true. Calendar
   * staleness and usage windows are both blind to content truth; an anchor is
   * not.
   *
   * Stage 1 is DISPLAY-ONLY. Nothing in the daemon, the curator or any hook
   * ever executes this string. It is shown to the agent, which decides under
   * the session's own permission rules — same as any other command a human
   * might read out of a note.
   */
  verify_cmd: z.string().min(1).optional(),
  obsolete: z.boolean().optional(),
  replaces: z.string().optional(),
  superseded_by: z.string().optional(),
  /**
   * #360 — ids this memory deliberately stands beside.
   *
   * The write-time claim gate diverts a save whose `recall_when` fully
   * contains an existing memory's trigger: two memories declaring the same
   * situation are a successor, a contradiction, or siblings, and only the
   * agent knows which. `siblings` is the record of the third answer — "both
   * apply, permanently, side by side" — so the pair is not asked about again
   * and the curator's `claimed twice` section skips it.
   *
   * Recorded on ONE side only, by the memory that was gated. The curator
   * checks both directions, so a second stamp would buy nothing and cost a
   * write into a file the save never touched.
   */
  siblings: z.array(z.string()).optional(),
  // Bookmark-only fields (only present when type === "bookmark")
  url: z.string().optional(),
  categories: z.array(z.string()).default([]),
  read_status: z.enum(["unread", "read", "archived"]).optional(),
  og_image: z.string().optional(),
  saved_at: z.string().optional(),
  source_app: z.string().optional(),
  // Document-only fields (only present when type === "doc"). Sidecar trägt
  // diese, damit find_document/read_document das Original-File wiederfinden,
  // auch wenn es außerhalb des Vaults liegt (linked_file === true).
  original_path: z.string().optional(),
  linked_file: z.boolean().optional(),
  document_category: z.string().optional(),
  folder_path: z.string().optional(),
  /**
   * Obsidian löst `[[wikilinks]]` gegen die `aliases`-Frontmatter-Liste auf
   * (Standard-Obsidian-Feature). Doc-Sidecars heißen nach dem Original-File
   * (`<file>.jpg.md`), nicht nach der id — sie tragen deshalb ihre eigene
   * doc-id als Alias, damit die `[[<doc-id>]]`-Cross-Links des
   * RelatedEnrichers in Obsidian aufs Sidecar auflösen statt beim Klick eine
   * leere Stray-Note anzulegen (#188). Preprocess: coerceAliases() — Obsidian
   * akzeptiert Bare-Scalars, YAML macht aus 2024/2026-05-01 Number/Date;
   * coercen statt rejecten, damit hand-editierte Sidecars weiter laden.
   */
  aliases: z.preprocess(coerceAliases, z.array(z.string()).optional()),
  /** #147: Injection-Marker-Kategorien aus dem Capture-Scan (save_document).
   *  Gleiche Toleranz wie aliases: ein Memory darf über dieses operationale
   *  Feld nie aus dem Vault fallen. */
  injection_flags: z.preprocess(coerceAliases, z.array(z.string()).optional()),
  // Auto-Inbox: Files vom Inbox-Watcher werden ohne User-Sheet eingelesen
  // und als "ungeprüft" markiert. Mac-App rendert Pill + Tint, bietet
  // Bulk-Review-Sheet bei ≥2 needs_review im aktuellen Folder.
  needs_review: z.boolean().optional(),
  // Auto-Inbox: KI-Vorschlag für den Zielordner. Wird beim Auto-Commit
  // gespeichert, während das File physisch in Inbox/ landet. Review-Sheet
  // zeigt's und verwendet es als Default beim Folder-Picker.
  ai_suggested_folder: z.string().optional(),
  // #70 Duplicate-Detection: SHA-256-Hash + Größe der Original-Datei. Wird
  // beim ersten Import gesetzt; spätere Imports prüfen Size-Match (schnell)
  // und Hash-Match (definitiv) und skippen Duplikate. Optional, damit alte
  // Sidecars ohne Hash kompatibel bleiben.
  content_hash: z.string().optional(),
  content_size: z.number().int().nonnegative().optional(),
  // Geo-Koordinaten + Reverse-Geocoding-Resultat. Mac-App schreibt EXIF-GPS
  // (Bilder) oder NSDataDetector-Adresse (Verträge/Rechnungen) hier rein,
  // Map-View rendert die Pins. Optional — Default für Docs ohne Location.
  location: z
    .object({
      lat: z.number(),
      lon: z.number(),
      place: z.string().optional(),
      source: z.enum(["exif", "ocr", "manual"]).optional(),
    })
    .optional(),
});
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

/** One field the loader had to repair to keep the node alive (#222). */
export interface DamagedField {
  field: string;
  reason: string;
}

export interface Memory {
  fm: Frontmatter;
  body: string;
  filePath: string;
  mtime: number;
  /** #222: present ONLY when the loader degraded something. A healthy memory
   *  carries no marker at all, so `damaged` is a truthful signal and not a
   *  field every consumer has to ignore. Never written back to disk — the file
   *  stays exactly as the user wrote it; this is an in-memory annotation that
   *  the vault report and vault care surface so the damage is visible instead
   *  of living in a `console.warn` nobody sees. */
  damaged?: DamagedField[];
}

/**
 * Parse a markdown file with YAML frontmatter into a Memory.
 * Throws if the frontmatter is missing or invalid.
 */
export function parseMemory(
  raw: string,
  filePath: string,
  mtime: number,
): Memory {
  // gray-matter is dynamically imported by the caller to keep this module pure-ish
  throw new Error("Use parseMemoryWith(matter, raw, filePath, mtime) instead");
}

/**
 * The actual parse entry point — takes the gray-matter function as injection
 * so this module stays trivially testable without IO.
 */
export function parseMemoryWith(
  matter: (input: string) => { data: unknown; content: string },
  raw: string,
  filePath: string,
  mtime: number,
): Memory {
  // #222: when the block as a whole is not valid YAML, rescue it entry by
  // entry instead of losing the node. A healthy file takes the same path it
  // always did and comes back with an empty `damaged` list.
  const rescued = rescueFrontmatter(matter, raw);
  if (!rescued) throw new NotAMemoryFile(filePath);
  const { data, content, damaged } = rescued;
  // Pre-check: if there's no recognizable memory `type:` field, throw a
  // NotAMemoryFile so the caller can silently skip it. Lets the vault scan
  // recursively through an Obsidian vault and only pick up memorys. This stays
  // strict on purpose — `type` is what says "this file is a memory at all",
  // and a guessed one would drag plain notes into the index.
  if (!("type" in data) || !MEMORY_TYPES.has(String(data.type))) {
    throw new NotAMemoryFile(filePath);
  }
  repairRequired(data, filePath, mtime, content, damaged, isPathSafeComponent);
  const parsed = FrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    // Everything required is present and structurally sound by now, so a
    // failure here is an OPTIONAL field the repair does not cover (a malformed
    // `related_via` entry, an out-of-range `salience`). Drop those fields and
    // keep the node — the same trade the rest of this path makes.
    const dropped = new Set<string>();
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      if (!field || REQUIRED_FRONTMATTER_FIELDS.has(field)) {
        const where = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`invalid frontmatter in ${filePath}: ${where}`);
      }
      dropped.add(field);
    }
    for (const field of dropped) {
      delete data[field];
      damaged.push({ field, reason: "optional field did not validate — dropped so the memory still loads" });
    }
    const retry = FrontmatterSchema.safeParse(data);
    if (!retry.success) {
      const where = retry.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`invalid frontmatter in ${filePath}: ${where}`);
    }
    return { fm: retry.data, body: content, filePath, mtime, damaged };
  }
  // A healthy memory carries NO marker — `damaged` stays absent so consumers
  // can treat its presence as the signal it is.
  return damaged.length > 0
    ? { fm: parsed.data, body: content, filePath, mtime, damaged }
    : { fm: parsed.data, body: content, filePath, mtime };
}
