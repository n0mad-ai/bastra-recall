/**
 * Die Evidenz-Sichten des Reports — Aggregat, Bänder, Abweichungen (#264, §18.2).
 *
 * Herausgelöst aus `stats.ts` (Datei-Größen-Konvention): Die Datei war über
 * 800 Zeilen, und das ist bei jeder Änderung eine Lesekosten-Hypothek. Reiner
 * Umzug — die beiden Funktionen sind unverändert, kein Wert, keine Zeile und
 * keine Bedingung wurde angefasst.
 *
 * WAS SICH ÄNDERN MUSSTE, und warum es keine Verhaltensänderung ist: Die
 * Funktionen lasen `pct`, `MUST_LOAD_SCORE` und `SCORE_FLOOR` als
 * Modulbindungen aus `stats.ts`. Sie kommen jetzt als `deps` herein und
 * werden unter DENSELBEN Namen destrukturiert — dadurch bleibt jede Zeile des
 * Rumpfs wörtlich dieselbe. Die Alternative wäre gewesen, die beiden
 * Env-Konstanten hier ein zweites Mal zu lesen; zwei Quellen für dieselbe
 * Schwelle sind genau die Sorte Drift, die eine Auswertung still falsch macht.
 *
 * Gedruckt wird hier, gerechnet in `stats-governor.ts`.
 */
import {
  noAnswerDivergence,
  shadowAcceptance,
  ACCEPT_MIN_DECISIONS,
  ACCEPT_MIN_DAYS,
  ACCEPT_MIN_SESSIONS,
  ACCEPT_MAX_SESSION_SHARE,
  type AnyEventLike,
} from "./stats-governor.js";

/** Ein geladenes Log-Ereignis, wie `stats.ts` es reicht. */
type AnyEvent = AnyEventLike;

/** Was die Sichten aus `stats.ts` mitbekommen: die Formatierung und die beiden
 *  Schwellen, die dort einmal aus der Umgebung aufgelöst werden. */
export interface EvidenceDeps {
  pct: (n: number, total: number) => string;
  MUST_LOAD_SCORE: number;
  SCORE_FLOOR: number;
}

/**
 * Der Evidenzentscheid (#264, §10.3, §18.2).
 *
 * Drei Fragen, und die erste entscheidet über die Freigabe: Ist die
 * Shadow-Acceptance erreicht? §18.2 verlangt ≥14 Kalendertage ODER ≥500
 * geloggte Hook-Entscheidungen — plus die Erklärung jeder Abweichung, für die
 * unten die Grundlage steht.
 *
 * Was NICHT mitgezählt wird, und warum: Läufe mit `degraded` (Deadline,
 * ausgefallener Arm) lagen weniger Evidenz vor, WEIL abgebrochen wurde — sie
 * als Abstention zu zählen hieße, den Abbruch als Urteil zu lesen
 * (C-047/C-052). Ereignisse mit `failed` sind Defekte im Entscheid und gehören
 * in keine der beiden Statistiken. Beide werden getrennt ausgewiesen statt
 * still verschluckt: Eine Zahl, die man nicht sieht, kann man nicht einordnen.
 */
