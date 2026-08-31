/**
 * Vault graph projection (#207) — the open-data contract for map viewers.
 *
 * Builds a nodes/edges/clusters JSON view over the in-memory vault:
 *   - nodes: every non-private memory/doc, plus "ghost" nodes for wikilink
 *     targets that don't exist yet (unwritten notes).
 *   - edges: hand/body `related[]` plus enricher `related_via[]`, deduped.
 *   - clusters: top-level vault folders; `projects/<scope>` counts as its own
 *     cluster so one giant `projects` blob doesn't swallow the map.
 *   - bridges: nodes whose neighbors span ≥2 foreign clusters — connections
 *     the folder structure doesn't show.
 *
 * Any viewer (daemon web UI, Mac app, external tools) renders from this same
 * projection; none of them is privileged (#140).
 */
import { basename, relative, sep, sep as sepChar } from "node:path";
import type { Vault } from "./vault.js";
import type { Memory } from "./schema.js";

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  scope: string;
  cluster: string;
  /** memory building block — the coarse grouping layer above clusters:
   *  projects | people | self | knowledge | rules | artifacts | other */
  group: string;
  /** the folder level BELOW the cluster (e.g. a project's sub-area like
   *  "infra" or a knowledge domain like "css"); "general" when flat */
  sub: string;
  tags: string[];
  summary: string;
  updated: string;
  /** total edge count, ghost links included — viewers scale node size on it */
  degree: number;
  kind: "memory" | "doc" | "ghost" | "skill";
  /** foreign clusters this node connects (present only when ≥2 → a bridge) */
  bridge?: string[];
  /** ghosts/skills only: ids of the existing memories that link to it */
  linked_by?: string[];
  /** #217 Valenz: emotionale Salience 0..1 — Renderer skaliert den Glow. */
  salience?: number;
  /** #217 Valenz: Ton des Erfassungsmoments — färbt den Glow-Core. */
  emotion?: string;
  /** #217 Phase 3: Usage-Heat 0..1 (#154-Sidecar). Wird vom DAEMON beim
   *  Serve gestampt — buildGraph selbst bleibt reine Vault-Projektion. */
  heat?: number;
  /** #227: die Zahlen HINTER der Heat, unnormalisiert. `heat` ist ein Rang
   *  innerhalb dieses Vaults (Anteil am heißesten Knoten) — auf einem kalten
   *  Vault trägt der eine berührte Knoten 1.0. Erst diese Werte erlauben die
   *  Unterscheidung „oft erreicht" von „sonst wurde nichts erreicht", und
   *  `last_at` macht die Frage nach einem Zeitterm beantwortbar. Ebenfalls
   *  vom Daemon beim Serve gestampt. */
  reach?: {
    loaded: number;
    acted_on: number;
    /** loaded + 2 × acted_on — das Gewicht, aus dem heat berechnet wird */
    weight: number;
    /** jüngster Kontakt (ISO) oder null, wenn nie erreicht */
    last_at: string | null;
  };
}

/**
 * A declared skill (#213): a link target that lives on another surface (a
 * skill file, an external doc) — declared once by the user, never scanned or
 * synced. Registered ids stop rendering as "unwritten" ghosts and become
 * first-class reference nodes in their own `skills` ring instead.
 */
export interface SkillRef {
  id: string;
  label?: string;
  note?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  via: "related" | "related_via";
}

export interface GraphCluster {
  key: string;
  count: number;
}

export interface VaultGraph {
  generated_at: string;
  /** display name of the vault — the root folder's name */
  vault_name: string;
  vault_size: number;
  /** #332: was `vault_size` mitzählt und der Graph bewusst NICHT zeichnet.
   *  Ohne diese Zahl ist `vault_size` minus der memory/doc-Nodes ein
   *  unerklärtes Delta — auf einem Live-Vault waren es 622 gegen 620, und
   *  klein genug, dass es am Bild niemand sieht. `vault_size` bleibt die
   *  Zahl aus `/health` und der Statusline; erklärbar wird sie hier:
   *  vault_size − withheld.private === Anzahl der memory+doc-Nodes. */
  withheld: { private: number };
  clusters: GraphCluster[];
  /** the coarse layer: memory building blocks with member counts */
  groups: GraphCluster[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** #217 (zzallirog 2026-07-18): `edges` mischt zwei Dinge unter EINEM Namen
   *  — `related` (explizit geschriebene [[wikilinks]]) und `related_via`
   *  (semantisch geraten, taucht auf sobald Embeddings laufen). Ein naives
   *  `edges.length` springt beim Embedding-Toggle massiv, ohne dass ein Link
   *  aufgelöst wurde. Getrennt gezählt, damit Consumer „geschrieben" nicht mit
   *  „geraten" verwechseln. */
  edge_counts: { related: number; related_via: number };
}

/** Source hierarchy an import batch recorded in `topic_path`, past its own
 *  ["imported", <label>] prefix. Empty for files that sat flat in the source. */
/** `rel.startsWith("..")` ist zu grob: Ein legitimer Vault-Unterordner namens
 *  `..sync` beginnt ebenfalls mit zwei Punkten und galt damit als außerhalb
 *  (Codex-Gegenreview, P2). Nur ein `..`-SEGMENT verlässt den Baum. */
function escapesTree(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + sepChar) || rel.startsWith("../");
}

