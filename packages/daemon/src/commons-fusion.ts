/**
 * Bastra Commons als ZUSÄTZLICHER RANG-ARM, nicht als zweiter Zahlenraum.
 *
 * Der Commons-Index ist BM25-only. Seine Scores sind roh und nach oben offen
 * (auf einem echten Vault sechsstellig). Die persönliche Trefferliste kommt
 * dagegen aus der RRF-Fusion und ist durch 163.934 gedeckelt. Beide Listen
 * zusammen zu sortieren hieß: der Commons-Treffer gewinnt immer, weil seine
 * Zahl größer ist — nicht, weil er besser passt. Die Dämpfung mit 0.8 änderte
 * daran nichts; 80 % eines sechsstelligen Werts ist immer noch sechsstellig.
 *
 * Also fusioniert diese Funktion, was zwischen den Listen überhaupt
 * vergleichbar ist: den RANG. Wie das geschieht, hängt daran, ob die
 * persönliche Liste selbst schon eine RRF-Summe ist:
 *
 * **`personalFused: true`** — Commons ist ein DRITTER ARM neben BM25 und
 * Vektor. Der persönliche Score bleibt exakt, wie er war (er IST bereits
 * `RRF_SCALE × Σ 1/(k+rang)` über seine Arme); der Commons-Rang steuert
 * `gewicht/(k+rang)` bei. Die frühere Fassung reduzierte stattdessen die ganze
 * persönliche Liste auf EINEN Listenrang und warf damit weg, was RRF gerade
 * gemessen hatte: Ein Treffer mit Rang 1 in BEIDEN persönlichen Armen (163.934)
 * wurde zu 81.967, obwohl Commons zu ihm nichts gesagt hatte. Mit
 * `min_score = 100` bzw. `MUST_LOAD_SCORE` verschwand dadurch jeder getrennte
 * Treffer aus dem REQUIRED-Band — nur eine in beiden Listen identische id kam
 * noch über 100 (147.541). Die Bänder 30/50/100 behalten hier also genau die
 * Bedeutung, die sie ohne Commons haben.
 *
 * **`personalFused: false`** — der persönliche Arm ist degradiert, seine Zahlen
 * sind rohes BM25 und mit nichts addierbar. Dann bleibt nur die Rang-Kollaps-
 * Fusion: beide Listen werden zu je einem Arm, das Ergebnis liegt in der
 * RRF-Skala. Die Obergrenze ist dort 147.541 (1.8 × 81.967) statt 163.934 —
 * eine gestauchte, aber ehrliche Skala, und strikt konservativer als der
 * vorherige Zustand, in dem dieser Pfad rohe unbegrenzte Werte servierte.
 *
 * Die Evidenz-Dämpfung (`commonsRankFactor`, 0.5–0.95) reitet auf dem
 * Rang-Beitrag mit: Ein Commons-Rezept auf Rang 1 zählt so viel wie ein
 * persönliches Memory auf Rang 1 mal seinem Vertrauensfaktor. Es kann ein
 * persönliches Memory desselben Rangs damit nie überholen — die
 * Produktentscheidung „persönliche Memories gewinnen" bleibt erhalten, und
 * zwar jetzt unabhängig von der Größe irgendwelcher Rohwerte.
 *
 * ⚠️ Die Obergrenze der servierten Skala steigt auf dem fusionierten Pfad:
 * 163.934 (beide persönlichen Arme, Rang 1) + 0.95 × 81.967 (Commons Rang 1,
 * bestbewertet) = 241.803. Das ist die Bauart eines dritten Arms und betrifft
 * nur Recalls, bei denen die Commons überhaupt aktiv sind; alle Bänder liegen
 * bei ≤ 100 und lesen sich unverändert.
 */
import { RRF_K, RRF_SCALE } from "@bastra-recall/core/rrf";
import type { RecallHit } from "@bastra-recall/core";

/** Auf drei Nachkommastellen — dieselbe Rundung, mit der `search.ts` den
 *  persönlichen Score veröffentlicht. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * @param personal  Die persönliche Trefferliste, absteigend sortiert.
 * @param commons   Die Commons-Trefferliste, absteigend sortiert.
 * @param weightFor Vertrauensgewicht pro Commons-ID (`commonsRankFactor`).
 * @param opts.personalFused  Liegen die persönlichen Scores bereits auf der
 *   RRF-Skala (beide Arme liefen)? Dann wird addiert statt kollabiert.
 * @returns Eine Liste in EINEM Score-Raum (RRF-Skala), absteigend sortiert.
 */
