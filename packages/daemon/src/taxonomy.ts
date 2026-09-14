/**
 * Selbstlernende Taxonomie (#64) — Daemon-Seite.
 *
 * Zwei Bausteine:
 *   - listConventions(): die Konventions-Memories aus dem reservierten Scope
 *     "taxonomy" (#65), kompakt für die Session-Hook-Injection (#66). Bewusst
 *     ein Listen-Endpoint statt Suche — Konventionen sind bindende Regeln und
 *     dürfen nicht am Recall-Score-Floor sterben.
 *   - detectTaxonomyDrift(): erkennt, wenn jüngste Memories wiederholt
 *     dasselbe Ad-hoc-Cluster bilden (gemeinsamer Tag / topic_path-Bereich),
 *     ohne dass eine Konvention es abdeckt (#67). Suggestion-only — der
 *     Stop-Hook formatiert daraus einen Hinweis; geschrieben wird nie
 *     automatisch.
 */
import type { Vault } from "@bastra-recall/core";
import { scopeEquals } from "@bastra-recall/core/scope";
import { envInt } from "./env.js";

export interface ConventionLean {
  id: string;
  title: string;
  summary: string;
  updated: string;
}

export const TAXONOMY_SCOPE = "taxonomy";

/** #360-D: Bestands-Frontmatter kann von Hand geschrieben sein — ein
 *  "Taxonomy" hätte die Konventionen still aus der Session-Injektion fallen
 *  lassen UND dasselbe Memory zugleich als Drift-Kandidat behandelt (die
 *  beiden Prüfungen unten sind Negationen voneinander und müssen deshalb
 *  dieselbe Faltung benutzen). */
function isTaxonomyScope(scope: unknown): boolean {
  return typeof scope === "string" && scopeEquals(scope, TAXONOMY_SCOPE);
}

export function listConventions(vault: Vault, cap = 12): ConventionLean[] {
  return vault
    .list()
    .filter((m) => isTaxonomyScope(m.fm.scope) && !m.fm.obsolete)
    .sort((a, b) => String(b.fm.updated).localeCompare(String(a.fm.updated)))
    .slice(0, cap)
    .map((m) => ({
      id: m.fm.id,
      title: m.fm.title,
      summary: m.fm.summary,
      updated: String(m.fm.updated),
    }));
}

export interface DriftCluster {
  /** Normalisierter Cluster-Schlüssel, z.B. "person" oder "deployment". */
  key: string;
  kind: "tag" | "topic";
  /** Distinkte Memories im Fenster, die den Schlüssel teilen. */
  count: number;
  /** Bis zu 3 Beispiel-Memory-Ids. */
  examples: string[];
}

/** Memory-Typen + strukturelle Werte, die als Cluster-Schlüssel nur Rauschen
 *  wären (jedes lesson-Memory trägt den Tag-Kandidaten "lesson" implizit). */
const NOISE_KEYS = new Set([
  "lesson",
  "preference",
  "project-fact",
  "meta-working",
  "decision",
  "workflow",
  "reference",
  "user-preference",
  "bookmark",
  "doc",
  "convention",
  // Vom Daemon selbst vergeben (save_product_doc), nicht vom Autor gewählt.
  "product-doc",
]);

/** Versions-/Meilenstein-Tags (v0.9, v1.0, v0.8.6) sind Zeitmarken, keine
 *  Themen: jeder Release bringt ein neues, das wochenlang ein Cluster
 *  bildet und dann stirbt. Eine Konvention pro Version wäre absurd. */
const VERSION_TAG = /^v\d+\.\d+(?:\.\d+)?$/;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

const PEOPLE_TOPIC_ROOT = "people";

function isPersonMemory(tags: string[], topicPath: string[]): boolean {
  return tags.some((t) => norm(t) === "person") || norm(topicPath[0] ?? "") === PEOPLE_TOPIC_ROOT;
}

