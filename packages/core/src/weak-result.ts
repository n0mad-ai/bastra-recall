/**
 * #230 / #249 — the "nothing really matched" signal, shared by every recall path.
 *
 * On the hybrid path the score is a RANK quantity, not a similarity: a list
 * always has a first element, so a nonsense query still produces a top hit at
 * 130+. `weak_result` is the flag that says the high score is rank-1-of-nothing
 * rather than a real match.
 *
 * It lived inside `recallHandler` and therefore only ever reached the MCP path.
 * `/hook/recall` — the path that writes `<recall-hints>` into an agent's context
 * on every Bash and Edit — never formed it, so the hint blocks labelled
 * everything above the threshold as "Strong matches" including pure noise. In a
 * live session that meant the same handful of unrelated memories surfaced at
 * 150-160 for every `rm -rf` and every file edit.
 *
 * Extracted here so both paths compute the same thing from the same code. A
 * second implementation would have drifted, and the two paths disagreeing about
 * what "weak" means is worse than neither having it.
 *
 * It sat in `packages/daemon` until the M1 tolerances (#262, §18.1) needed it:
 * `false_abstention` is to be measured as the share of answerable cases with
 * `weak_result`, and the gold-set runner in `packages/eval` cannot depend on
 * the daemon. core is the one workspace every path already depends on, so the
 * predicate moved here rather than being copied a third time — which is the
 * drift this docstring has been warning about since #249.
 */
import type { RecallHit } from "./search.js";

/**
 * Did a lexical BM25 match (`matched_terms`) land in the hit's TITLE?
 *
 * `matched_terms` only says that a query term hit the document somewhere, not
 * in which field — so this checks the title string tolerantly (exact token, or
 * a prefix in either direction to absorb stemming). Tolerant by design: when in
 * doubt the hit counts as a title match, which keeps `weak_result` conservative
 * and stops it from firing falsely.
 */
export function hitTitleMatches(hit: RecallHit): boolean {
  if (!hit.matched_terms || hit.matched_terms.length === 0) return false;
  const titleTokens = hit.title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return hit.matched_terms.some((term) => {
    const t = term.toLowerCase();
    return titleTokens.some((tok) => tok === t || tok.startsWith(t) || t.startsWith(tok));
  });
}

/**
 * True when the hybrid path returned hits but none of them lexically anchors —
 * no `recall_when` match and no title match.
 *
 * Conservative on purpose: it only fires when the FULL hybrid path ran (both
 * arms, not the breaker-degraded BM25 fallback), because in BM25-only mode the
 * score is a genuine BM25 quantity and the floor already does this job. Purely
 * informational — it filters nothing.
 */
export function isWeakResult(hits: RecallHit[], hybridActive: boolean): boolean {
  return (
    hybridActive &&
    hits.length > 0 &&
    !hits.some((h) => h.matched_recall_when === true || hitTitleMatches(h))
  );
}

/**
 * #230 — a strict subset of `weak_result`: not just "nothing anchored", but
 * "the fact has no home in this vault".
 *
 * The distinction comes from @zzallirog dogfooding, and it splits the miss in
 * two:
 *
 * - **rank-1-of-WRONG** — a legitimate both-arms pair on the wrong document.
 *   `recall("arch firewall")` returned a top hit at 158.89 built from rank 1
 *   in BM25 and rank 4 in vector; the fact existed, in memories whose triggers
 *   never carried a standalone `firewall` token. No score-only signal can catch
 *   that, because the hit is not rank-1-of-nothing. Client-side problem.
 * - **rank-1-of-NOTHING** — the top hit lives in ONE arm only. That is what
 *   this predicate detects, and it is the shape a genuinely absent fact takes.
 *
 * Why the rank pair and not "flat score distribution": on real data flatness
 * INVERTS. A genuine home spikes to the both-arms ceiling with its siblings
 * crowding just behind, so it shows a SMALLER top1→top2 gap than a miss does.
 * The rank pair is the honest signal; the gap is a trap.
 *
 * Kept separate from `weak_result` rather than folded into it: it is a
 * higher-confidence claim, and collapsing two confidence levels into one field
 * on the public contract would lose exactly the distinction that makes it
 * useful. Additive and back-compatible — `weak_result` is untouched.
 */
export function isNoHome(hits: RecallHit[], hybridActive: boolean): boolean {
  if (!isWeakResult(hits, hybridActive)) return false;
  const top = hits[0];
  // Commons-fused hits come from the BM25 path and carry no `rrf` block at all.
  // Requiring it present is what keeps them from being read as one-armed.
  if (!top?.rrf) return false;
  // Ein Treffer, den NUR die Commons kennen, trägt seit dem Commons-Beleg
  // (Codex-Gegenreview P0) ein `rrf`-Objekt mit zwei leeren PERSÖNLICHEN
  // Rängen. Das ist Evidenz über den Commons-Arm, keine Aussage über die
  // Einigkeit zweier persönlicher Arme — und genau die misst `no_home`.
  if (top.rrf.personal_score === 0) return false;
  return top.rrf.rank_bm25 === null || top.rrf.rank_vector === null;
}