export function fuseCommonsHits(
  personal: RecallHit[],
  commons: RecallHit[],
  weightFor: (id: string) => number,
  opts: { personalFused: boolean },
): RecallHit[] {
  // `fromCommons` merkt sich, ob dieser Eintrag am Ende einen Commons-Beitrag
  // trägt. Nur dann wird `rrf.raw` neu gesetzt (siehe unten) — ein Treffer, zu
  // dem die Commons nichts gesagt haben, behält seinen exakten, ungerundeten
  // RRF-Wert aus der persönlichen Fusion.
  const fused = new Map<string, { hit: RecallHit; raw: number; fromCommons: boolean }>();
  personal.forEach((hit, index) => {
    // Fusioniert: der Score bleibt stehen, Commons kommt als dritter Arm dazu.
    // Degradiert: der Rohwert ist unbrauchbar, nur sein Listenrang zählt.
    const score = opts.personalFused ? hit.score : (RRF_SCALE * 1) / (RRF_K + index + 1);
    // Auf dem Kollaps-Pfad erklärt `rrf` den Score nicht mehr (er ist neu aus
    // einem Listenrang gebildet) — ein Feld, das eine Zahl erklären soll und es
    // nicht mehr tut, ist schlimmer als keines. Auf dem additiven Pfad bleibt
    // es stehen und erklärt weiterhin den PERSÖNLICHEN Anteil; `isNoHome`
    // hängt daran, und ohne es meldete derselbe Recall mit aktiven Commons
    // plötzlich `no_home: false`.
    // Auf dem Kollaps-Pfad wird das alte `rrf` nicht nur verworfen, sondern
    // ERSETZT. Codex-Gegenreview: Es fiel ersatzlos weg, und ein Treffer, den
    // die Commons zusätzlich kannten, kam am Ende mit 147.541 heraus, ohne
    // dass irgendein Feld diese Zahl erklärte — kein `rrf`, kein
    // `rank_commons`, kein `personal_score`. Die Ränge, aus denen der Score
    // hier gebildet wird, sind bekannt; also gehören sie auch hin.
    const kept = opts.personalFused
      ? hit
      : ({
          ...hit,
          rrf: {
            rank_bm25: null,
            rank_vector: null,
            raw: score / RRF_SCALE,
            rank_personal_list: index + 1,
          },
        } as RecallHit);
    fused.set(hit.id, { hit: kept, raw: score, fromCommons: false });
  });
  commons.forEach((hit, index) => {
    const weight = weightFor(hit.id);
    const contribution = (RRF_SCALE * weight) / (RRF_K + index + 1);
    const existing = fused.get(hit.id);
    // ID-Kollision: das persönliche Memory bleibt das ausgelieferte Objekt
    // (Scope, Body, Frontmatter), sein Rang im Commons-Index zählt aber mit —
    // zwei unabhängige Listen, die sich einig sind, ist das Signal, das RRF
    // überhaupt messen soll.
    // Akkumuliert in `raw`, nicht auf `hit.score`: der Score-Gateway-Guard
    // (#194) verlangt, dass eine `.score`-Zuweisung nur an gepinnten Stellen steht,
    // und diese Fusion baut einen Wert auf, statt einen bestehenden zu mutieren.
    if (existing) {
      // Codex-Gegenreview (P0): Der Beitrag verschwand spurlos in der Summe.
      // Das Evidence-Objekt nannte weiter nur die persönlichen Ränge und
      // erklärte damit eine Zahl, die es nicht mehr war. Wer den Score liest,
      // muss sehen können, welcher Teil davon aus den Commons kam — und was
      // derselbe Recall ohne sie ergeben hätte.
      if (existing.hit.rrf) {
        existing.hit = {
          ...existing.hit,
          rrf: {
            ...existing.hit.rrf,
            rank_commons: index + 1,
            commons_weight: weight,
            personal_score: round3(existing.raw),
          },
        };
      }
      existing.raw += contribution;
      existing.fromCommons = true;
    } else {
      fused.set(hit.id, {
        // Ein Treffer, den NUR die Commons kennen: der ganze Score kommt von
        // dort, der persönliche Anteil ist null.
        hit: {
          ...hit,
          rrf: {
            rank_bm25: null,
            rank_vector: null,
            raw: contribution / RRF_SCALE,
            rank_commons: index + 1,
            commons_weight: weight,
            personal_score: 0,
          },
        },
        raw: contribution,
        fromCommons: true,
      });
    }
  });
  return [...fused.values()]
    .map(({ hit, raw, fromCommons }) => {
      const scored = { ...hit, score: round3(raw) };
      // Codex-Gegenreview (Vertragsfehler): `rrf.raw` ist laut `search.ts` „der
      // unskalierte RRF-Wert vor der RRF_SCALE-Skalierung, die `score` ergibt".
      // Der Commons-Beitrag wurde aber nur auf `raw` (die lokale Summe)
      // addiert, nicht auf das Beleg-Feld. Gemessen: ausgelieferter Score
      // 225.574 gegen `rrf.raw × RRF_SCALE = 160`, auf dem Kollapspfad 147.541
      // gegen 81.967. Ein Feld, das eine Zahl erklären soll und eine andere
      // erklärt, ist schlimmer als keines.
      //
      // Entschieden für MITFÜHREN statt Vertrag-Verengen: `raw` erklärt die
      // ausgelieferte Zahl, `round3(raw × RRF_SCALE) === score` gilt wieder auf
      // jedem Pfad. Der Anteil OHNE Commons bleibt separat lesbar — dafür gibt
      // es `personal_score`, und der Commons-Anteil ist aus `rank_commons` und
      // `commons_weight` nachrechenbar. Die Gegenrichtung („raw meint nur die
      // persönlichen Arme") hätte `raw` zu einer Zahl gemacht, die man aus dem
      // Response nirgends wiederfindet, und ein zweites Feld für die
      // Score-Erklärung gebraucht.
      //
      // Nur bei tatsächlichem Commons-Beitrag: Ein Treffer, zu dem die Commons
      // nichts gesagt haben, behält seinen exakten Wert aus der persönlichen
      // Fusion — hier würde `raw / RRF_SCALE` ihn nur um die Rundung von
      // `score` verfälschen.
      if (fromCommons && scored.rrf) scored.rrf = { ...scored.rrf, raw: raw / RRF_SCALE };
      return scored;
    })
    .sort((a, b) => b.score - a.score);
}
