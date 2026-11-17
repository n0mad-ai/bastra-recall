/**
 * Deterministic 32-bit PRNG (mulberry32): no dependency, the same draw
 * everywhere. The gold-set split, the gold-set control arm and the rerank
 * bootstrap all draw from it, so a registered seed reproduces the same split,
 * the same random ranking and the same interval on unchanged data. The
 * sequence for a given seed must never change: registrations cite numbers
 * that depend on it (`__tests__/seeded-random.test.ts` pins it).
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