export function summarizeEvidenceGate(events: AnyEvent[], deps: EvidenceDeps): void {
  // Nur `pct` wird hier gebraucht; die beiden Schwellen reicht diese Sicht an
  // die Abweichungssicht unten durch.
  const { pct } = deps;
  const all = events.filter((e) => e.kind === "evidence_decision");
  if (all.length === 0) return;

  const failed = all.filter((e) => e.failed === true);
  const degraded = all.filter((e) => e.failed !== true && e.degraded === true);
  const usable = all.filter((e) => e.failed !== true && e.degraded !== true);
  const shadow = usable.filter((e) => e.shadow === true);
  const live = usable.filter((e) => e.shadow !== true);

  type Decision = { memory_id: string; decision: string; abstain_reason?: string; hop?: string; evidence?: Record<string, unknown> };
  const decisionsOf = (e: AnyEvent): Decision[] =>
    Array.isArray(e.decisions) ? (e.decisions as Decision[]) : [];

  const shadowDecisions = shadow.flatMap(decisionsOf);
  const days = new Set(shadow.map((e) => String(e.ts).slice(0, 10)));

  console.log(`\n## Evidence gate  (#264 — deterministic decision, §10.3)`);
  console.log(`  shadow: ${shadow.length} call(s), ${shadowDecisions.length} decision(s) over ${days.size} calendar day(s)`);
  if (live.length > 0) {
    console.log(`  live:   ${live.length} call(s), ${live.flatMap(decisionsOf).length} decision(s)  — the gate is ACTIVE`);
  }
  // §18.2 plus C-085: Die Entscheidungs-Route trägt seit dem 29.08.2026 zwei
  // Streuungsbedingungen — 500 Entscheidungen aus einer einzigen Sitzung sind
  // 500 Beobachtungen desselben Arbeitstages, nicht 500 unabhängige Belege.
  // Die Tage-Route bleibt unberührt.
  const acc = shadowAcceptance(shadow, decisionsOf);
  console.log(
    `  spread: ${acc.sessions} session(s), largest holds ${(acc.topSessionShare * 100).toFixed(1)} % of the decisions` +
      `  (C-085: ${ACCEPT_MIN_SESSIONS}+ sessions, at most ${ACCEPT_MAX_SESSION_SHARE * 100} % each)`,
  );
  console.log(
    acc.route
      ? `  shadow acceptance: REACHED via ${acc.route} (${acc.decisions}/${ACCEPT_MIN_DECISIONS} decisions, ${acc.days}/${ACCEPT_MIN_DAYS} days) — the divergence review below is the remaining condition`
      : `  shadow acceptance: not yet — the decision route still needs: ${acc.missing.join(", ")}` +
          `; or ${acc.days}/${ACCEPT_MIN_DAYS} days, which carries no spread condition`,
  );
  if (degraded.length > 0 || failed.length > 0) {
    console.log(
      `  excluded: ${degraded.length} degraded run(s) — a budget abort is not an abstention (C-047); ` +
        `${failed.length} failed decision(s) — a controller defect enters neither statistic (C-052)`,
    );
  }

  const byDecision = new Map<string, number>();
  for (const d of shadowDecisions) byDecision.set(d.decision, (byDecision.get(d.decision) ?? 0) + 1);
  const n = shadowDecisions.length;
  console.log(`  decisions:`);
  for (const kind of ["required", "optional", "no_answer"]) {
    console.log(`    ${kind.padEnd(11)} ${(byDecision.get(kind) ?? 0).toString().padStart(5)}  (${pct(byDecision.get(kind) ?? 0, n)})`);
  }
  const reasons = new Map<string, number>();
  for (const d of shadowDecisions) {
    if (d.abstain_reason) reasons.set(d.abstain_reason, (reasons.get(d.abstain_reason) ?? 0) + 1);
  }
  if (reasons.size > 0) {
    console.log(`  abstain reasons: ` + [...reasons].map(([r, c]) => `${r}=${c}`).join(", "));
  }

  // §18.2/C-046: „der Report zeigt die Hop-Herkunft der required-Hits". Ein
  // `required` über einen Graph-Hop wäre ein Vertragsbruch — die Regel steht im
  // Prädikat, und diese Zeile ist ihre Kontrolle im Betrieb.
  const requiredHits = shadowDecisions.filter((d) => d.decision === "required");
  const byHop = new Map<string, number>();
  for (const d of requiredHits) byHop.set(d.hop ?? "(no hop recorded)", (byHop.get(d.hop ?? "(no hop recorded)") ?? 0) + 1);
  if (requiredHits.length > 0) {
    console.log(`  required by hop origin:`);
    for (const [hop, count] of [...byHop].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${hop.padEnd(18)} ${count.toString().padStart(5)}  (${pct(count, requiredHits.length)})`);
    }
    const viaHop = byHop.get("1-hop") ?? 0;
    if (viaHop > 0) {
      console.log(`    ⚠ ${viaHop} required hit(s) came via a graph hop — C-046 forbids that; check the predicate`);
    }
  }

  summarizeGateDivergence(events, shadow, decisionsOf, deps);
}

/**
 * Was Legacy ausgespielt hätte gegen das, was der Entscheid sagt.
 *
 * §18.2 macht die Erklärung jeder `required`/`no_answer`-Abweichung zur
 * Freigabebedingung. Diese Sicht liefert die Menge, die zu erklären ist — sie
 * erklärt nichts selbst.
 *
 * Nur FUSIONIERTE Läufe: Auf dem BM25-Fallback ist der Score unbegrenzt und die
 * Cuts 30/100 beschreiben dort nichts (§9.4), Legacy bandet deshalb gar nicht.
 * Diese Läufe als Abweichung zu zählen hieße, gegen ein Band zu vergleichen,
 * das es nicht gab. Der Score-Raum kommt aus dem `hook_recall`-Event desselben
 * Aufrufs, über `recall_id` verbunden.
 */
export function summarizeGateDivergence(
  events: AnyEvent[],
  shadow: AnyEvent[],
  // `abstain_reason` gehört seit der no_answer-Sicht unten dazu: Ohne den Grund
  // sind zwei Abweichungen mit gleichen Merkmalen nicht unterscheidbar.
  decisionsOf: (
    e: AnyEvent,
  ) => Array<{
    memory_id: string;
    decision: string;
    abstain_reason?: string;
    evidence?: Record<string, unknown>;
  }>,
  deps: EvidenceDeps,
): void {
  const { pct, MUST_LOAD_SCORE, SCORE_FLOOR } = deps;
  const fused = new Map<string, boolean>();
  for (const r of events.filter((e) => e.kind === "hook_recall")) {
    fused.set(String(r.recall_id), r.score_kind === "rrf");
  }

  let agree = 0;
  let legacyRequiredGateNot = 0;
  let gateRequiredLegacyNot = 0;
  let unknownSpace = 0;

  for (const e of shadow) {
    const space = fused.get(String(e.recall_id));
    if (space === undefined) {
      // Kein zugehöriger Recall im Fenster — der Raum ist unbekannt, und ein
      // Vergleich gegen ein geratenes Band wäre schlechter als keiner.
      unknownSpace += decisionsOf(e).length;
      continue;
    }
    if (!space) continue; // unfusioniert: Legacy bandet nicht, siehe Docstring.
    for (const d of decisionsOf(e)) {
      const score = typeof d.evidence?.lexical_score === "number" ? (d.evidence.lexical_score as number) : null;
      if (score === null) continue;
      const legacyRequired = score >= MUST_LOAD_SCORE;
      const gateRequired = d.decision === "required";
      if (legacyRequired === gateRequired) agree++;
      else if (legacyRequired) legacyRequiredGateNot++;
      else gateRequiredLegacyNot++;
    }
  }

  const total = agree + legacyRequiredGateNot + gateRequiredLegacyNot;
  if (total === 0 && unknownSpace === 0) return;
  console.log(`  divergence vs legacy  (fused runs only — the cuts describe nothing on raw BM25):`);
  console.log(`    agree                       ${agree.toString().padStart(5)}  (${pct(agree, total)})`);
  console.log(`    legacy required, gate not   ${legacyRequiredGateNot.toString().padStart(5)}  (${pct(legacyRequiredGateNot, total)})  — the gate withholds`);
  console.log(`    gate required, legacy not   ${gateRequiredLegacyNot.toString().padStart(5)}  (${pct(gateRequiredLegacyNot, total)})  — the gate promotes`);
  console.log(`    every one of the ${legacyRequiredGateNot + gateRequiredLegacyNot} divergence(s) needs an explanation before activation (§18.2)`);
  if (unknownSpace > 0) {
    console.log(`    (${unknownSpace} decision(s) skipped: no hook_recall in this window, so the score space is unknown)`);
  }

  // §18.2 verlangt JEDE beobachtete `required`/`no_answer`-Abweichung. Die
  // Zeilen oben vergleichen `required` gegen `required` — die größte Klasse,
  // „der Entscheid schweigt, wo Legacy im optional-Band ausgespielt hätte",
  // kam darin gar nicht vor. Gruppiert nach Merkmalssignatur, weil hunderte
  // Ereignisse mit derselben Signatur EIN Befund sind und nicht hunderte.
  const na = noAnswerDivergence(events, shadow, decisionsOf, MUST_LOAD_SCORE, SCORE_FLOOR);
  const richtungen: Array<[string, typeof na.gateSilentLegacyServed]> = [
    ["gate silent, legacy would have served", na.gateSilentLegacyServed],
    ["gate serves, legacy would have stayed silent", na.gateServedLegacySilent],
  ];
  for (const [label, groups] of richtungen) {
    if (groups.length === 0) continue;
    const events_ = groups.reduce((s, g) => s + g.events, 0);
    const memories = groups.reduce((s, g) => s + g.memories, 0);
    console.log(
      `  no_answer divergence — ${label}:  ${events_} decision(s) across ${memories} memory/-ies, ${groups.length} signature(s)`,
    );
    for (const g of groups) {
      const s = g.signature;
      console.log(
        `    ${String(g.events).padStart(5)} dec / ${String(g.memories).padStart(3)} mem  legacy=${s.legacyBand.padEnd(11)} gate=${s.decision.padEnd(9)} reason=${s.abstainReason.padEnd(11)}`,
      );
      console.log(
        `                              identifier=${String(s.exactIdentifier).padEnd(5)} coverage=${String(s.coverage).padEnd(4)} arms=${String(s.armAgreement).padEnd(5)} scope=${String(s.scopeMatch).padEnd(5)} temporal=${s.temporalStatus}`,
      );
    }
  }
}

