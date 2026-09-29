/**
 * /hook/recall — the evidence decision (#264) and its gate (split out of
 * http-hook-routes.ts, #680). Logs the decision on every recall; filters the
 * hits only when the gate is enabled.
 */
import { decideHits, tokenizeWithIdentifiers, type RecallDecisionHit, type RecallHit, type Vault } from "@bastra-recall/core";
import { fireAndForget, type Telemetry } from "./telemetry.js";
import { dimensionHints } from "./telemetry-dimensions.js";

export interface EvidenceGateInput {
  hits: RecallHit[];
  query: string;
  scope: string | undefined;
  vault: Vault;
  decideFn: typeof decideHits | undefined;
  telemetry: Telemetry;
  recallId: string;
  gateEnabled: boolean;
  degradedReason: string | undefined;
  hookSessionId: string | null;
  body: Record<string, unknown>;
}

/** Returns the hits the gate lets through — all of them unless it is enabled. */
export function applyEvidenceGate(input: EvidenceGateInput): RecallHit[] {
  const { query, scope, vault, decideFn, telemetry, recallId, gateEnabled, degradedReason, hookSessionId, body } = input;
  let hits = input.hits;
  // #264: Der Evidenzentscheid. Hier und nicht später, weil die Treffer an
  // dieser Stelle noch ihre Hop-Herkunft tragen — die Projektion unten
  // wirft sie weg, und C-046 verlangt sie am Entscheidungspunkt.
  //
  // Die Merkmale werden gegen die URSPRÜNGLICHE Anfrage erhoben, nicht
  // gegen die brückenerweiterte: Beurteilt wird, was der Nutzer gefragt
  // hat, nicht was die Suche daraus gemacht hat.
  let decisions: RecallDecisionHit[] | null = null;
  try {
    decisions = (decideFn ?? decideHits)(hits, {
      queryTerms: tokenizeWithIdentifiers(query),
      scope: scope ?? null,
      memoryOf: (id) => vault.get(id),
    });
    const counts = { required: 0, optional: 0, no_answer: 0 };
    for (const d of decisions) counts[d.decision]++;
    const hopOf = new Map(hits.map((h) => [h.id, h.hop]));
    fireAndForget(
      telemetry.logEvidenceDecision({
        recall_id: recallId,
        // Solange das Flag aus ist, ist die Entscheidung reine Beobachtung.
        shadow: !gateEnabled,
        // C-047/C-052: Ein Budget-Abbruch ist keine Abstention. Wer die
        // Quote rechnet, muss diese Läufe ausschließen können.
        degraded: degradedReason !== undefined,
        decisions: decisions.map((d) => ({
          memory_id: d.id,
          decision: d.decision,
          ...(d.abstain_reason ? { abstain_reason: d.abstain_reason } : {}),
          evidence: d.evidence,
          ...(hopOf.get(d.id) ? { hop: hopOf.get(d.id) } : {}),
        })),
        counts,
        ...(hookSessionId ? { session_id: hookSessionId } : {}),
        ...dimensionHints(body),
      }),
    );
  } catch (err) {
    // Ein Defekt im Entscheid geht in KEINE der beiden Statistiken
    // (C-047/C-052) — leere Entscheidungen, Zähler auf null. Sichtbar
    // bleibt er trotzdem, sonst wäre er von einem Aufruf ohne Treffer nicht
    // zu unterscheiden. `decisions` bleibt null, und damit filtert der Gate
    // unten nichts: fail-open, wie überall auf dem Hook-Pfad.
    decisions = null;
    console.error(`[bastra.evidence] decision failed: ${(err as Error).message}`);
    fireAndForget(
      telemetry.logEvidenceDecision({
        recall_id: recallId,
        shadow: !gateEnabled,
        degraded: degradedReason !== undefined,
        failed: true,
        decisions: [],
        counts: { required: 0, optional: 0, no_answer: 0 },
        ...(hookSessionId ? { session_id: hookSessionId } : {}),
        ...dimensionHints(body),
      }),
    );
  }

  // Scharf geschaltet heißt: `no_answer` wird respektiert — die vorhandene
  // Evidenz reichte für keine Ausspielung (§10.3), also wird nichts
  // ausgespielt. Ausgeschaltet ändert diese Zeile nichts, und das ist der
  // Auslieferungszustand (§21.1: erst shadow, dann aktiv).
  if (gateEnabled && decisions) {
    const suppressed = new Set(
      decisions.filter((d) => d.decision === "no_answer").map((d) => d.id),
    );
    if (suppressed.size > 0) hits = hits.filter((h) => !suppressed.has(h.id));
  }
  return hits;
}