/**
 * Wiederkehrende Cluster ohne Konvention finden.
 *
 * Heuristik (bewusst konservativ — lieber still als nervig):
 *   - Fenster: Memories mit `updated` in den letzten BASTRA_DRIFT_WINDOW_DAYS
 *     (Default 14).
 *   - Schlüssel-Kandidaten pro Memory: jeder Tag plus jedes
 *     topic_path-Segment AB Index 1 (Segment 0 ist fast immer der Projekt-/
 *     Scope-Name — der hat mit memories/projects/<scope>/ schon eine Heimat).
 *   - Cluster ab BASTRA_DRIFT_MIN_CLUSTER (Default 8) distinkten Memories.
 *     Bis 05.09.2026 war der Default 3 — damit schob der Detektor nach
 *     jeder etablierten Konvention sofort das nächstkleinere Cluster nach,
 *     bis hinunter zu Dreiergruppen, die keine Konvention wert sind.
 *   - Abgedeckt = eine Konvention (scope=taxonomy) erwähnt den Schlüssel in
 *     tags, topic_path oder Titel — dann ist das Cluster gelernt und still.
 *   - Scope-Namen selbst, Memory-Typen, systemvergebene Tags (product-doc)
 *     und Versions-Tags (v1.0, v0.8.6) sind nie Schlüssel (Rauschen).
 *   - Maximal 2 Vorschläge, größtes Cluster zuerst.
 */
export function detectTaxonomyDrift(vault: Vault, now: number = Date.now()): DriftCluster[] {
  const windowDays = envInt("BASTRA_DRIFT_WINDOW_DAYS", 14);
  const minCluster = envInt("BASTRA_DRIFT_MIN_CLUSTER", 8);
  const cutoff = now - windowDays * 86_400_000;

  const all = vault.list();

  // Coverage-Korpus: was bestehende Konventionen bereits benennen.
  const covered = new Set<string>();
  for (const c of all) {
    if (!isTaxonomyScope(c.fm.scope) || c.fm.obsolete) continue;
    for (const t of c.fm.tags) covered.add(norm(t));
    for (const seg of c.fm.topic_path) covered.add(norm(seg));
    for (const w of c.fm.title.toLowerCase().split(/[^a-zäöüß0-9_-]+/u)) {
      if (w.length >= 3) covered.add(w);
    }
  }

  // Personen-Memories (Konvention: ein Memory pro Person, Tag `person`,
  // topic_path [people, <handle>]) decken ihren Handle mit ab: andere
  // Memories tragen den Handle als topic_path-Segment oder Tag, um auf die
  // Person zu verweisen — das ist kein heimatloses Cluster, die Heimat ist
  // das Personen-Memory selbst. Sonst müsste jede Person einzeln in eine
  // Konvention geschrieben werden.
  for (const m of all) {
    if (m.fm.obsolete || !isPersonMemory(m.fm.tags, m.fm.topic_path)) continue;
    covered.add(norm(m.fm.id));
    const handle = m.fm.topic_path[1];
    if (typeof handle === "string") covered.add(norm(handle));
  }

  // Scope-Namen sind strukturell, keine Drift-Kandidaten.
  const scopeNames = new Set(all.map((m) => norm(m.fm.scope)));

  const clusters = new Map<string, { kind: "tag" | "topic"; ids: Set<string> }>();
  for (const m of all) {
    if (isTaxonomyScope(m.fm.scope) || m.fm.obsolete) continue;
    const updatedMs = Date.parse(String(m.fm.updated));
    if (!Number.isFinite(updatedMs) || updatedMs < cutoff) continue;

    const candidates = new Map<string, "tag" | "topic">();
    for (const t of m.fm.tags) candidates.set(norm(t), "tag");
    for (const seg of m.fm.topic_path.slice(1)) {
      const k = norm(seg);
      if (!candidates.has(k)) candidates.set(k, "topic");
    }
    for (const [key, kind] of candidates) {
      if (key.length < 3) continue;
      if (NOISE_KEYS.has(key) || VERSION_TAG.test(key) || scopeNames.has(key) || covered.has(key)) continue;
      let entry = clusters.get(key);
      if (!entry) {
        entry = { kind, ids: new Set() };
        clusters.set(key, entry);
      }
      entry.ids.add(m.fm.id);
    }
  }

  return [...clusters.entries()]
    .filter(([, v]) => v.ids.size >= minCluster)
    .sort((a, b) => b[1].ids.size - a[1].ids.size)
    .slice(0, 2)
    .map(([key, v]) => ({
      key,
      kind: v.kind,
      count: v.ids.size,
      examples: [...v.ids].slice(0, 3),
    }));
}
