import { stripCodeSpans } from "@bastra-recall/core";
import { WIKILINK_RE } from "./identity.js";

/**
 * Index-hub detection for frontmatter-less files (zzallirog field report,
 * 2026-07-17): hand-maintained index files (sectioned link lists pointing at
 * every note) must NOT become memory nodes — their stray inline wikilinks
 * inflate the ghost count while their real navigational payload (markdown
 * `[t](x.md)` links) isn't a semantic edge either way. Recognize, don't
 * parse: a file whose non-heading lines are mostly links is navigation.
 * Only ever applied to frontmatter-less files — declared frontmatter wins.
 */
/** A line that carries its content in list form — the shape an index is made of. */
const LIST_LINE_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\|)/;
/** Prose left on a line once its links and typographic separators are gone. */
function proseRest(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)\s]+\.md(?:#[^)]*)?\)/g, "$1")
    .replace(WIKILINK_RE, " ")
    .replace(/[·•|–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/** Chars of leftover prose that make a non-list line a real body paragraph. */
const PARAGRAPH_MIN_CHARS = 60;
/**
 * Paragraphs per link above which a file is content, not navigation.
 *
 * Counting paragraphs absolutely was wrong (zzallirog re-ran #221 against his
 * vault): a real index may open with a long preamble — his carry 4, 5 and 15
 * prose lines — and a tolerance of 1 read every one of them as a note. What
 * separates them is not how much intro an index has but how much of it is
 * scaffolding: an index stays mostly list even with a long introduction.
 *
 * Calibrated on the only real numbers available — his three genuine indexes at
 * 3.1%, 8.5% and 2.9%, against the reported false positive at 70% and a
 * list-heavy note at 25%. The gap between 8.5% and 25% is where this sits.
 */
const PARAGRAPHS_PER_LINK_MAX = 0.15;

export function looksLikeIndexHub(body: string): boolean {
  // Code-Spans blanken, bevor gezählt wird: ein Body, der ÜBER Link-Syntax
  // redet (`[[x]]`/`[t](y.md)` im Code-Beispiel), ist kein Index (Parser-Noise
  // wie bei extractWikilinks — zzallirog 2026-07-18).
  const scanned = stripCodeSpans(body);
  const mdLinks = scanned.match(/\[[^\]]*\]\([^)\s]+\.md\)/g)?.length ?? 0;
  const wikiLinks = scanned.match(WIKILINK_RE)?.length ?? 0;
  const links = mdLinks + wikiLinks;
  if (links < 8) return false;
  const contentLines = scanned
    .split("\n")
    .filter((l) => l.trim().length > 0 && !/^\s*#/.test(l) && !/^\s*---\s*$/.test(l));
  if (contentLines.length === 0 || links < contentLines.length * 0.6) return false;
  // Link density alone was too eager (#221, zzallirog's field test on 0.8.4:
  // 8 files skipped, 3 of them ordinary notes; the largest came back as a
  // degree-18 ghost). A dense memory — prose facts separated by `·`, links
  // inline — clears the density bar while being real content. So the density
  // has to hold AND the prose has to stay marginal against the link volume:
  // strip the links, and what an index leaves behind is list scaffolding with
  // at most an introduction, while a note leaves sentences throughout. List
  // lines don't count either way — notes use lists too.
  const paragraphs = contentLines.filter(
    (l) => !LIST_LINE_RE.test(l) && proseRest(l).length >= PARAGRAPH_MIN_CHARS
  ).length;
  return paragraphs / links <= PARAGRAPHS_PER_LINK_MAX;
}

/**
 * Harvest an index/hub file (MEMORY.md, or any file recognized as a link hub)
 * into structure, instead of throwing it away (zzallirog 2026-07-18: native
 * Claude-Code memory carries its ONLY connective tissue in MEMORY.md —
 * `[title](file.md)` links grouped under `## Section` headings. Skip the file
 * as a node, but keep the map it draws). Returns per linked file: the section
 * it sits under and the one-line description trailing its link. First mention
 * wins. Only `##`..`######` headings count as sections — a lone `#` title
 * (e.g. "# Memory Index") is the document title, not a group.
 */
const INDEX_LINK_RE = /\[([^\]]*)\]\(([^)\s#]+)\.md(?:#[^)]*)?\)/;

export interface IndexEntry {
  section: string | null;
  description: string | null;
}

export function harvestIndex(sources: string[]): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  for (const content of sources) {
    let section: string | null = null;
    for (const rawLine of stripCodeSpans(content).split("\n")) {
      const line = rawLine.trim();
      const h = /^#{2,6}\s+(.+?)\s*$/.exec(line);
      if (h) {
        // Strip links + markdown out of the section name (Finding #6): a
        // `[[x]]` in a heading would otherwise ride verbatim into the synthetic
        // index node's body as `## [[x]]` and become an UNVETTED related edge
        // (a ghost), contradicting the "links point only at imported ids" rule.
        section =
          h[1]
            .replace(/\[\[[^\]]*\]\]/g, "")
            .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/[#*`_]/g, "")
            .trim() || null;
        continue;
      }
      const m = INDEX_LINK_RE.exec(line);
      if (!m) continue;
      const targetBase = m[2].split("/").pop();
      if (!targetBase) continue;
      const after = line
        .slice(m.index + m[0].length)
        .replace(/^[\s—–\-:·]+/, "")
        .trim();
      if (!map.has(targetBase)) {
        map.set(targetBase, { section, description: after.length > 0 ? after : null });
      }
    }
  }
  return map;
}
