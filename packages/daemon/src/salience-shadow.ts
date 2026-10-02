/**
 * #217 Phase 1 — Salience-Ranking im SHADOW-Modus (Disziplin wie #160):
 * berechnet, wie ein begrenzter Salience-Multiplikator (1 + salience × CAP)
 * die Hit-Reihenfolge verändert HÄTTE, ohne die servierten Hits anzufassen.
 * Das Ergebnis hängt als optionales `salience_shadow`-Feld an den
 * recall/hook_recall-Telemetrie-Events und wird offline gegen
 * recall_episodes ausgewertet (packages/eval/src/salience-lift.ts).
 *
 * Modi via BASTRA_SALIENCE_RANK: `shadow` (default) | `off` | `live`.
 * Im Live-Modus multipliziert core (applyStaleness) den Faktor in den
 * echten Score — der Shadow skippt dann (er würde nur Identität loggen).
 */
import { salienceRankCap } from "@bastra-recall/core";
import { envFirst, isOffValue } from "./env.js";

export type SalienceRankMode = "off" | "shadow" | "live";

export interface SalienceShadowHit {
  id: string;
  salience: number | null;
  rank: number;
  shadow_rank: number;
}

export interface SalienceShadow {
  cap: number;
  order_changed: boolean;
  hits: SalienceShadowHit[];
}

export function salienceRankMode(): SalienceRankMode {
  const raw = (envFirst("BASTRA_SALIENCE_RANK") ?? "shadow").toLowerCase();
  return isOffValue(raw) ? "off" : raw === "live" ? raw : "shadow";
}

const clamp01 = (n: number): number => Math.min(Math.max(n, 0), 1);

/**
 * Liefert die would-be-Reihenfolge unter dem Salience-Multiplikator, oder
 * `undefined` wenn nichts zu loggen ist (kein Shadow-Modus, keine Hits,
 * oder kein Hit trägt salience > 0). Ties behalten die Live-Reihenfolge
 * (stabiler Sort).
 */
export function computeSalienceShadow(
  hits: { id: string; score: number }[],
  resolveFm: (id: string) => Record<string, unknown> | undefined,
  cap: number = salienceRankCap(),
): SalienceShadow | undefined {
  if (salienceRankMode() !== "shadow") return undefined;
  if (hits.length === 0 || cap <= 0) return undefined;

  const scored = hits.map((h, i) => {
    const raw = resolveFm(h.id)?.salience;
    const salience = typeof raw === "number" ? clamp01(raw) : null;
    return {
      id: h.id,
      salience,
      rank: i + 1,
      shadow_score: h.score * (1 + (salience ?? 0) * cap),
    };
  });
  if (!scored.some((h) => h.salience != null && h.salience > 0)) return undefined;

  const shadowRank = new Map(
    [...scored]
      .sort((a, b) => b.shadow_score - a.shadow_score)
      .map((h, i) => [h.id, i + 1] as const),
  );
  const out: SalienceShadowHit[] = scored.map((h) => ({
    id: h.id,
    salience: h.salience,
    rank: h.rank,
    shadow_rank: shadowRank.get(h.id) ?? h.rank,
  }));
  return {
    cap,
    order_changed: out.some((h) => h.rank !== h.shadow_rank),
    hits: out,
  };
}
