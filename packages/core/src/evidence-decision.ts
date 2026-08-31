/**
 * Der deterministische Evidenzentscheid (#264, §10.1–§10.3).
 *
 * DAS PROBLEM. Heute entscheidet eine Zahl, ob ein Treffer als verbindlich
 * gilt: `score >= 100`. Auf dem Hybridpfad ist dieser Score eine skalierte
 * Rang-Summe mit Obergrenze 163,93 — eine Unsinnsanfrage reißt die 100 also
 * mühelos, weil eine Liste immer ein erstes Element hat. Auf dem BM25-Pfad ist
 * derselbe Score unbegrenzt und sechsstellig. Die alten Schwellen 30/100 werden
 * nach §10.3 ausdrücklich NICHT auf die neue Semantik übertragen.
 *
 * WAS HIER ENTSCHIEDEN WIRD, ist deshalb kein Schwellenwert, sondern ein
 * erklärbarer Regelentscheid über BENANNTE Evidenz (§10.4 Stufe 1). Jede
 * Entscheidung trägt die Merkmale mit, aus denen sie folgt — wer sie später
 * kalibrieren will, hat die Eingaben.
 *
 * WAS HIER NICHT ENTSTEHT.
 *
 * - `relevance_probability`. §10.1 verbietet sie, bis eine unabhängige
 *   Kalibrierung vorliegt; eine Zahl zwischen 0 und 1 aus dieser Regelmenge
 *   wäre eine vorgetäuschte Wahrscheinlichkeit.
 * - `source_confidence`. §10.2 und C-049: Das heutige `confidence`-Feld trägt
 *   den Default 1,0 und keinerlei Herkunfts- oder Qualitätsinformation. Es hier
 *   einzuspeisen hieße, einen Defaultwert als Beleg auszugeben. Das Feld bleibt
 *   ABWESEND, bis der Schemaentscheid aus §21.4 eine belegte Quellen-Confidence
 *   liefert — abwesend, nicht 0 und nicht 1.
 * - Das `no_answer` des Deep-Recall-Ergebnisvertrags (§8.5). Es heißt dort „die
 *   Suche wurde deterministisch erschöpft" und trägt eine ganz andere
 *   Beweislast als das hiesige „die vorhandene Evidenz reicht für keine
 *   Ausspielung". Die beiden Werte werden nie ineinander übersetzt und nie
 *   gegeneinander verrechnet (C-052/C-056/C-061). Dieses Modul kennt den
 *   anderen Vertrag nicht einmal.
 */
import type { Memory } from "./schema.js";
import type { RecallHit } from "./search.js";

/** §10.3: die Produktsemantik von V1.0. */
export type RecallDecision =
  /** Harter Anker oder mehrere voneinander unabhängige, deterministisch
   *  belegte Signale. */
  | "required"
  /** Plausible Relevanz, aber keine sichere Pflicht. */
  | "optional"
  /** Die vorhandene Evidenz reicht für keine Ausspielung. NICHT das `no_answer`
   *  aus §8.5. */
  | "no_answer";

/**
 * Warum es nicht für mehr gereicht hat. Ein kurzer, kontrollierter Code — kein
 * durchgereichter Text, damit die Auswertung zählen kann statt zu lesen.
 */
export type AbstainReason =
  /** Kein einziges Signal — der Treffer steht allein auf seinem Listenplatz. */
  | "no_evidence"
  /** Signale vorhanden, aber keines davon trägt eine Pflicht. */
  | "weak_evidence"
  /** Nur über einen Graph-Hop erreicht (C-046). */
  | "hop_only"
  /** Das Ziel ist abgelaufen oder als überholt markiert. */
  | "stale";

/**
 * Die Evidenzmerkmale aus §10.1 — genau die, die §10.2 für V1.0 als
 * „verfügbar oder deterministisch ableitbar" führt.
 *
 * Optionale Felder sind ABWESEND, wo das Signal nicht erhoben werden konnte
 * (kein Vektorarm, kein Rang). Abwesend heißt „unbekannt" und nie „null" —
 * eine 0 an dieser Stelle wäre eine Aussage, die niemand gemacht hat.
 */
