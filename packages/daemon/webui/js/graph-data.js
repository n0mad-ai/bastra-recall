/** Data layer: fetch the open graph projection and derive render attributes.
 *  Colors use the golden angle so any cluster count stays distinguishable;
 *  saturation/lightness come from CSS variables so both themes get their own
 *  ink. */

const GOLDEN_ANGLE = 137.508;

export async function fetchGraph() {
  const res = await fetch("/api/v1/graph");
  if (!res.ok) throw new Error(`graph fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchNode(id) {
  const res = await fetch(`/api/v1/graph/node?id=${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

/** Semantic search — the daemon's hybrid recall (BM25 + embeddings). */
export async function fetchSemanticLayout() {
  const res = await fetch("/api/v1/graph/semantic");
  if (res.status === 503) throw new Error("the embedding index is still warming up");
  if (!res.ok) throw new Error(`semantic layout fetch failed: ${res.status}`);
  return res.json();
}

export async function postImport(text, source) {
  const res = await fetch("/ui/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `import failed: ${res.status}`);
  return data;
}

export async function postImportVault(dir, label) {
  const res = await fetch("/ui/import-vault", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir, label }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `import failed: ${res.status}`);
  return data;
}

export async function fetchAreas() {
  const res = await fetch("/ui/areas");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `areas failed: ${res.status}`);
  return data.areas ?? [];
}

export async function postArea(payload) {
  const res = await fetch("/ui/areas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `area change failed: ${res.status}`);
  return data.result;
}

export async function fetchOnboarding() {
  const res = await fetch("/ui/onboarding");
  if (!res.ok) throw new Error(`onboarding: ${res.status}`);
  return res.json();
}

export async function postOnboarding(body) {
  const res = await fetch("/ui/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `onboarding failed: ${res.status}`);
  return data;
}

export async function postChat(message, history) {
  const res = await fetch("/ui/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `chat failed: ${res.status}`);
  return data;
}

export async function fetchSemanticSearch(query) {
  const res = await fetch(`/ui/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  return (await res.json()).hits ?? [];
}

/** Vault-care flags (open entries live in vault-care.md, daemon-parsed). */
export async function fetchAnnotations() {
  try {
    const res = await fetch("/ui/annotations");
    if (!res.ok) return [];
    return (await res.json()).annotations ?? [];
  } catch {
    return [];
  }
}

export async function postAnnotation(id, kind, note) {
  const res = await fetch("/ui/annotate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, kind, note }),
  });
  if (!res.ok) throw new Error(`annotate failed: ${res.status}`);
  return (await res.json()).entry;
}

/** Telemetry tab (#463): the stats series over the user's own event logs. */
export async function fetchTelemetry(days) {
  const res = await fetch(`/ui/telemetry?days=${encodeURIComponent(days)}`);
  if (!res.ok) throw new Error(`telemetry fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchHealth() {
  try {
    const res = await fetch("/health");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** cluster key → stable hue (index in the size-sorted cluster list). */
export function clusterHues(clusters) {
  const hues = new Map();
  clusters.forEach((c, i) => hues.set(c.key, (i * GOLDEN_ANGLE + 205) % 360));
  return hues;
}

export function clusterColor(hues, key, sat, light) {
  const h = hues.get(key) ?? 0;
  return `hsl(${h.toFixed(1)} ${sat} ${light})`;
}

/** #217 Valenz: emotion → heißer Glow-Core. Cluster-Fill bleibt die
 *  Karten-Identität; das Gefühl sitzt im Kern des Glows. neutral = kein Core. */
/** Events a memory needs before its heat is drawn at all (#227).
 *
 *  `heat` is a share of THIS vault's hottest node, so on a cold corpus a single
 *  event reads as 1.0 — zzallirog measured two of 528 nodes painted as the
 *  hottest memories he owned, and they were merely the only ones touched. On
 *  this vault 83 of 215 reached nodes sit at weight 1: one `loaded`, nothing
 *  else. That is a graze, not demand.
 *
 *  Two is the honest floor because `acted_on` counts double: a memory that was
 *  APPLIED once keeps its core, one that was merely opened does not. Applied
 *  counts, looked-at doesn't.
 *
 *  Deliberately a display rule, not an API one — the daemon keeps serving heat
 *  and reach in full, the map decides what it shows. */
export const HEAT_MIN_WEIGHT = 2;

export const EMOTION_CORE = {
  frustration: "hsl(8 70% 60%)",
  success: "hsl(140 55% 55%)",
  risk: "hsl(45 85% 60%)",
};

/** Pre-rendered glow sprites (#216): per-frame createRadialGradient is a
 *  classic canvas frame-killer (hundreds of allocations + rasterizations per
 *  frame). Render each glow ONCE to a small offscreen canvas, keyed by its
 *  colors, then drawImage it scaled — the standard sprite-cache pattern. */
const glowSprites = new Map();
export function glowSprite(color, core = null) {
  const key = `${color}|${core ?? ""}`;
  let spr = glowSprites.get(key);
  if (!spr) {
    spr = document.createElement("canvas");
    spr.width = spr.height = 64;
    const c = spr.getContext("2d");
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    if (core) {
      g.addColorStop(0, core);
      g.addColorStop(0.35, color);
    } else {
      g.addColorStop(0, color);
    }
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    glowSprites.set(key, spr);
  }
  return spr;
}

/** Node radius from degree — sqrt so hubs read big without dwarfing notes.
 *  Ghosts get a bigger base: they carry no fill, so they need size to read.
 *  Skills sit between: solid but often low-degree, so they get size too. */
export function nodeRadius(node) {
  const base = node.kind === "ghost" ? 5.2 : node.kind === "skill" ? 4.2 : 2.6;
  return Math.min(base + Math.sqrt(node.degree) * 1.7, 15);
}

/** Client-side search over the loaded nodes (title, id, tags, summary). */
export function searchNodes(nodes, query, limit = 8) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const scored = [];
  for (const n of nodes) {
    const title = n.title.toLowerCase();
    const id = n.id.toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score = 100;
    else if (title.includes(q)) score = 60;
    else if (id.includes(q)) score = 40;
    else if (n.tags.some((t) => t.toLowerCase().includes(q))) score = 30;
    else if (n.summary.toLowerCase().includes(q)) score = 15;
    if (score > 0) scored.push({ node: n, score: score + Math.min(n.degree, 10) * 0.5 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.node);
}
