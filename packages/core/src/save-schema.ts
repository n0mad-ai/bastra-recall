/**
 * Split out of `save.ts` (#360 follow-up): the write path had grown past 800
 * lines, which is a context cost on every edit that touches it. Pure move —
 * no behaviour change, no renamed export.
 *
 * The input contract and the result/error types. Validation lives apart from
 * the write path it guards: this module is what a caller reads to learn what
 * `save_memory` accepts, and it must stay readable without the I/O around it.
 */
import { z } from "zod";
import type { MemoryLocator } from "./memory-locator.js";
import { MemoryTypeEnum, isPathSafeComponent } from "./schema.js";
import { isPathSafeFolder } from "./save-text.js";

/**
 * Input contract for save_memory.
 * Mirrors FrontmatterSchema but only the fields a caller should set —
 * id, created and updated are auto-derived; `obsolete` and `superseded_by`
 * are written by separate flows, not by save.
 *
 * `replaces` is the exception (#164): it is how a caller declares "this
 * memory is the new version of that one". The counterpart stamp
 * (`superseded_by` on the predecessor) is applied by the daemon, which is the
 * layer that knows where the predecessor lives.
 */
export const SaveMemoryInput = z.object({
  title: z.string().min(1),
  type: MemoryTypeEnum,
  // No `.max` here on purpose: an over-long summary is clamped in
  // saveMemory() (with a non-fatal note in the result), never rejected —
  // a too_big error would force the caller into a wasteful retry roundtrip.
  summary: z.string().min(1),
  body: z.string().min(1),
  topic_path: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)).min(1),
  // scope becomes a directory segment (`memories/projects/<scope>/`) — reject
  // anything that could climb out of the vault.
  scope: z.string().min(1).refine(isPathSafeComponent, {
    message: "scope must not contain path separators, '..', or a leading dot",
  }),
  recall_when: z.array(z.string().min(1)).min(1),
  /**
   * #164 — id of the memory this one supersedes.
   *
   * Deliberately NOT the same thing as `archive_memory`: the predecessor stays
   * in the living vault and stays resolvable by its id. It is not moved to the
   * trash, not dropped from the index, and not marked `obsolete`. Per the V1→V2
   * architecture contract (C-059) historicity comes from the version status,
   * never from a change of location — a predecessor that is moved away is not
   * historical, it is gone, and old versions have to stay citable.
   */
  replaces: z.string().min(1).optional(),
  /**
   * #205 — conflict marking. Id of an existing memory the incoming save
   * CONTRADICTS. The save is then diverted: the incoming memory is NOT
   * created (no silent sibling), the existing one is NOT overwritten (no
   * silent discard) — instead a plain-markdown conflict block carrying both
   * claims, sources and dates is appended to the existing memory's body.
   * Resolution is a later deliberate `overwrite=true` save of that memory.
   */
  conflict_with: z.string().min(1).optional(),
  /**
   * #360 — ids this save deliberately stands BESIDE.
   *
   * The third answer to the write-time claim gate. When a save's `recall_when`
   * fully contains an existing memory's trigger, the two declare the same
   * situation, and that is one of three things: a successor (`replaces`), a
   * contradiction (`conflict_with`), or siblings — several entities that are
   * permanently valid at once ("the memo for contributor A" and "the memo for
   * contributor B" share every trigger word but the name). Only the third case
   * has no field, so a legitimate save had no way past the gate except to
   * mis-declare itself as one of the other two.
   *
   * Lands in the `siblings` frontmatter list, MERGED with what the file already
   * carries: quittances accumulate, a later save never drops an earlier one.
   */
  sibling_of: z.array(z.string().min(1)).optional(),
  /** #235: optional anchor command that can prove this memory's claim.
   *  Stored and displayed only — nothing here ever runs it. */
  verify_cmd: z.string().min(1).optional(),
  related: z.array(z.string()).optional(),
  /**
   * Obsidian-Aliases (#188): Substrat-Plumbing, kein Agent-Knob — der Daemon
   * exponiert das Feld NICHT im MCP-Tool-Schema. Wird vom RelatedEnricher /
   * Documents-Flow gesetzt. Beim Overwrite ohne explizite aliases bleiben
   * die bestehenden File-Aliases erhalten (siehe saveMemory).
   */
  aliases: z.array(z.string()).optional(),
  /**
   * Memory-Graph (#30 / #49): LLM-detektierte Beziehungen. Optional —
   * normalerweise nicht beim manuellen save_memory gesetzt, sondern vom
   * Auto-Related-Detection-Background-Service via reindex_file persistiert.
   */
  related_via: z
    .array(
      z.object({
        id: z.string().min(1),
        reason: z.string().min(1),
        score: z.number().min(0).max(1),
      }),
    )
    .optional(),
  /**
   * Sensitivity-Level (#58). Optional, default „team" wenn nicht gesetzt.
   * Mac-App-UI macht den Per-Memory-Picker; Auto-Captures (Inbox-Watcher,
   * Share-Sheet) erben den Default.
   */
  sensitivity: z.enum(["private", "team", "public"]).optional(),
  /**
   * Write-Provenance (#158): `user-directed` wenn der Mensch das Speichern
   * explizit angeordnet hat („merk dir das") — solche Memories sind für
   * automatisierte Lifecycle-Pässe (Curator, Konsolidierung) unantastbar.
   * Weglassen = `agent-session` (autonomer Save im Sessionfluss).
   * `capture-review` stempelt der Post-Session-Capture-Pass (#157).
   */
  write_origin: z.enum(["user-directed", "agent-session", "capture-review"]).optional(),
  /**
   * Memory-Lifecycle (#74): optionale Ablauf-/Review-Felder. `stale_status`
   * wird vom Vault-Loader computet, ist hier aber akzeptiert damit die
   * Mac-App es explizit setzen kann (z.B. manuelles „obsolete").
   */
  valid_until: z.string().optional(),
  expires_after_days: z.number().int().positive().optional(),
  last_reviewed_at: z.string().optional(),
  stale_status: z.enum(["fresh", "aging", "stale", "expired"]).optional(),
  /**
   * Duplicate-Detection (#70): SHA-256-Hash + Größe der Original-Datei.
   * Nur bei `type: doc` Memories sinnvoll. Mac-App-DocumentsImporter
   * berechnet beide beim ersten Import.
   */
  content_hash: z.string().optional(),
  content_size: z.number().int().nonnegative().optional(),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  /**
   * Valenz + Reflex (#217). `salience`/`emotion` nur setzen, wenn eine
   * Capture-Regel feuert; `recall_mode: "reflex"` nur nach expliziter
   * User-Bestätigung. Bei Overwrite ohne Angabe bleiben Bestandswerte
   * erhalten (gleiche Regel wie write_origin).
   */
  salience: z.number().min(0).max(1).optional(),
  emotion: z.enum(["frustration", "success", "risk", "neutral"]).optional(),
  recall_mode: z.enum(["reflex", "deliberate"]).optional(),
  affects_files: z.array(z.string()).optional(),
  issues: z.array(z.string()).optional(),
  // id becomes the filename (`<id>.md`) — same path-safety bar as scope.
  // slugify() output always passes; only explicit caller-set ids can violate.
  id: z.string().min(1).refine(isPathSafeComponent, {
    message: "id must not contain path separators, '..', or a leading dot",
  }).optional(),
  /**
   * Selbstlernende Taxonomie (#64/#65): optionaler Ziel-Ordner relativ zum
   * Vault-Root (z.B. "memories/people"). Überschreibt das scope/type-Routing
   * von subfolderFor() — damit kann eine Taxonomie-Konvention neue physische
   * Strukturen im Vault etablieren, ohne dass core sie kennen muss. Der Vault
   * scannt rekursiv, jeder Ordner wird indexiert.
   */
  folder: z.string().min(1).refine(isPathSafeFolder, {
    message:
      "folder must be a relative path without '..', '\\', or dot-segments (e.g. \"memories/people\")",
  }).optional(),
  overwrite: z.boolean().optional(),
  // Bookmark-only fields
  url: z.string().optional(),
  categories: z.array(z.string()).optional(),
  read_status: z.enum(["unread", "read", "archived"]).optional(),
  og_image: z.string().optional(),
  saved_at: z.string().optional(),
  source_app: z.string().optional(),
});
export type SaveMemoryInput = z.infer<typeof SaveMemoryInput>;