export interface RecallEvidence {
  /** Ein identifier-, pfad- oder symbolförmiger Query-Term steht wörtlich im
   *  autorisierten Text des Memorys. */
  exact_identifier: boolean;
  /** Anteil der Query-Terme, die auf dem HANDgeschriebenen `recall_when`
   *  trafen. 0..1. Abgeleitete Cues zählen hier nicht mit — sie öffnen nach
   *  §10.2 höchstens den Kandidatenpfad und sind nie selbst Beleg. */
  recall_when_coverage: number;
  lexical_rank?: number;
  lexical_score?: number;
  vector_rank?: number;
  vector_similarity?: number;
  /** Beide Arme führten den Treffer — die Rangübereinstimmung aus §10.2. */
  arm_agreement: boolean;
  /** Der Treffer liegt im angefragten Scope. */
  scope_match: boolean;
  /** `valid` | `expired` | `obsolete` | `unknown`. */
  temporal_status: string;
  // source_confidence: bewusst NICHT vorhanden — siehe Modul-Docstring.
}

/** §10.1, ohne `relevance_probability` und ohne `accessibility`. */
export interface RecallDecisionHit {
  id: string;
  decision: RecallDecision;
  abstain_reason?: AbstainReason;
  evidence: RecallEvidence;
}

export interface DecisionInput {
  hit: RecallHit;
  /** Für temporale Gültigkeit und die autorisierten Felder. Fehlt er, bleibt
   *  `temporal_status` `unknown` — geraten wird nichts. */
  memory?: Memory;
  /** Die normalisierten Terme der Anfrage. */
  queryTerms: string[];
  /** Der angefragte Scope, falls die Anfrage einen nannte. */
  scope?: string | null;
}

/** Delimiter, an denen ein Identifier, ein Pfad oder ein Symbol erkennbar ist —
 *  dieselbe Familie, die der Identifier-Tokenizer (#162) doppelt emittiert. */
const IDENTIFIER_SHAPE = /[./_-]/;

/**
 * Ab welcher Trigger-Abdeckung die Teilabdeckung überhaupt ein Signal ist
 * (§10.3, seit 2026-08-29).
 *
 * Vorher genügte ein einziger geteilter Term: `recall_when_coverage > 0`.
 * Zusammen mit der Armübereinstimmung — dem zweiten der drei unabhängigen
 * Signale — reichte damit ein zufälliges Allerweltswort für eine PFLICHT. Auf
 * dem Goldsatz gemessen: Vier von acht Unsinnsanfragen erzeugten so mindestens
 * ein `required`, gegen eine in §18.2 registrierte Obergrenze von 5 %.
 *
 * Der Wert 0,5 ist gemessen, nicht gewählt. Von den geprüften Kandidaten war er
 * der einzige, der über alle Query-Längen gleich wirkt (58–65 % weniger
 * Pflichten in jeder Längenklasse); die Alternative „mindestens zwei getroffene
 * Terme" nahm auf kurzen Anfragen 74 % zurück und auf langen nur 12 % — und
 * lange Stichwortketten sind gerade der Fall, in dem ein einzelner geteilter
 * Term am wenigsten trägt. Recall@3 bewegt sich auf dem Goldsatz in keiner der
 * geprüften Varianten (0,4743), die Falsch-Abstention bleibt null.
 *
 * Belege: `~/.bastra/eval-runs/2026-08-29-f5d803104893` (Varianten-Tabelle).
 */
export const MIN_TRIGGER_COVERAGE = 0.5;

