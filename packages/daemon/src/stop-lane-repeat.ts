/**
 * Language-neutral restatement detection for the stop lane (#678).
 *
 * The frustration cue lists only know the languages shipped in lexicon.ts; a
 * Polish or French user never reached the explicit-word minimum, so the lane
 * could not fire for them at all. This signal needs no word list: the user
 * restating an earlier request — the same correction again.
 *
 * Similarity is the Dice coefficient over character bigrams of the
 * letter/digit text, which works in every script without tokenising. Measured
 * on sample pairs: a rephrased correction scores 0.62-0.90, unrelated
 * requests in the same language 0.20-0.38. Similar but different routine
 * requests ("add a test for the date parser" / "… url parser") score high
 * too, so the caller only counts a restatement that carries emphasis.
 */

const REPEAT_SIMILARITY_MIN = 0.6;
/** Short acknowledgements ("ok", "weiter", "continue") are never a restatement. */
const REPEAT_MIN_LETTERS = 12;
/** Long pastes (logs) are compared on their head only — keeps the lane cheap. */
const REPEAT_COMPARE_CHARS = 1000;

function bigramSet(content: string): Set<string> | null {
  const text = (content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ").slice(0, REPEAT_COMPARE_CHARS);
  if ((text.match(/\p{L}/gu) ?? []).length < REPEAT_MIN_LETTERS) return null;
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Indices of the turns that restate an EARLIER turn of `contents`. */
export function restatementIndices(contents: string[]): number[] {
  const sets = contents.map(bigramSet);
  const out: number[] = [];
  for (let i = 1; i < sets.length; i++) {
    const cur = sets[i];
    if (!cur) continue;
    if (sets.slice(0, i).some((prev) => prev !== null && dice(prev, cur) >= REPEAT_SIMILARITY_MIN)) out.push(i);
  }
  return out;
}
