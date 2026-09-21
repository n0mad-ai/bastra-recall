import { sep } from "node:path";
import matter from "gray-matter";
import type { SaveMemoryInput } from "@bastra-recall/core";
import { namespaceWikilinks, safeSlug } from "./identity.js";
import { looksLikeIndexHub, type IndexEntry } from "./index-harvest.js";

/** Claude Code memory `type` → recall memory type. Closed 4-value source enum
 *  (user|feedback|project|reference); unknown values fall back to reference. */
const CC_TYPE_MAP: Record<string, SaveMemoryInput["type"]> = {
  user: "user-preference",
  feedback: "meta-working",
  project: "project-fact",
  reference: "reference",
};

/** Adapter prefixes a node's `source` stamp (`<adapter>:<label>:<relKey>`) can
 *  legitimately carry — the only two `buildInput` below ever writes. Read
 *  back by the importer's ownership check and by orphan detection to tell "a
 *  prior node of THIS importer" from anything else on a colliding id. */
export const KNOWN_ADAPTERS = new Set(["claude-code-memory", "markdown"]);

// ── small pure helpers ───────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** `feedback_no_double_borders.md` → "feedback"; only the four CC prefixes. */
function typeFromFilename(fileBase: string): string | null {
  const m = /^(user|feedback|project|reference)[_-]/.exec(fileBase);
  return m ? m[1] : null;
}

