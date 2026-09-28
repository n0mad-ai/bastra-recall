/**
 * #675 — is a harvested quote already in the vault?
 *
 * The contributor who measured the after-session harvest found 25 % of the
 * facts it extracted already stored (161 duplicates, 151 appends of 1,225).
 * Relaying those costs relay budget (5 entries, 3,000 chars) and asks the
 * agent to recall and decide something the vault already holds.
 *
 * BM25 generates candidates, as in the save-time duplicate check (#239); it
 * does not decide. The decision is a weighted containment: the share of the
 * quote's words that the stored memory also carries, each word weighted by
 * its inverse document frequency over this vault.
 *
 * The IDF weight is what keeps this language-neutral (#676): a function word
 * of any language occurs in most notes of that language and weighs close to
 * nothing, so no stopword list is needed, and an unknown language takes the
 * same path as every other one. A rephrased or translated note is not
 * matched — the check only drops quotes the vault already says in the same
 * words, and relaying one duplicate costs less than dropping a new fact.
 */
import type { SearchIndex, Vault } from "@bastra-recall/core";
import { tokens } from "./save-similarity.js";

/** Share of the quote's IDF weight a memory must carry to count as stored. */
export const STORED_CONTAINMENT_MIN = 0.7;
const CANDIDATES_K = 8;
/** Long bodies are compared on their head, like the other similarity paths. */
const BODY_COMPARE_CHARS = 4000;

type MemoryLike = ReturnType<Vault["list"]>[number];

function memoryText(m: MemoryLike): string {
  const fm = m.fm as { title?: unknown; summary?: unknown; tags?: unknown; recall_when?: unknown };
  const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : "");
  return [
    typeof fm.title === "string" ? fm.title : "",
    typeof fm.summary === "string" ? fm.summary : "",
    list(fm.tags),
    list(fm.recall_when),
    m.body.slice(0, BODY_COMPARE_CHARS),
  ].join("\n");
}

/** Weighted containment of `quote` in `inside`, 0..1. Pure, exported for tests. */
export function weightedContainment(quote: Set<string>, inside: Set<string>, idf: (t: string) => number): number {
  let total = 0;
  let shared = 0;
  for (const t of quote) {
    const w = idf(t);
    total += w;
    if (inside.has(t)) shared += w;
  }
  return total === 0 ? 0 : shared / total;
}

/**
 * A matcher over the vault as it is now: returns the id of a memory that
 * already holds `quote`, or null. Token sets and document frequencies are
 * built on the first call and reused for the rest of the pass.
 */
export function storedQuoteMatcher(vault: Vault, search: SearchIndex): (quote: string) => string | null {
  let sets: Map<string, Set<string>> | null = null;
  let df: Map<string, number> | null = null;
  const build = (): void => {
    sets = new Map();
    df = new Map();
    for (const m of vault.list()) {
      const s = new Set(tokens(memoryText(m)));
      sets.set(m.fm.id, s);
      for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
    }
  };
  return (quote: string): string | null => {
    const q = new Set(tokens(quote));
    if (q.size === 0) return null;
    const hits = search.recall([...q].join(" "), { k: CANDIDATES_K, allow_private: true });
    if (hits.length === 0) return null;
    if (sets === null) build();
    const n = sets!.size;
    const idf = (t: string): number => Math.log((n + 1) / ((df!.get(t) ?? 0) + 1));
    for (const hit of hits) {
      const inside = sets!.get(hit.id);
      if (inside && weightedContainment(q, inside, idf) >= STORED_CONTAINMENT_MIN) return hit.id;
    }
    return null;
  };
}