function importedTopicSegments(m: Memory): string[] {
  const tp = m.fm.topic_path ?? [];
  return tp[0] === "imported" ? tp.slice(2) : [];
}

/**
 * Cluster key from the memory's location in the vault:
 *   memories/projects/<scope>/… → "<scope>"
 *   memories/imported/<label>/… → "<source folder> (import)", else
 *                                 "<label> (import)"
 *   memories/<top>/…            → "<top>"
 *   <top>/…                     → "<top>"   (e.g. dokumentationen)
 * Files outside the root (linked docs) fall back to the frontmatter scope.
 *
 * Import sets cluster PER LABEL (#217): several imports must not merge into
 * one big "imported" blob — each imported project stays its own cloud with
 * its own color, visually dissolving as adoption drains it. The " (import)"
 * suffix keeps the key from ever colliding with a real project cluster of
 * the same name.
 *
 * Per label is necessary but not sufficient: with a SINGLE batch there is
 * nothing to keep apart, and the blob comes back whole. The importer writes
 * every file flat into `memories/imported/<label>/`, so the folder axis is
 * empty by construction — but the source hierarchy is not lost, only unread:
 * it sits in `topic_path` as ["imported", <label>, …sourceSegments]. Read it,
 * and keep the suffix, so the collision guard above still holds.
 *
 * This moves keys only: node, edge and ghost counts are identical either way.
 * The fixture in graph-import-cluster.test.ts pins both halves — a nested
 * source keeps its top folder as the cluster, a flat one falls back to the
 * batch label, and non-imported clusters stay untouched.
 */
export function clusterKeyFor(m: Memory, vaultRoot: string): string {
  const rel = relative(vaultRoot, m.filePath);
  if (escapesTree(rel)) return m.fm.scope;
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length < 2) return m.fm.scope; // file directly at the root
  const top = parts[0] === "memories" && parts.length > 2 ? parts[1] : parts[0];
  if (top === "projects" && parts[0] === "memories" && parts.length > 3) {
    return parts[2];
  }
  if (top === "imported" && parts[0] === "memories" && parts.length > 3) {
    return `${importedTopicSegments(m)[0] ?? parts[2]} (import)`;
  }
  return top;
}

/**
 * Memory building block (the coarse ontology layer above clusters):
 *   projects  — everything under memories/projects/
 *   people    — the person memos
 *   self      — the user's own profile/preferences (memories/user)
 *   knowledge — knowledge + cross-project lessons (all-projects)
 *   rules     — conventions + the vault's own taxonomy
 *   artifacts — documents and bookmarks (external things memories point at)
 *   other     — anything the folder ontology doesn't place (transit folders …)
 * Derived from the folder structure so it works on ANY vault, never from a
 * hardcoded cluster list.
 */
export function groupKeyFor(m: Memory, vaultRoot: string): string {
  if (m.fm.type === "doc" || m.fm.type === "bookmark") return "artifacts";
  const rel = relative(vaultRoot, m.filePath);
  if (escapesTree(rel)) return "other";
  const parts = rel.split(sep).filter(Boolean);
  const top = parts[0] === "memories" && parts.length > 2 ? parts[1] : parts[0];
  switch (top) {
    case "projects":
      return "projects";
    case "people":
      return "people";
    case "user":
      return "self";
    case "knowledge":
    case "all-projects":
      return "knowledge";
    case "conventions":
    case "taxonomy":
      return "rules";
    case "documents":
    case "bookmarks":
      return "artifacts";
    case "imported":
      // #217 intake area: foreign memories awaiting adoption — their own
      // building block, not "other" noise.
      return "intake";
    default:
      return "other";
  }
}