/** filename/slug → a readable title ("no_double_borders" → "No double borders"). */
function deSlug(fileBase: string): string {
  const words = fileBase.replace(/[-_]+/g, " ").trim();
  if (!words) return fileBase;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** First `# H1` heading text, if the note leads with one. */
function firstH1(body: string): string | null {
  for (const line of body.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
    if (line.trim().length > 0 && !line.startsWith("#")) break;
  }
  return null;
}

/** First non-heading, non-empty paragraph, clamped — a stand-in summary when
 *  the source carries no description field. */
function firstParagraph(body: string): string | null {
  const blocks = body.split(/\n\s*\n/);
  for (const block of blocks) {
    const text = block.trim();
    if (!text || text.startsWith("#") || text.startsWith("---")) continue;
    const oneLine = text.replace(/\s+/g, " ");
    return oneLine.length > 300 ? oneLine.slice(0, 297) + "…" : oneLine;
  }
  return null;
}

/** gray-matter, but a throwing/unparseable YAML frontmatter (cyrillic
 *  guillemets, backslash escapes, …) degrades to "no frontmatter" instead of
 *  dropping the file — YAML-leniency lives in the importer, not the loader. */
export function safeParse(raw: string): { data: Record<string, unknown>; content: string } {
  try {
    const { data, content } = matter(raw);
    return { data: (data ?? {}) as Record<string, unknown>, content };
  } catch {
    return { data: {}, content: raw };
  }
}

/** A CC memory file if it carries any of the format's marker fields — flat
 *  `type:`, nested `metadata.type:`, or a `name:`. Everything else is generic. */
export function looksLikeClaudeCode(data: Record<string, unknown>): boolean {
  if (str(data.name) || str(data.type)) return true;
  const meta = data.metadata;
  return typeof meta === "object" && meta !== null && str((meta as Record<string, unknown>).type) !== null;
}

// ── per-file mapping ─────────────────────────────────────────────────────────

type MapResult = { ok: true; input: SaveMemoryInput } | { ok: false; reason: string };

interface MapContext {
  label: string;
  folder: string;
  relDir: string;
  overwrite: boolean;
  used: Set<string>;
  /** Namespaced ids that SOME body links to — a file in this set is a real
   *  target, never a throwaway index (nav-skip inbound-veto, Finding #2). */
  referenced: Set<string>;
  /** fileBase → its section + description, harvested from the index/hubs. */
  harvest: Map<string, IndexEntry>;
  /** #240/A10: basename → final id, for resolving LINKS only. Source
   *  wikilinks reference a bare basename (`[[same]]`), which is inherently
   *  ambiguous when the basename repeats — first sorted path wins. */
  idByBase: Map<string, string>;
  /** This file's own final id, minted from its full source path in Pass 0.
   *  Must NOT come from idByBase: two files sharing a basename would collapse
   *  onto one id and the second would overwrite the first. */
  selfId: string;
  /** Canonical POSIX source path relative to the import root — the node's
   *  provenance stamp (#240, Codex gegencheck 5cf71bb). Written into `source`
   *  so a later reimport can tell "my own prior node" (overwrite is fine) from
   *  "a stranger that collides on this id" (must never be overwritten). */
  relKey: string;
}

function buildInput(
  fields: { name: string; description: string; type: SaveMemoryInput["type"]; ccType: string; adapter: string },
  fileBase: string,
  body: string,
  ctx: MapContext,
): SaveMemoryInput {
  const { name, description, type, ccType, adapter } = fields;
  const relSegments = ctx.relDir ? ctx.relDir.split(sep).filter(Boolean).map((s) => s.trim()).filter(Boolean) : [];
  // #240/A10: the id must come from the SOURCE IDENTITY, not from the file's
  // position in the current batch. `uniqueId(label-fileBase)` only
  // disambiguated within one sorted run, so two `same.md` in different source
  // folders became `demo-same` / `demo-same-2` — and once the first source
  // file was deleted, the re-import gave `demo-same` to the OTHER file. Every
  // reference to that id then pointed at different content, and the stale
  // `demo-same-2` stayed behind as a duplicate. The relative directory is
  // stable ground truth (it already shapes the physical path below), so it
  // belongs in the id. `uniqueId` stays as the last-resort tiebreaker for a
  // genuine collision within one run.
  // #240/A10: minted in Pass 0 from the full source path — keeps minting and
  // link resolution in lockstep without collapsing duplicate basenames.
  const id = ctx.selfId;
  // Curated section from the index — carried in topic_path + tags, NOT in the
  // physical folder (Finding #3): a section lives in the source index, which
  // can change between re-imports; if it drove the file PATH, a re-import
  // after a section move would orphan the old copy (saveMemory only checks the
  // new folder-derived path), leaving two files with one id. Only a real
  // SOURCE subfolder (relSegments) shapes the path — that's stable ground truth.
  const rawSection = ctx.harvest.get(fileBase)?.section ?? null;
  const section = relSegments.length === 0 && rawSection ? safeSlug(rawSection) : null;
  const sectionSeg = section ? [section] : [];
  const topic_path = ["imported", ctx.label, ...sectionSeg, ...relSegments];
  const tags = [...new Set(["imported", ctx.label, ccType, ...sectionSeg].filter(Boolean))];
  const recall_when = [...new Set([description, deSlug(name), ccType].map((s) => s.trim()).filter(Boolean))];
  const safeBody = namespaceWikilinks(body.trim().length > 0 ? body : description || name, ctx.label, ctx.idByBase);
  return {
    id,
    title: name,
    type,
    summary: description,
    body: safeBody,
    topic_path,
    tags,
    scope: ctx.label,
    recall_when,
    folder: ctx.folder,
    write_origin: "user-directed",
    overwrite: ctx.overwrite,
    // "<adapter>:<label>:<relKey>" — the relKey is the per-file provenance the
    // ownership check reads back on reimport (#240, Codex gegencheck 5cf71bb).
    source: `${adapter}:${ctx.label}:${ctx.relKey}`,
  };
}

export function mapFile(fileBase: string, raw: string, ctx: MapContext): MapResult {
  const { data, content } = safeParse(raw);
  const idxDesc = ctx.harvest.get(fileBase)?.description ?? null;

  if (looksLikeClaudeCode(data)) {
    const meta = (typeof data.metadata === "object" && data.metadata !== null
      ? (data.metadata as Record<string, unknown>)
      : {});
    const ccType = str(data.type) ?? str(meta.type) ?? typeFromFilename(fileBase) ?? "reference";
    const type = CC_TYPE_MAP[ccType] ?? "reference";
    const name = str(data.name) ?? firstH1(content) ?? deSlug(fileBase);
    const description = str(data.description) ?? idxDesc ?? firstParagraph(content) ?? name;
    return { ok: true, input: buildInput({ name, description, type, ccType, adapter: "claude-code-memory" }, fileBase, content, ctx) };
  }

  // generic markdown — no recognizable memory frontmatter
  const name = firstH1(content) ?? deSlug(fileBase);
  const description = idxDesc ?? firstParagraph(content) ?? name;
  if (content.trim().length === 0 && !str(data.name)) {
    return { ok: false, reason: "empty file" };
  }
  // Index/hub veto (Finding #2, zzallirog): a file OTHERS link to is a real
  // target, not a throwaway index — importing it is the only way its 18
  // inbound links resolve instead of collapsing into one degree-18 ghost.
  if (looksLikeIndexHub(content)) {
    const selfId = ctx.selfId;
    if (selfId === null || !ctx.referenced.has(selfId)) {
      return { ok: false, reason: "index/navigation file (link hub) — not a memory" };
    }
  }
  const ccType = typeFromFilename(fileBase) ?? "reference";
  const type = CC_TYPE_MAP[ccType] ?? "reference";
  return { ok: true, input: buildInput({ name, description, type, ccType, adapter: "markdown" }, fileBase, content, ctx) };
}
