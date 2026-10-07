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
  let words: ReturnType<typeof vaultWords> | null = null;
  return (quote: string): string | null => {
    const q = new Set(tokens(quote));
    if (q.size === 0) return null;
    const hits = search.recall([...q].join(" "), { k: CANDIDATES_K, allow_private: true });
    if (hits.length === 0) return null;
    words ??= vaultWords(vault);
    for (const hit of hits) {
      const inside = words.sets.get(hit.id);
      if (inside && weightedContainment(q, inside, words.idf) >= STORED_CONTAINMENT_MIN) return hit.id;
    }
    return null;
  };
}


function vaultWords(vault: Vault): { sets: Map<string, Set<string>>; idf: (token: string) => number } {
  const sets = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const memory of vault.list()) {
    const words = new Set(tokens(memoryText(memory)));
    sets.set(memory.fm.id, words);
    for (const word of words) df.set(word, (df.get(word) ?? 0) + 1);
  }
  return { sets, idf: token => Math.log((sets.size + 1) / ((df.get(token) ?? 0) + 1)) };
}

/** The existing word measure for a specific note, beside semantic shadow scores. */
export function storedQuoteScorer(vault: Vault): (quote: string, id: string) => number {
  const words = vaultWords(vault);
  return (quote, id) => {
    const inside = words.sets.get(id);
    return inside ? weightedContainment(new Set(tokens(quote)), inside, words.idf) : 0;
  };
}
