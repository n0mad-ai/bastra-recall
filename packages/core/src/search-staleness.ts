/**
 * Lifecycle-Reranking (#74) und das Score-Gateway `applyStaleness` (#194,
 * #1039): jeder Multiplikator auf einen Recall-Score — Staleness, Curator-
 * Demotion, Doc-Dämpfung, Salience — läuft hier durch. Die Caches, die es
 * liest (Staleness-Cache, Demotion-Set), gehören `SearchIndex` (search.ts)
 * und kommen als Argument.
 */
import type { Vault } from "./vault.js";
import type { RecallHit, RecallOptions } from "./search-types.js";
import { round } from "./search-pipeline.js";

/** 12h-TTL des Staleness-Caches gegen Tageswechsel (`aging → stale` ohne
 *  Vault-Change) — der Cache selbst lebt in `SearchIndex`. */
const STALENESS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Staleness-Reranking mit Per-Memory-Cache (#29). Cache-Key ist die
 * memId — invalidiert in `handle()` bei change/remove. Zusätzlich
 * 12h-TTL gegen Tageswechsel-Flips (`aging → stale` ohne Vault-Change).
 *
 * Behält die Sortier-Semantik von `applyStalenessMultiplier`: Direct-
 * vs 1-hop-Hits bleiben getrennt sortiert.
 *
 * Doc-Dämpfung: type="doc" (Document-Sidecars + Produkt-Doku) wird im
 * Default-Recall (kein expliziter type-Filter) gedämpft — lange Doc-Bodies
 * sollen Lessons/Decisions nicht verdrängen. `find_document` und jeder
 * Recall mit type:"doc" ranken ungedämpft (das ist die dedizierte Lane).
 */
export function applyStaleness(
  vault: Vault,
  stalenessCache: Map<string, { touchTs: number; status: StaleStatus; computedAt: number }>,
  curatorDemotions: ReadonlySet<string>,
  hits: RecallHit[],
  opts: RecallOptions = {},
  now: Date = new Date(),
): RecallHit[] {
  const nowMs = now.getTime();
  for (const h of hits) {
    const fm = vault.get(h.id)?.fm as Record<string, unknown> | undefined;
    if (!fm) continue;
    const touchTs = computeTouchTs(fm);
    let entry = stalenessCache.get(h.id);
    const ttlExpired =
      entry != null && nowMs - entry.computedAt > STALENESS_CACHE_TTL_MS;
    if (!entry || entry.touchTs !== touchTs || ttlExpired) {
      const status = computeStaleness(fm, now);
      entry = { touchTs, status, computedAt: nowMs };
      stalenessCache.set(h.id, entry);
    }
    let mult = STALE_MULTIPLIERS[entry.status];
    if (curatorDemotions.has(h.id)) mult *= CURATOR_DEMOTION_MULTIPLIER;
    if (!opts.type && h.type === "doc") mult *= DOC_TYPE_DAMPING;
    // #217: Salience boostet nur im Live-Modus (default: shadow-only im
    // Daemon). Prozess-statisch schalten — nie pro Request. Case-insensitiv
    // wie salienceRankMode() im Daemon — sonst schaltet "LIVE" beide Lanes
    // still aus (Review-Finding).
    if ((process.env.BASTRA_SALIENCE_RANK ?? "").toLowerCase() === "live") {
      const sal =
        typeof fm.salience === "number" ? Math.min(Math.max(fm.salience, 0), 1) : 0;
      if (sal > 0) mult *= 1 + sal * salienceRankCap();
    }
    if (mult !== 1.0) h.score = round(h.score * mult);
  }
  const direct = hits.filter((h) => h.hop !== "1-hop");
  const hops = hits.filter((h) => h.hop === "1-hop");
  direct.sort((a, b) => b.score - a.score);
  hops.sort((a, b) => b.score - a.score);
  return [...direct, ...hops];
}

// MARK: - Lifecycle-Reranking (#74)

/**
 * Default-Verfallszeit pro Memory-Type. Identisch zu
 * `Sources/Bastra/MemoryLifecycle.swift:defaultExpirationDays` — bei
 * Änderungen beide Stellen mitziehen.
 * `null` = Type altert nie automatisch (Bookmarks, Documents,
 * Preferences, References).
 */
const DEFAULT_EXPIRATION_DAYS: Record<string, number | null> = {
  lesson: 180,
  decision: 365,
  "project-fact": 90,
  "meta-working": 365,
  workflow: 180,
  preference: null,
  "user-preference": null,
  reference: null,
  bookmark: null,
  doc: null,
};

const AGING_THRESHOLD_FRACTION = 0.75;

/**
 * Score-Multiplier basierend auf der Staleness (#74). Wird nach allen
 * anderen Filtern in `recall`/`recallHybrid` auf den finalen Hit-Score
 * angewandt — stale Memories ranken niedriger, expired noch niedriger.
 */
export type StaleStatus = "fresh" | "aging" | "stale" | "expired";

const STALE_MULTIPLIERS: Record<StaleStatus, number> = {
  fresh: 1.0,
  aging: 0.85,
  stale: 0.5,
  expired: 0.2,
};

/**
 * Curator-Demotion (#155): Score-Faktor für Memories, die der deterministische
 * Staleness-Pass demotet hat (surfaced-but-never-acted-on). Gleiche Liga wie
 * "stale": auffindbar, aber hinter engagierten Memories. Score-only per
 * survival-by-id-Vertrag (#146) — load_memory, Citations und die Datei selbst
 * bleiben unberührt; die Engine trägt nur den Mechanismus (setDemotions),
 * die Curation-Entscheidung lebt im Daemon.
 */
export const CURATOR_DEMOTION_MULTIPLIER = 0.5;

/**
 * Dämpfung für type="doc"-Hits im Default-Recall (kein expliziter type-
 * Filter). Docs altern nie (DEFAULT_EXPIRATION_DAYS: null) UND haben lange
 * Bodies — ohne Dämpfung würden Produkt-Doku und Document-Sidecars Lessons
 * aus den Top-k drängen. 0.5 = gleiche Liga wie "stale": auffindbar, aber
 * hinter frischen Memories. Mit type:"doc" (= find_document) volle Scores.
 */
export const DOC_TYPE_DAMPING = 0.5;

/**
 * #217 Valenz: begrenzter Salience-Multiplikator (1 + salience × CAP).
 * Default ist SHADOW-only — der Daemon loggt die would-be-Reihenfolge
 * (salience-shadow.ts), live wird erst via BASTRA_SALIENCE_RANK=live nach
 * Lift-Nachweis geschaltet (Disziplin wie #160). Env wird pro Aufruf
 * gelesen (testfreundlich), darf aber nie pro Request umgeschaltet werden —
 * der Query-Cache cached das post-staleness-Ranking.
 */
export function salienceRankCap(): number {
  const raw = Number(process.env.BASTRA_SALIENCE_RANK_CAP ?? "0.25");
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.25;
}

export function computeStaleness(
  fm: Record<string, unknown>,
  now: Date = new Date(),
): StaleStatus {
  const updated = parseDateValue(fm.updated);
  const lastReviewed = parseDateValue(fm.last_reviewed_at);
  const touch = Math.max(updated ?? 0, lastReviewed ?? 0);

  const validUntil = parseDateValue(fm.valid_until);
  if (validUntil != null) {
    if (now.getTime() >= validUntil) return "expired";
    // #365/14: unbekanntes `touch` (weder `updated` noch `last_reviewed_at`
    // parsebar) ist 0 = Unix-Epoche. `elapsed/total` misst dann den Abstand
    // zu 1970 statt zur letzten Bearbeitung und landet für jedes Ablaufdatum
    // nahe heute bei ≈0.99 → immer „aging". Der Zweig ohne `valid_until` hat
    // denselben Guard (unten, vor der Ratio) — beide müssen dasselbe sagen.
    if (touch <= 0) return "fresh";
    const total = validUntil - touch;
    const elapsed = now.getTime() - touch;
    if (total > 0 && elapsed / total >= AGING_THRESHOLD_FRACTION) {
      return "aging";
    }
    return "fresh";
  }

  const type = String(fm.type ?? "");
  const userOverride =
    typeof fm.expires_after_days === "number" ? (fm.expires_after_days as number) : null;
  const typeDefault =
    type in DEFAULT_EXPIRATION_DAYS ? DEFAULT_EXPIRATION_DAYS[type] : null;
  let days = userOverride ?? typeDefault;
  if (days == null || days <= 0) return "fresh";

  // #217 Valenz: hohe Salience altert langsamer — emotional aufgeladene
  // Memories verblassen zuletzt. salience 1 = doppelte Lebensdauer.
  // `valid_until` bleibt unberührt (explizites User-Datum gewinnt).
  const salience =
    typeof fm.salience === "number" ? Math.min(Math.max(fm.salience, 0), 1) : 0;
  if (salience > 0) days = days * (1 + salience);

  if (touch <= 0) return "fresh";
  const secondsSinceTouch = (now.getTime() - touch) / 1000;
  const staleSeconds = days * 86400;
  if (secondsSinceTouch <= 0) return "fresh";
  const ratio = secondsSinceTouch / staleSeconds;
  if (ratio >= 1.5) return "expired";
  if (ratio >= 1.0) return "stale";
  if (ratio >= AGING_THRESHOLD_FRACTION) return "aging";
  return "fresh";
}

function parseDateValue(raw: unknown): number | null {
  if (raw == null) return null;
  // YAML kann `2026-05-12` als Date entlocken — wir akzeptieren beides.
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string" && raw.length > 0) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * „Touch-Timestamp" einer Memory: jüngeres aus `updated` und
 * `last_reviewed_at`. Wird vom Staleness-Cache (#29) als Identitäts-
 * Stempel benutzt — ändert sich der touchTs, wird der Cache-Eintrag
 * neu berechnet, auch ohne Vault-Event (z.B. wenn die Mac-App die
 * Frontmatter direkt patcht).
 */
function computeTouchTs(fm: Record<string, unknown>): number {
  const updated = parseDateValue(fm.updated) ?? 0;
  const lastReviewed = parseDateValue(fm.last_reviewed_at) ?? 0;
  return Math.max(updated, lastReviewed);
}

/**
 * Wendet den Staleness-Multiplier auf einen Hit-Score an. Daemon nutzt
 * die `vault.get(id).fm` als Quelle für das Frontmatter — die Computation
 * läuft lazy beim Recall (kein File-Write).
 */
export function applyStalenessMultiplier(
  hits: RecallHit[],
  resolveFrontmatter: (id: string) => Record<string, unknown> | undefined,
  now: Date = new Date(),
): RecallHit[] {
  for (const h of hits) {
    const fm = resolveFrontmatter(h.id);
    if (!fm) continue;
    const status = computeStaleness(fm, now);
    const mult = STALE_MULTIPLIERS[status];
    if (mult !== 1.0) {
      h.score = round(h.score * mult);
    }
  }
  // Re-sort nach möglicher Score-Anpassung. Direct-Hits vor 1-hop-Hits
  // bleiben aber Gruppe — wir sortieren INNERHALB jeder Gruppe.
  const direct = hits.filter((h) => h.hop !== "1-hop");
  const hops = hits.filter((h) => h.hop === "1-hop");
  direct.sort((a, b) => b.score - a.score);
  hops.sort((a, b) => b.score - a.score);
  return [...direct, ...hops];
}
