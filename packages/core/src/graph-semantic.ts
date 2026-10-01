/**
 * Semantic map projection (#207) — the layout layer for the "semantic" view.
 *
 * Positions every embedded note in 2D by MEANING (PCA over the embedding
 * vectors, projected onto the top two principal components) and surfaces the
 * connections you never wrote: pairs that are semantically close (cosine)
 * but share no explicit related/related_via edge in the vault graph.
 *
 * Pure math over the in-memory vector snapshot — no provider calls, no I/O.
 * Ghosts and notes without a vector carry no position here; viewers place
 * them near their linked neighbors.
 *
 * The neighbor scan is O(n²·dim); `buildSemanticLayout` is `async` and
 * yields to the event loop every {@link YIELD_EVERY_ROWS} rows so a large
 * vault's computation (measured 16s+ at n≈3900) does not block every other
 * hook lane on the daemon for the whole run.
 */
import type { VaultGraph } from "./graph.js";
import { cosine } from "./embeddings.js";

export interface SemanticLayout {
  generated_at: string;
  /** embedding dimensionality the layout was computed from (0 = no vectors) */
  dim: number;
  /** notes that received a position */
  count: number;
  /** unit-cube coordinates, shared scale (aspect ratio preserved). `z` is the
   *  third principal component — the 3D mode's depth axis (zzallirog idea:
   *  the vectors and the camera both existed, only the wire was missing). */
  positions: Array<{ id: string; x: number; y: number; z: number }>;
  /** unwritten connections, strongest first */
  edges: Array<{ source: string; target: string; sim: number }>;
}

const KNN_K = 4; // semantic neighbors considered per note
const SIM_FLOOR = 0.6; // below this, "close" isn't close enough to show
const POWER_ITERATIONS = 40;
/** How many outer rows of the O(n²) neighbor scan run before yielding once
 *  to the event loop. At n≈3900 (measured, 16.4s total) this keeps
 *  any one uninterrupted stretch under ~250ms instead of blocking every
 *  hook lane on the daemon for the whole computation. */
const YIELD_EVERY_ROWS = 25;

const pairKey = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function buildSemanticLayout(
  graph: VaultGraph,
  vectors: ReadonlyMap<string, Float32Array>,
): Promise<SemanticLayout> {
  const ids: string[] = [];
  const mat: Float32Array[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "ghost") continue; // unwritten notes have no text to embed
    const v = vectors.get(n.id);
    if (v) {
      ids.push(n.id);
      mat.push(v);
    }
  }

  const pts = project3d(mat);
  const positions = ids.map((id, i) => ({ id, x: pts[i][0], y: pts[i][1], z: pts[i][2] }));

  // unwritten connections: top-k cosine neighbors with no explicit edge
  const written = new Set<string>();
  for (const e of graph.edges) written.add(pairKey(e.source, e.target));
  const seen = new Set<string>();
  const edges: SemanticLayout["edges"] = [];
  for (let i = 0; i < mat.length; i++) {
    const near: Array<{ j: number; sim: number }> = [];
    for (let j = 0; j < mat.length; j++) {
      if (j === i) continue;
      const sim = cosine(mat[i], mat[j]);
      if (sim >= SIM_FLOOR) near.push({ j, sim });
    }
    near.sort((a, b) => b.sim - a.sim);
    for (const { j, sim } of near.slice(0, KNN_K)) {
      const key = pairKey(ids[i], ids[j]);
      if (seen.has(key) || written.has(key)) continue;
      seen.add(key);
      edges.push({ source: ids[i], target: ids[j], sim: Math.round(sim * 1000) / 1000 });
    }
    if (i % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
  }
  edges.sort((a, b) => b.sim - a.sim);

  return {
    generated_at: new Date().toISOString(),
    dim: mat[0]?.length ?? 0,
    count: ids.length,
    positions,
    edges,
  };
}

/** PCA to 2D: mean-center, top two components via power iteration (with
 *  deflation for the second), then scale into the unit square with a SHARED
 *  factor so the semantic geometry keeps its aspect ratio. Deterministic —
 *  fixed start vector, no randomness. */
function project3d(mat: Float32Array[]): Array<[number, number, number]> {
  const n = mat.length;
  if (n === 0) return [];
  const dim = mat[0].length;
  if (n === 1) return [[0.5, 0.5, 0.5]];

  const mean = new Float64Array(dim);
  for (const v of mat) for (let d = 0; d < dim; d++) mean[d] += v[d];
  for (let d = 0; d < dim; d++) mean[d] /= n;
  const centered = mat.map((v) => {
    const r = new Float64Array(dim);
    for (let d = 0; d < dim; d++) r[d] = v[d] - mean[d];
    return r;
  });

  const pc1 = powerIteration(centered, []);
  const pc2 = powerIteration(centered, [pc1]);
  const pc3 = powerIteration(centered, [pc1, pc2]);
  const raw = centered.map(
    (r) => [dot(r, pc1), dot(r, pc2), dot(r, pc3)] as [number, number, number],
  );

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of raw) {
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a];
      if (p[a] > max[a]) max[a] = p[a];
    }
  }
  // shared scale over all three axes (PCs are variance-ordered, so the x-span
  // dominates and the 2D projection stays identical to the old layout)
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (span < 1e-9) return raw.map(() => [0.5, 0.5, 0.5]);
  const pad = [0, 1, 2].map((a) => (span - (max[a] - min[a])) / 2);
  return raw.map(
    (p) =>
      [0, 1, 2].map((a) => round3((p[a] - min[a] + pad[a]) / span)) as [number, number, number],
  );
}

/** Dominant eigenvector of Xᵀ·X without materializing the (dim×dim) matrix:
 *  v ← Σᵢ (xᵢ·v)·xᵢ, re-orthogonalized against every `deflates` entry. */
function powerIteration(centered: Float64Array[], deflates: Float64Array[]): Float64Array {
  const dim = centered[0].length;
  let v = new Float64Array(dim);
  for (let d = 0; d < dim; d++) v[d] = Math.sin(d + 1); // fixed, non-degenerate start
  normalize(v);
  const deflateAgainst = (vec: Float64Array): void => {
    for (const def of deflates) {
      const p = dot(vec, def);
      for (let d = 0; d < dim; d++) vec[d] -= p * def[d];
    }
  };
  for (let it = 0; it < POWER_ITERATIONS; it++) {
    deflateAgainst(v);
    const next = new Float64Array(dim);
    for (const row of centered) {
      const proj = dot(row, v);
      for (let d = 0; d < dim; d++) next[d] += proj * row[d];
    }
    if (!normalize(next)) break; // no variance left along this direction
    v = next;
  }
  if (deflates.length > 0) {
    deflateAgainst(v);
    normalize(v);
  }
  return v;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Scales to unit length in place; false when the vector is ~zero. */
function normalize(v: Float64Array): boolean {
  const len = Math.sqrt(dot(v, v));
  if (len < 1e-12) return false;
  for (let i = 0; i < v.length; i++) v[i] /= len;
  return true;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