/**
 * Sub-area: the folder level directly below the memory's cluster folder —
 * a project's sub-area (projects/<scope>/<area>/…), a knowledge domain
 * (all-projects/<domain>/…), a convention area, a document category folder.
 * "general" for files sitting flat in their cluster folder.
 */
export function subKeyFor(m: Memory, vaultRoot: string): string {
  const rel = relative(vaultRoot, m.filePath);
  if (escapesTree(rel)) return "general";
  const parts = rel.split(sep).filter(Boolean);
  // index of the cluster folder inside the path — projects/<scope> and
  // imported/<label> both put the cluster one level deeper
  let idx: number;
  if (parts[0] === "memories" && parts.length > 2) {
    idx = (parts[1] === "projects" || parts[1] === "imported") && parts.length > 3 ? 2 : 1;
  } else {
    idx = 0;
  }
  // Imported sets are flat on disk, so the folder axis can never answer this.
  // The second source segment is the sub-area, same as a folder would be.
  if (parts[0] === "memories" && parts[1] === "imported") {
    return importedTopicSegments(m)[1] ?? "general";
  }
  // a sub-area exists when there is at least one more folder before the file
  return parts.length > idx + 2 ? parts[idx + 1] : "general";
}

export function buildGraph(vault: Vault, skills: SkillRef[] = []): VaultGraph {
  // Private memories stay off the wire entirely — same default the other
  // externally reachable endpoints apply (min_sensitivity "team"). How many
  // that drops is reported as `withheld` (#332), so the gap to `vault_size`
  // is a stated exclusion rather than a silent one.
  const all = vault.list();
  const memories = all.filter((m) => m.fm.sensitivity !== "private");
  const byId = new Map(memories.map((m) => [m.fm.id, m]));
  // Declared skills keep their identity regardless of live links — the fix
  // for "my skills are gone": a ghost exists only while a linker survives,
  // a registered skill is emitted always. A vault memory with the same id
  // wins (the file is the truth); the registry entry is ignored then.
  const skillById = new Map(
    skills.filter((s) => !byId.has(s.id)).map((s) => [s.id, s]),
  );

  const clusterOf = new Map<string, string>();
  const groupOf = new Map<string, string>();
  const subOf = new Map<string, string>();
  for (const m of memories) {
    clusterOf.set(m.fm.id, clusterKeyFor(m, vault.root));
    groupOf.set(m.fm.id, groupKeyFor(m, vault.root));
    subOf.set(m.fm.id, subKeyFor(m, vault.root));
  }

  // ── edges (deduped; `related` wins over `related_via` on collision) ──────
  const edgeVia = new Map<string, "related" | "related_via">();
  const ghostLinkers = new Map<string, string[]>(); // ghost id → linker ids
  for (const m of memories) {
    const targets = new Map<string, "related" | "related_via">();
    for (const t of m.fm.related) targets.set(t, "related");
    for (const rv of m.fm.related_via) {
      if (!targets.has(rv.id)) targets.set(rv.id, "related_via");
    }
    for (const [target, via] of targets) {
      if (target === m.fm.id) continue;
      if (!byId.has(target)) {
        // Missing target = unwritten note, unless it's a private memory —
        // those must not surface, not even as a ghost silhouette.
        if (vault.get(target)?.fm.sensitivity === "private") continue;
        // Declared skill → not a ghost; the skill node (emitted below for
        // every registry entry) is the edge's endpoint. linked_by is still
        // collected so the skill shows who leans on it.
        const linkers = ghostLinkers.get(target) ?? [];
        if (!linkers.includes(m.fm.id)) linkers.push(m.fm.id);
        ghostLinkers.set(target, linkers);
      }
      const key = `${m.fm.id}\u0000${target}`;
      const prev = edgeVia.get(key);
      if (prev === undefined || (prev === "related_via" && via === "related")) {
        edgeVia.set(key, via);
      }
    }
  }

  const edges: GraphEdge[] = [];
  const edge_counts = { related: 0, related_via: 0 };
  for (const [key, via] of edgeVia) {
    const [source, target] = key.split("\u0000");
    edges.push({ source, target, via });
    edge_counts[via]++;
  }

  // ── degree + neighbor clusters (for size + bridge detection) ─────────────
  const degree = new Map<string, number>();
  const neighborClusters = new Map<string, Set<string>>();
  const bump = (id: string, otherCluster: string | undefined): void => {
    degree.set(id, (degree.get(id) ?? 0) + 1);
    if (otherCluster !== undefined) {
      const set = neighborClusters.get(id) ?? new Set<string>();
      set.add(otherCluster);
      neighborClusters.set(id, set);
    }
  };
  for (const e of edges) {
    bump(e.source, clusterOf.get(e.target));
    bump(e.target, clusterOf.get(e.source));
  }

  const bridgeFor = (id: string): string[] | undefined => {
    const own = clusterOf.get(id);
    const foreign = [...(neighborClusters.get(id) ?? [])].filter((c) => c !== own).sort();
    return foreign.length >= 2 ? foreign : undefined;
  };

  // ── nodes ─────────────────────────────────────────────────────────────────
  const nodes: GraphNode[] = memories.map((m) => {
    const id = m.fm.id;
    const bridge = bridgeFor(id);
    return {
      id,
      title: m.fm.title,
      type: m.fm.type,
      scope: m.fm.scope,
      cluster: clusterOf.get(id) ?? m.fm.scope,
      group: groupOf.get(id) ?? "other",
      sub: subOf.get(id) ?? "general",
      tags: m.fm.tags,
      summary: m.fm.summary,
      updated: m.fm.updated,
      degree: degree.get(id) ?? 0,
      kind: m.fm.type === "doc" ? "doc" : "memory",
      ...(bridge ? { bridge } : {}),
      // #217: nur echte Memories tragen Valenz; Ghost-/Skill-Nodes bleiben ohne.
      ...(typeof m.fm.salience === "number" ? { salience: m.fm.salience } : {}),
      ...(m.fm.emotion ? { emotion: m.fm.emotion } : {}),
    };
  });

  for (const [id, linkers] of ghostLinkers) {
    if (skillById.has(id)) continue; // declared skill, emitted below
    // A ghost hovers with the cluster that references it most.
    const counts = new Map<string, number>();
    for (const l of linkers) {
      const c = clusterOf.get(l);
      if (c !== undefined) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let cluster = "";
    let best = -1;
    for (const [c, n] of counts) {
      if (n > best) {
        best = n;
        cluster = c;
      }
    }
    clusterOf.set(id, cluster);
    // a ghost inherits the building block of the SAME linker that decided its
    // cluster — cluster and group must never disagree on a tie
    const groupLinker = linkers.find((l) => clusterOf.get(l) === cluster);
    const linkerGroup = (groupLinker !== undefined ? groupOf.get(groupLinker) : undefined) ?? "other";
    const bridge = bridgeFor(id);
    nodes.push({
      id,
      title: id,
      type: "ghost",
      scope: "",
      cluster,
      group: linkerGroup,
      sub: (groupLinker !== undefined ? subOf.get(groupLinker) : undefined) ?? "general",
      tags: [],
      summary: "",
      updated: "",
      degree: degree.get(id) ?? 0,
      kind: "ghost",
      ...(bridge ? { bridge } : {}),
      linked_by: linkers.sort(),
    });
  }

  // ── skills ring (#213) — every registered skill, linked or not ───────────
  // Emitted unconditionally so a skill keeps its place on the map even when
  // the last memory linking it is rewritten (ghosts vanish then, skills stay).
  for (const [id, s] of skillById) {
    clusterOf.set(id, "skills");
    const bridge = bridgeFor(id);
    nodes.push({
      id,
      title: s.label && s.label.trim().length > 0 ? s.label : id,
      type: "skill",
      scope: "",
      cluster: "skills",
      group: "skills",
      sub: "general",
      tags: [],
      summary: s.note ?? "",
      updated: "",
      degree: degree.get(id) ?? 0,
      kind: "skill",
      ...(bridge ? { bridge } : {}),
      linked_by: (ghostLinkers.get(id) ?? []).sort(),
    });
  }

  // ── clusters, largest first (stable order = stable colors in viewers) ────
  const clusterCounts = new Map<string, number>();
  for (const n of nodes) {
    clusterCounts.set(n.cluster, (clusterCounts.get(n.cluster) ?? 0) + 1);
  }
  const clusters: GraphCluster[] = [...clusterCounts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const groupCounts = new Map<string, number>();
  for (const n of nodes) {
    groupCounts.set(n.group, (groupCounts.get(n.group) ?? 0) + 1);
  }
  const groups: GraphCluster[] = [...groupCounts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    generated_at: new Date().toISOString(),
    vault_name: basename(vault.root),
    vault_size: vault.size(),
    withheld: { private: all.length - memories.length },
    clusters,
    groups,
    nodes,
    edges,
    edge_counts,
  };
}