/**
 * Trägt ein Query-Term die Form eines Identifiers UND steht er wörtlich im
 * DEKLARIERTEN Text?
 *
 * Bewusst eng: Ein Wort wie „konfiguration" ist kein Identifier, auch wenn es
 * trifft. Gefragt ist der Fall aus §10.2 — „exakte Identifier-, Pfad-, Symbol-
 * und Entity-Matches" —, und der ist das stärkste deterministische Signal, das
 * V1.0 hat.
 *
 * Der BODY zählt seit §10.3 nicht mehr dazu. Ein Pfad, der irgendwo im
 * Fließtext eines Memorys vorkommt, war bis dahin ein harter Anker und trug
 * damit allein eine Pflicht — obwohl niemand ihn als Auslöser deklariert hat.
 * Gemessen auf dem Goldsatz (2026-08-29): 361 Pflichten ruhten auf einer
 * solchen Prosa-Fundstelle, 49 davon ausschließlich. Ein harter Anker soll eine
 * ERKLÄRUNG des Autors sein, kein Zufallsfund im Volltext — deshalb bleiben
 * Titel, `recall_when` und Frontmatter, und der Body geht.
 */
function hasExactIdentifier(input: DecisionInput): boolean {
  const candidates = input.queryTerms.filter((t) => t.length >= 3 && IDENTIFIER_SHAPE.test(t));
  if (candidates.length === 0) return false;
  const m = input.memory;
  const haystack = [
    input.hit.title,
    ...(m ? [m.fm.title, ...(m.fm.recall_when ?? [])] : []),
  ]
    .join(" \n ")
    .toLowerCase();
  return candidates.some((t) => haystack.includes(t.toLowerCase()));
}

/**
 * Wieviel der Anfrage der handgeschriebene Trigger abdeckt.
 *
 * Nur `recall_when` — nicht Titel, nicht Body, nicht `recall_when_expanded`
 * (maschinell) und nicht die abgeleiteten Cues. §10.2 hält die Vertrauensklassen
 * auseinander, und diese Zahl ist die Kennzahl der autorisierten.
 */
function recallWhenCoverage(input: DecisionInput): number {
  const terms = input.queryTerms.filter((t) => t.length >= 3);
  if (terms.length === 0) return 0;
  const triggers = (input.memory?.fm.recall_when ?? []).join(" \n ").toLowerCase();
  if (triggers.length === 0) {
    // Ohne geladenes Memory bleibt nur das Signal, das der Hit selbst trägt:
    // `matched_recall_when` sagt, DASS ein Term traf, nicht wie viele.
    return input.hit.matched_recall_when === true ? 1 / terms.length : 0;
  }
  const hits = terms.filter((t) => triggers.includes(t.toLowerCase())).length;
  return Number((hits / terms.length).toFixed(4));
}

function temporalStatus(m: Memory | undefined): string {
  if (!m) return "unknown";
  if (m.fm.obsolete === true) return "obsolete";
  const until = (m.fm as { valid_until?: string }).valid_until;
  if (typeof until === "string" && until.length > 0) {
    const t = Date.parse(until);
    if (Number.isFinite(t) && t < Date.now()) return "expired";
  }
  return "valid";
}

/** Die Merkmale erheben — ohne zu entscheiden. Getrennt, damit die Merkmale
 *  auch dort verfügbar sind, wo nur geloggt und nicht gegatet wird. */
export function collectEvidence(input: DecisionInput): RecallEvidence {
  const rrf = input.hit.rrf;
  const scope = input.scope;
  return {
    exact_identifier: hasExactIdentifier(input),
    recall_when_coverage: recallWhenCoverage(input),
    ...(rrf?.rank_bm25 != null ? { lexical_rank: rrf.rank_bm25 } : {}),
    // Der Score ist die einzige lexikalische Zahl, die es heute gibt; er ist
    // Diagnosewert (§10.1) und wird deshalb mitgeführt, nicht bewertet.
    lexical_score: input.hit.score,
    ...(rrf?.rank_vector != null ? { vector_rank: rrf.rank_vector } : {}),
    // vector_similarity: abwesend — der Hybridpfad führt Ränge, keine
    // Cosinus-Werte. Eine aus dem Rang zurückgerechnete Ähnlichkeit wäre
    // erfunden.
    arm_agreement: rrf?.rank_bm25 != null && rrf?.rank_vector != null,
    scope_match: scope == null ? false : input.hit.scope === scope,
    temporal_status: temporalStatus(input.memory),
  };
}

