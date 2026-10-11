/** Eval-only chunking and max-per-document; never imported by production. */
import { getEncoding } from "js-tiktoken";
const encoder = getEncoding("cl100k_base");
export const CHUNK_TOKENS = 400;
export const OVERLAP_TOKENS = 80;
export interface SourceChunk { text: string; start: number; end: number; tokens: number }
const count = (s: string): number => encoder.encode(s).length;
const safeBoundary = (s: string, at: number): number =>
  at > 0 && at < s.length && /[\uDC00-\uDFFF]/.test(s[at]) && /[\uD800-\uDBFF]/.test(s[at - 1]) ? at - 1 : at;

/** Source substrings, UTF-16 offsets; whitespace boundaries when available.
 * Also cap chars at 4000 so the production embed-body cap cannot lose a tail. */
export function sourceChunks(text: string): SourceChunk[] {
  if (!text) return [{ text: "", start: 0, end: 0, tokens: 0 }];
  const out: SourceChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let lo = start, hi = Math.min(text.length, start + 4000);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (count(text.slice(start, mid)) <= CHUNK_TOKENS) lo = mid; else hi = mid - 1;
    }
    let end = safeBoundary(text, lo);
    if (end < text.length) {
      const head = text.slice(start, end);
      const lastSpace = head.search(/\s+\S*$/u);
      if (lastSpace > head.length / 2) end = start + lastSpace + (head.slice(lastSpace).match(/^\s+/u)?.[0].length ?? 0);
    }
    if (end <= start) throw new Error("chunker made no progress");
    const body = text.slice(start, end), tokens = count(body);
    if (tokens > CHUNK_TOKENS || body.length > 4000) throw new Error("chunk budget exceeded");
    out.push({ text: body, start, end, tokens });
    if (end === text.length) break;
    lo = start; hi = end;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (count(text.slice(mid, end)) <= OVERLAP_TOKENS) hi = mid; else lo = mid + 1;
    }
    let next = safeBoundary(text, lo);
    // Moving forward to whitespace keeps the overlap <=80 tokens.
    const space = text.slice(next, end).search(/\s/u);
    if (space >= 0) next += space + 1;
    while (next < end && count(text.slice(next, end)) > OVERLAP_TOKENS) next++;
    next = safeBoundary(text, next);
    if (count(text.slice(next, end)) > OVERLAP_TOKENS) next = end;
    start = next > start && next < end ? next : end;
  }
  return out;
}

/** Collapse ALL chunks before limiting documents, so one long document cannot
 * occupy the candidate cap and hide another document's best chunk. */
export function maxPerDocument(hits: { id: string; score: number }[], owners: ReadonlyMap<string, string>): { id: string; score: number }[] {
  const best = new Map<string, number>();
  for (const hit of hits) {
    const id = owners.get(hit.id);
    if (!id) throw new Error(`unknown chunk id ${hit.id}`);
    if (!Number.isFinite(hit.score)) throw new Error("non-finite chunk score");
    if (!best.has(id) || hit.score > best.get(id)!) best.set(id, hit.score);
  }
  return [...best].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
