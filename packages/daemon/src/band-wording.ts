/**
 * What a score band actually selects (#302).
 *
 * Every hook surface prints a headline over its REQUIRED hits, and all of them
 * used to say the same thing: "Strong matches (score >= 100)". The score is
 * `RRF_SCALE × Σ 1/(RRF_K + rank)` — a rank sum, not a similarity — so that
 * headline asserted something the number cannot carry. #302 measured the
 * consequence on a 597-memory vault: 99.9% of hybrid hits landed in REQUIRED,
 * the noise floor fired 0.0% of the time, and every REQUIRED hit was one both
 * arms had found. The cut was a test for arm agreement, labelled as strength.
 *
 * The fix is not a new constant. Invert the score and a cut becomes a rank:
 *
 *   two-armed hit at rank r  ->  2·RRF_SCALE / (RRF_K + r)
 *   rank_max for a cut       ->  2·RRF_SCALE / cut − RRF_K
 *
 * At the shipped k=60 that put the cut at 100 at rank 40 — every two-armed hit
 * cleared it. At k=5 (#335) it sits at rank 4. So the cuts were never the
 * problem; the scale under them was, and the wording only has to state what
 * the cut now selects.
 *
 * Deliberately free of imports: `hook.ts` keeps `@bastra-recall/core` lazy
 * (#28) so the skip-gate path never pays for it, and the hook budget has no
 * headroom to spare (#305). Callers pass the constants they already hold.
 */

/** The RRF constants, as the caller obtained them. */
export interface RrfConstants {
  k: number;
  scale: number;
}

/**
 * Highest rank a hit found by BOTH arms can hold and still clear `cut`.
 * A one-armed hit scores half as much at the same rank, which is why it can
 * never reach a cut of 100 — that ceiling is structural, not a tuning choice.
 */
export function twoArmedRankFor(cut: number, k: number, scale: number): number {
  return Math.floor((2 * scale) / cut - k);
}

/**
 * `", both in their top 4"` — the clause that makes an agreement claim precise,
 * or `""` when the constants are not loaded (hook.ts before its lazy import).
 * The surrounding sentence must stay true without it: agreement is still what
 * was measured, only its sharpness goes unstated.
 */
export function agreementSuffix(cut: number, rrf: RrfConstants | null): string {
  if (!rrf) return "";
  const rank = twoArmedRankFor(cut, rrf.k, rrf.scale);
  return rank >= 1 ? `, both in their top ${rank}` : "";
}

/**
 * The REQUIRED headline, for any surface. `subject` names what the lookup was
 * for ("what you're about to do", "this prompt", "this session").
 */
export function requiredHeadline(subject: string, cut: number, rrf: RrfConstants | null): string {
  return (
    `Both search paths agreed on these for ${subject}${agreementSuffix(cut, rrf)} — ` +
    `that agreement is what a score ≥${cut} measures, not how similar the text is.`
  );
}

/**
 * The headline when no vector arm ran. There is no fusion, no ceiling, and the
 * raw BM25 scale is unbounded — #302 measured top hits into six digits — so no
 * band claim can be made at all.
 */
export function unfusedHeadline(subject: string): string {
  return (
    `Lexical matches for ${subject}, ranked by term overlap alone — semantic ` +
    `search is off, so no second path confirmed any of them and the scores are ` +
    `on an open-ended scale (not the fused bands). Judge these by title and ` +
    `summary, not by the number.`
  );
}

/**
 * Die Bandzuweisung selbst — zentral, damit kein Surface sie noch einmal
 * inline erfindet.
 *
 * P0: Ohne Vektor-Arm gibt es keine Fusion, keine Obergrenze und damit kein
 * Band. Die Cuts (50/100) sind Punkte auf der Rang-Summen-Skala; auf rohe
 * BM25-Werte angewendet selektieren sie nichts — gemessen wurden dort
 * sechsstellige Top-Scores, die jeden Cut trivial reißen. `unbanded` trägt in
 * diesem Fall ALLE Hits, und der Aufrufer stellt sie unter
 * `unfusedHeadline()`, statt eine Auswahl zu behaupten.
 */
export interface BandedHits<H> {
  required: H[];
  optional: H[];
  /** Nur im unfused Fall belegt: die Hits ohne jeden Bandanspruch. */
  unbanded: H[];
}

/**
 * #265/C-046: Ein Treffer, der NUR über einen Graph-Hop erreicht wurde, wird
 * nie `required`.
 *
 * Die Regel steht hier ausdrücklich, statt aus der Score-Skalierung zu folgen.
 * Bisher hielt sie durch zwei Zufälle: Auf dem Hybridpfad deckelt die skalierte
 * Rang-Summe einen Nachbarn bei rund 82, also unter dem Cut von 100; auf dem
 * BM25-Fallback sind die Werte unbegrenzt, aber dort bandet `unfused` ohnehin
 * gar nichts. Beide Zufälle können sich ändern — ein anderer Cut, eine andere
 * Skalierung —, und dann wäre die Auflage still weg. Ein Nachbar muss die
 * Evidenz auf eigener Stärke bestehen; dass ihn ein `related_via` erreichbar
 * gemacht hat, ist keine.
 *
 * Greift nur, wo der Aufrufer den Hop überhaupt kennt: Die schlanke
 * Hook-Projektion trägt ihn bewusst nicht (§13.1), also bandet die Lane wie
 * bisher. Serverseitig — vor der Projektion, wo die Auflage laut C-046 gelten
 * muss — liegt er an, und dort wirkt die Regel.
 */
export function bandHits<H extends { score: number; hop?: "direct" | "1-hop" }>(
  hits: H[],
  cut: number,
  unfused: boolean,
): BandedHits<H> {
  if (unfused) return { required: [], optional: [], unbanded: hits };
  const isRequired = (h: H): boolean => h.score >= cut && h.hop !== "1-hop";
  return {
    required: hits.filter(isRequired),
    optional: hits.filter((h) => !isRequired(h)),
    unbanded: [],
  };
}
