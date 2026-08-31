/**
 * Die beiden Report-Rechnungen aus `scripts/stats-governor.ts` (#354, §18.2).
 *
 * Beide beantworten Gegenfragen, die der Report bisher nicht stellte: Was hätte
 * ein Sitzungsbudget beschnitten, und welche `no_answer`-Abweichungen gibt es
 * eigentlich? Getestet wird die Rechnung, nicht die Formatierung — die Zahlen
 * tragen die Entscheidung, die Zeilen darum nicht.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stats-governor.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  governorWhatIf,
  noAnswerDivergence,
  shadowAcceptance,
  type AnyEventLike,
} from "../scripts/stats-governor.js";

const injektion = (session: string, tokens: number, kind = "hook_call"): AnyEventLike => ({
  kind,
  ts: "2026-08-29T05:00:00.000Z",
  session_id: session,
  hint_tokens_est: tokens,
});

// ─── Governor-Was-wäre-wenn ──────────────────────────────────────

test("#354: eine Sitzung unter Budget wird nicht angefasst", () => {
  const wi = governorWhatIf([injektion("s1", 100), injektion("s1", 200)], [1000]);
  assert.equal(wi.sessionsMultiEmission, 1);
  assert.equal(wi.rows[0].sessionsAffected, 0);
  assert.equal(wi.rows[0].emissionsTrimmed, 0);
  assert.equal(wi.rows[0].tokensTrimmed, 0);
});

test("#354: was nach dem Budget kommt, fällt ganz — gekürzt wird nichts", () => {
  // 400 + 400 passen in 1000, die dritte Injektion (400) nicht mehr. Der
  // Governor kürzt keinen Eintrag; ein halber Beleg ist keiner.
  const wi = governorWhatIf(
    [injektion("s1", 400), injektion("s1", 400), injektion("s1", 400)],
    [1000],
  );
  assert.equal(wi.rows[0].sessionsAffected, 1);
  assert.equal(wi.rows[0].emissionsTrimmed, 1);
  assert.equal(wi.rows[0].tokensTrimmed, 400);
});

test("#354: eine spätere kleine Injektion passt noch, wenn die große fiel", () => {
  // Das ist der Unterschied zwischen „ab hier ist Schluss" und „was nicht
  // hineinpasst, fällt": Nach der zu großen 900 bleibt Platz für die 50.
  const wi = governorWhatIf(
    [injektion("s1", 400), injektion("s1", 900), injektion("s1", 50)],
    [1000],
  );
  assert.equal(wi.rows[0].emissionsTrimmed, 1, "nur die 900 fällt");
  assert.equal(wi.rows[0].tokensTrimmed, 900);
});

test("#354: Sitzungen mit nur einer Injektion zählen nicht als Sitzung", () => {
  // Die Bash-Lane stempelt pro Aufruf eine eigene synthetische id. Sie als
  // Sitzungen zu führen hieße, tausende Einzelaufrufe als Sitzungen auszuweisen.
  const events = [
    injektion("einzeln-1", 5000, "bash_hook_call"),
    injektion("einzeln-2", 5000, "bash_hook_call"),
    injektion("echt", 100),
    injektion("echt", 100),
  ];
  const wi = governorWhatIf(events, [50]);
  assert.equal(wi.sessionsWithInjection, 3);
  assert.equal(wi.sessionsMultiEmission, 1, "nur die Sitzung mit zwei Injektionen");
  assert.equal(wi.rows[0].sessionsAffected, 1, "und nur sie kann ein Budget reißen");
});

test("#354: mehrere Budgetstufen sind monoton — ein größeres Budget schneidet nie mehr", () => {
  const events = [injektion("s1", 300), injektion("s1", 300), injektion("s1", 300)];
  const wi = governorWhatIf(events, [500, 900, 5000]);
  const [eng, mittel, weit] = wi.rows;
  assert.ok(eng.tokensTrimmed >= mittel.tokensTrimmed);
  assert.ok(mittel.tokensTrimmed >= weit.tokensTrimmed);
  assert.equal(weit.tokensTrimmed, 0, "ein Budget über der Summe schneidet nichts");
});

test("#354: Ereignisse ohne Tokenangabe zählen nicht mit", () => {
  // `hint_tokens_est` gibt es erst ab dem #72-Build. Alt-Ereignisse als 0 zu
  // führen wäre richtig; sie als Injektion zu zählen wäre es nicht.
  const ohne: AnyEventLike = { kind: "hook_call", ts: "2026-08-29T05:00:00.000Z", session_id: "s1" };
  const wi = governorWhatIf([ohne, ohne, injektion("s1", 100)], [50]);
  assert.equal(wi.sessionsMultiEmission, 0, "eine einzige zählbare Injektion ist keine Sitzung");
});

// ─── no_answer-Divergenzen ───────────────────────────────────────

const recall = (id: string, fused = true): AnyEventLike => ({
  kind: "hook_recall",
  ts: "2026-08-29T05:00:00.000Z",
  recall_id: id,
  score_kind: fused ? "rrf" : "bm25",
});

const entscheid = (
  recallId: string,
  decisions: Array<Record<string, unknown>>,
): AnyEventLike => ({
  kind: "evidence_decision",
  ts: "2026-08-29T05:00:00.000Z",
  recall_id: recallId,
  shadow: true,
  decisions,
});

const decisionsOf = (e: AnyEventLike): Array<{
  memory_id: string;
  decision: string;
  abstain_reason?: string;
  evidence?: Record<string, unknown>;
}> => (Array.isArray(e.decisions) ? (e.decisions as never) : []);

const merkmale = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  exact_identifier: false,
  recall_when_coverage: 0,
  arm_agreement: false,
  scope_match: false,
  temporal_status: "valid",
  ...over,
});

test("§18.2: der Entscheid schweigt, wo Legacy im optional-Band ausgespielt hätte", () => {
  // Die größte Klasse im echten Strom — und die, die in der required-gegen-
  // required-Sicht gar nicht vorkam.
  const shadow = [
    entscheid("r1", [
      { memory_id: "m1", decision: "no_answer", abstain_reason: "no_evidence", evidence: merkmale({ lexical_score: 60 }) },
    ]),
  ];
  const d = noAnswerDivergence([recall("r1")], shadow, decisionsOf, 100, 30);
  assert.equal(d.gateSilentLegacyServed.length, 1);
  assert.equal(d.gateSilentLegacyServed[0].events, 1);
  assert.equal(d.gateSilentLegacyServed[0].memories, 1);
  assert.equal(d.gateSilentLegacyServed[0].signature.legacyBand, "optional");
  assert.equal(d.gateSilentLegacyServed[0].signature.abstainReason, "no_evidence");
});

test("§18.2: die Gegenrichtung wird getrennt geführt", () => {
  const shadow = [
    entscheid("r1", [
      { memory_id: "m1", decision: "optional", abstain_reason: "hop_only", evidence: merkmale({ lexical_score: 10 }) },
    ]),
  ];
  const d = noAnswerDivergence([recall("r1")], shadow, decisionsOf, 100, 30);
  assert.equal(d.gateSilentLegacyServed.length, 0);
  assert.equal(d.gateServedLegacySilent.length, 1);
  assert.equal(d.gateServedLegacySilent[0].signature.legacyBand, "below_floor");
});

test("§18.2: gleiche Signatur über viele Memories ist EIN Befund, und die Breite steht daneben", () => {
  // Der Grund für die Gruppierung: 468 Ereignisse über 37 Memories sind ein
  // Muster, das man einmal erklärt — keine 468 Einzelfälle.
  const shadow = [
    entscheid("r1", [
      { memory_id: "m1", decision: "no_answer", abstain_reason: "no_evidence", evidence: merkmale({ lexical_score: 60 }) },
      { memory_id: "m2", decision: "no_answer", abstain_reason: "no_evidence", evidence: merkmale({ lexical_score: 70 }) },
    ]),
    entscheid("r2", [
      { memory_id: "m1", decision: "no_answer", abstain_reason: "no_evidence", evidence: merkmale({ lexical_score: 55 }) },
    ]),
  ];
  const d = noAnswerDivergence([recall("r1"), recall("r2")], shadow, decisionsOf, 100, 30);
  assert.equal(d.gateSilentLegacyServed.length, 1, "eine Signatur");
  assert.equal(d.gateSilentLegacyServed[0].events, 3, "drei Entscheidungen");
  assert.equal(d.gateSilentLegacyServed[0].memories, 2, "über zwei verschiedene Memories");
});

test("§18.2: unterschiedliche Merkmale sind unterschiedliche Signaturen", () => {
  const shadow = [
    entscheid("r1", [
      { memory_id: "m1", decision: "no_answer", abstain_reason: "no_evidence", evidence: merkmale({ lexical_score: 60 }) },
      { memory_id: "m2", decision: "no_answer", abstain_reason: "stale", evidence: merkmale({ lexical_score: 60, temporal_status: "expired" }) },
    ]),
  ];
  const d = noAnswerDivergence([recall("r1")], shadow, decisionsOf, 100, 30);
  assert.equal(d.gateSilentLegacyServed.length, 2);
});

test("§18.2: Einigkeit ist keine Abweichung", () => {
  const shadow = [
    entscheid("r1", [
      // Beide schweigen.
      { memory_id: "m1", decision: "no_answer", abstain_reason: "no_evidence", evidence: merkmale({ lexical_score: 10 }) },
      // Beide spielen aus.
      { memory_id: "m2", decision: "required", evidence: merkmale({ lexical_score: 150 }) },
    ]),
  ];
  const d = noAnswerDivergence([recall("r1")], shadow, decisionsOf, 100, 30);
  assert.equal(d.gateSilentLegacyServed.length, 0);
  assert.equal(d.gateServedLegacySilent.length, 0);
});

test("§18.2: unfusionierte Läufe zählen nicht — dort bandet Legacy nicht", () => {
  const shadow = [
    entscheid("r1", [
      { memory_id: "m1", decision: "no_answer", abstain_reason: "no_evidence", evidence: merkmale({ lexical_score: 9999 }) },
    ]),
  ];
  const d = noAnswerDivergence([recall("r1", false)], shadow, decisionsOf, 100, 30);
  assert.equal(d.gateSilentLegacyServed.length, 0, "auf rohem BM25 beschreiben die Cuts nichts");
});

test("§18.2: ein Entscheid ohne zugehörigen Recall wird als unbekannter Raum gezählt", () => {
  const shadow = [
    entscheid("verwaist", [
      { memory_id: "m1", decision: "no_answer", abstain_reason: "no_evidence", evidence: merkmale({ lexical_score: 60 }) },
    ]),
  ];
  const d = noAnswerDivergence([], shadow, decisionsOf, 100, 30);
  assert.equal(d.unknownSpace, 1);
  assert.equal(d.gateSilentLegacyServed.length, 0, "geraten wird nicht");
});

// ─── Shadow-Abnahme mit Streuung (C-085) ─────────────────────────

const entscheidungen = (session: string, tag: string, n: number): AnyEventLike => ({
  kind: "evidence_decision",
  ts: `${tag}T05:00:00.000Z`,
  session_id: session,
  shadow: true,
  decisions: Array.from({ length: n }, (_, i) => ({ memory_id: `m${i}` })),
});

const zaehle = (e: AnyEventLike): Array<{ memory_id: string }> =>
  Array.isArray(e.decisions) ? (e.decisions as Array<{ memory_id: string }>) : [];

test("C-085: 500 Entscheidungen aus EINER Sitzung sind keine Abnahme", () => {
  // Der Prüfpunkt aus §35: Ohne die Streuungsbedingungen meldete der Report
  // hier REACHED — 500 Beobachtungen desselben Arbeitstages als 500 Belege.
  const acc = shadowAcceptance([entscheidungen("s1", "2026-08-29", 600)], zaehle);
  assert.equal(acc.decisions, 600);
  assert.equal(acc.sessions, 1);
  assert.equal(acc.route, null, "die Menge allein reicht nicht mehr");
  assert.ok(acc.missing.some((m) => m.includes("sessions")));
  assert.ok(acc.missing.some((m) => m.includes("top session")));
});

test("C-085: genug Menge und genug Streuung erreichen die Entscheidungs-Route", () => {
  // 25 Sitzungen zu je 24 Entscheidungen: 600 gesamt, größter Anteil 4 %.
  const events = Array.from({ length: 25 }, (_, i) => entscheidungen(`s${i}`, "2026-08-29", 24));
  const acc = shadowAcceptance(events, zaehle);
  assert.equal(acc.decisions, 600);
  assert.equal(acc.sessions, 25);
  assert.ok(acc.topSessionShare <= 0.25);
  assert.equal(acc.route, "decisions");
  assert.deepEqual(acc.missing, []);
});

test("C-085: eine dominante Sitzung kippt die Route, auch bei vielen Sitzungen", () => {
  // 24 Sitzungen, aber eine hält mehr als ein Viertel.
  const events = [
    entscheidungen("dominant", "2026-08-29", 300),
    ...Array.from({ length: 23 }, (_, i) => entscheidungen(`s${i}`, "2026-08-29", 20)),
  ];
  const acc = shadowAcceptance(events, zaehle);
  assert.equal(acc.sessions, 24, "die Zahl der Sitzungen allein wäre in Ordnung");
  assert.ok(acc.topSessionShare > 0.25);
  assert.equal(acc.route, null);
  assert.ok(acc.missing.every((m) => !m.includes("sessions ")), "es fehlt nicht an Sitzungen");
});

test("C-085: die Tage-Route bleibt unberührt von der Streuung", () => {
  // 14 Kalendertage, alles aus einer einzigen Sitzung: erreicht trotzdem.
  const events = Array.from({ length: 14 }, (_, i) =>
    entscheidungen("s1", `2026-08-${String(i + 1).padStart(2, "0")}`, 3),
  );
  const acc = shadowAcceptance(events, zaehle);
  assert.equal(acc.days, 14);
  assert.equal(acc.sessions, 1);
  assert.equal(acc.route, "days", "die Dauer misst etwas anderes als die Menge");
});

test("C-085: Entscheidungen ohne Sitzung belegen keine Streuung", () => {
  // Sie zählen als eine gemeinsame Gruppe — so drücken sie den Höchstanteil
  // nach oben, statt ihn zu verstecken.
  const ohne: AnyEventLike = {
    kind: "evidence_decision",
    ts: "2026-08-29T05:00:00.000Z",
    shadow: true,
    decisions: Array.from({ length: 600 }, (_, i) => ({ memory_id: `m${i}` })),
  };
  const acc = shadowAcceptance([ohne], zaehle);
  assert.equal(acc.sessions, 1);
  assert.equal(acc.topSessionShare, 1);
  assert.equal(acc.route, null);
});

test("C-085: ein leeres Fenster meldet keine Abnahme und keine Division durch null", () => {
  const acc = shadowAcceptance([], zaehle);
  assert.equal(acc.decisions, 0);
  assert.equal(acc.topSessionShare, 0);
  assert.equal(acc.route, null);
});