/**
 * Der Entscheid.
 *
 * `required` verlangt nach §10.3 einen HARTEN Anker oder mehrere voneinander
 * UNABHÄNGIGE, deterministisch belegte Signale:
 *
 * - harter Anker: ein exakter Identifier-Treffer, oder ein handgeschriebener
 *   Trigger, den die Anfrage vollständig abdeckt;
 * - mehrere unabhängige Signale: mindestens zwei aus {Teilabdeckung des
 *   Triggers, Übereinstimmung beider Arme, Scope-Treffer}. „Unabhängig" ist
 *   hier wörtlich gemeint: Die drei stammen aus verschiedenen Quellen — dem
 *   autorisierten Trigger, den beiden Retrieval-Armen und der Ablage. Zwei
 *   Ausprägungen DESSELBEN Signals zählen nicht doppelt.
 *
 * Zwei Sperren stehen VOR dieser Prüfung, weil sie unabhängig von jeder
 * Signalstärke gelten:
 *
 * - Ein abgelaufenes oder überholtes Ziel wird nie `required` (§10.2, temporale
 *   Gültigkeit).
 * - Ein nur über einen Graph-Hop erreichter Treffer wird nie `required`
 *   (C-046). Dass ein `related_via` ihn erreichbar gemacht hat, ist keine
 *   Evidenz über ihn; er muss die Prüfung auf eigener Stärke bestehen. Dieselbe
 *   Regel steht seit 7ad7f1b im Banding (`bandHits`) — hier ist sie noch einmal
 *   ausgeschrieben, weil der Entscheid nicht darauf bauen darf, dass ein
 *   anderer Aufrufer sie vorher angewandt hat.
 *
 * Ein Treffer auf einem ABGELEITETEN Cue kann diese Prüfung nicht bestehen: Er
 * erzeugt weder einen Identifier-Treffer noch Abdeckung auf dem
 * handgeschriebenen Trigger — die beiden einzigen Wege zum harten Anker —, und
 * `recall_when_coverage` zählt Cues ausdrücklich nicht mit (§10.2, C-030).
 */
export function decideHit(input: DecisionInput): RecallDecisionHit {
  const evidence = collectEvidence(input);
  const id = input.hit.id;

  const stale = evidence.temporal_status === "expired" || evidence.temporal_status === "obsolete";
  const hopOnly = input.hit.hop === "1-hop";

  const hardAnchor = evidence.exact_identifier || evidence.recall_when_coverage >= 1;
  const independent = [
    evidence.recall_when_coverage >= MIN_TRIGGER_COVERAGE,
    evidence.arm_agreement,
    evidence.scope_match,
  ].filter(Boolean).length;

  if (!stale && !hopOnly && (hardAnchor || independent >= 2)) {
    return { id, decision: "required", evidence };
  }

  // Ab hier ist es keine Pflicht. Bleibt genug für einen Vorschlag?
  const anySignal = evidence.recall_when_coverage > 0 || evidence.arm_agreement || evidence.scope_match || evidence.exact_identifier;
  if (anySignal) {
    return {
      id,
      decision: "optional",
      evidence,
      ...(stale
        ? { abstain_reason: "stale" as const }
        : hopOnly
          ? { abstain_reason: "hop_only" as const }
          : {}),
    };
  }

  return { id, decision: "no_answer", abstain_reason: stale ? "stale" : "no_evidence", evidence };
}

/**
 * Der Entscheid über eine ganze Trefferliste.
 *
 * Reine Abbildung, ohne die Liste zu verändern: Der Entscheid ist in dieser
 * Stufe ein SCHATTEN (§21.1, §10.4 Stufe 2) und filtert nichts. Wer ihn später
 * scharf schaltet, tut das an der Konsumentenseite und hinter einem Flag.
 */
export function decideHits(
  hits: RecallHit[],
  ctx: { queryTerms: string[]; scope?: string | null; memoryOf?: (id: string) => Memory | undefined },
): RecallDecisionHit[] {
  return hits.map((hit) =>
    decideHit({
      hit,
      memory: ctx.memoryOf?.(hit.id),
      queryTerms: ctx.queryTerms,
      scope: ctx.scope,
    }),
  );
}