export interface SaveMemoryResult {
  id: string;
  file_path: string;
  /** `false` für ein Re-Filing: Ein Umzug erschafft kein Memory. */
  created: boolean;
  /**
   * Das Frontmatter, das dieser Save als VORLAGE benutzt hat — unter dem
   * ID-Claim gelesen, aus derselben Datei, die er gleich anfasst (beim
   * Re-Filing also aus der QUELLE, nicht aus dem Zielpfad). `null`, wenn es
   * keine Vorlage gab (echter Create).
   *
   * Codex-Gegenreview (P1): Jeder Audit-Aufrufer bildete sein `diff_before`
   * vorher selbst — aus dem Vault-Cache, aus dem Zielpfad oder aus einem
   * zweiten Vaultscan. Alle drei können etwas anderes beschreiben als das,
   * was die Mutation tatsächlich gepatcht hat, und genau das taten sie:
   * `diff_before` meldete Version 1, während der Save Version 0.4 als Vorlage
   * hatte. Das Audit-Vorbild gehört deshalb an die Mutation, nicht an ihre
   * Aufrufer.
   */
  audit_before: Record<string, unknown> | null;
  /** Das geschriebene Frontmatter — dieselbe Bindung an die Mutation wie
   *  {@link audit_before}, deshalb ohne zweiten Read des Zielpfads. */
  audit_after: Record<string, unknown>;
  /** Beim Re-Filing der Pfad, von dem das Memory kam — die Datei liegt danach
   *  im Trash. Aufrufer mit einem Index werfen den alten Pfad damit hinaus,
   *  ohne auf den (auf Cloud-Mounts unzuverlässigen) Watcher zu warten. */
  refiled_from?: string;
  /** Present only when the summary was auto-truncated to fit SUMMARY_MAX. */
  summary_note?: string;
}

/**
 * Optional compare-and-swap precondition for callers that inspect ownership
 * before saving. `null` means "the target was absent"; a string is the exact
 * target content the caller approved. Omitting the option keeps the ordinary
 * save API unchanged.
 */
export interface SaveMemoryCommitOptions {
  expectedTarget?: string | null;
  /**
   * ROUTING-Auskunft: In welchem Regal und in welcher Schreibweise liegt ein
   * Bestands-Memory dieser id? Der Daemon reicht eine Fassung durch, die den
   * geladenen Vault-Index befragt; ohne sie fällt `saveMemory` auf einen
   * vaultweiten Dateiscan zurück.
   *
   * Ausdrücklich NICHT die Kollisionsprüfung: „Gehört diese id schon jemandem"
   * beantwortet seit dem Umbau auf die ID-Transaktion der autoritative
   * Plattenscan unter dem Lock. Ein Index kann prozessübergreifend veraltet
   * sein, und eine veraltete Antwort unter einem Lock bleibt eine veraltete
   * Antwort.
   */
  locator?: MemoryLocator;
  /**
   * KEIN `authority`-Feld mehr. Codex-Gegenreview (P0): Solange die öffentliche
   * Core-API erlaubte, die Auskunft „wo lebt diese id" selbst mitzubringen, war
   * der autoritative Plattenscan optional — und damit die Invariante „eine ID,
   * eine Datei" nur eine Konvention der internen Aufrufstellen. Nachgestellt:
   * zwei sequenzielle Saves derselben id in verschiedene Regale, der zweite mit
   * einer veralteten Authority `{ kind: "none" }` — beide Dateien wurden
   * angelegt, also exakt der ursprüngliche Doppel-ID-Defekt, erreichbar über
   * `saveMemory()`. Produktive Aufrufer gab es nach dem Entfall der
   * Import-Ausnahme keine mehr; wer die Auskunft fälschen will, muss die
   * Transaktion direkt aufrufen, nicht den Save.
   */
}

export const MEMORY_WRITE_CONFLICT = "BASTRA_WRITE_CONFLICT";

/** A concurrent writer changed or claimed the target before this save committed. */
export class MemoryWriteConflictError extends Error {
  readonly code = MEMORY_WRITE_CONFLICT;
  readonly id: string;
  readonly file_path: string;

  constructor(id: string, filePath: string, detail: string) {
    super(`memory write conflict for ${id}: ${detail}. Retry from the current file.`);
    this.name = "MemoryWriteConflictError";
    this.id = id;
    this.file_path = filePath;
  }
}
