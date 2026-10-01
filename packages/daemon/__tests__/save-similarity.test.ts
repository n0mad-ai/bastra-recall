/**
 * #239 — the regression matrix for the save-time duplicate signal.
 *
 * The reported defect: `save_quality` gated duplicates on a raw BM25 score, so
 * repeating a term inflated it, vault size moved it, and unrelated memories
 * sharing broad vocabulary were presented as near-duplicates at five-digit
 * "scores". These cases pin the properties the replacement must have.
 *
 * Runner: `tsx --test __tests__/save-similarity.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fieldSimilarity,
  foldUmlauts,
  triggerRestatesSummary,
  containedIn,
  DUPLICATE_SIMILARITY_MIN,
  type SimilarityFields,
} from "../src/save-similarity.js";

const mem = (f: Partial<SimilarityFields>): SimilarityFields => ({
  title: "",
  summary: "",
  tags: [],
  recall_when: [],
  ...f,
});

const CORS_FIX = mem({
  title: "CORS-Preflight scheitert am Loopback-Origin",
  summary: "Der Daemon lehnte OPTIONS-Preflights vom Browser ab, weil der Origin-Header nicht in der Allowlist stand.",
  tags: ["cors", "daemon", "browser"],
  recall_when: ["CORS-Fehler im Browser gegen den lokalen Daemon", "Preflight schlägt fehl"],
});

test("an exact duplicate scores 1", () => {
  assert.equal(fieldSimilarity(CORS_FIX, { ...CORS_FIX }), 1);
});

test("a reworded near-duplicate still clears the threshold", () => {
  const reworded = mem({
    title: "CORS-Preflight scheitert am Loopback-Origin des Daemons",
    summary: "OPTIONS-Preflights vom Browser wurden abgelehnt, weil der Origin-Header fehlte in der Allowlist.",
    tags: ["cors", "daemon"],
    recall_when: ["CORS-Fehler im Browser gegen den lokalen Daemon"],
  });
  const sim = fieldSimilarity(CORS_FIX, reworded);
  assert.ok(sim >= DUPLICATE_SIMILARITY_MIN, `near-duplicate must still be flagged, got ${sim.toFixed(3)}`);
});

test("THE REPORTED BUG: an unrelated memory sharing broad infrastructure vocabulary is not a duplicate", () => {
  // The field report's shape: same domain words (daemon, browser, lokal),
  // completely different subject. Raw BM25 put this at ~30000.
  const unrelated = mem({
    title: "chokidar erkennt neue Files im Google-Drive-Vault nicht zuverlässig",
    summary: "Der Watcher im Daemon meldet auf dem Cloud-Mount keine Events, ein Polling-Intervall ist nötig.",
    tags: ["daemon", "vault", "watcher"],
    recall_when: ["Vault-Änderungen werden nicht erkannt", "chokidar meldet keine Events auf Google Drive"],
  });
  const sim = fieldSimilarity(CORS_FIX, unrelated);
  assert.ok(sim < DUPLICATE_SIMILARITY_MIN, `same-domain neighbour must not be flagged, got ${sim.toFixed(3)}`);
});

test("repeating a term cannot inflate the similarity — the property raw BM25 lacked", () => {
  const once = mem({ title: "cors", summary: "cors fix", tags: ["cors"], recall_when: ["cors"] });
  const twenty = mem({
    title: Array(20).fill("cors").join(" "),
    summary: Array(20).fill("cors fix").join(" "),
    tags: ["cors"],
    recall_when: [Array(20).fill("cors").join(" ")],
  });
  assert.equal(
    fieldSimilarity(CORS_FIX, once),
    fieldSimilarity(CORS_FIX, twenty),
    "20× the same term must score exactly like 1×",
  );
});

test("the measure is symmetric", () => {
  const other = mem({ title: "Daemon startet nicht", summary: "launchd meldet Fehler", tags: ["daemon"] });
  // Exact equality would be testing IEEE-754 associativity, not the model: the
  // two directions sum the same terms in a different order, which lands ~1e-17
  // apart. Anything above that would be a real asymmetry.
  const delta = Math.abs(fieldSimilarity(CORS_FIX, other) - fieldSimilarity(other, CORS_FIX));
  assert.ok(delta < 1e-12, `asymmetry beyond float noise: ${delta}`);
});

test("diacritics survive — a German pair is not reduced to fragments", () => {
  const a = mem({ title: "Lösung für die Größe", recall_when: ["Änderungen an der Lösung"] });
  const b = mem({ title: "Lösung für die Größe", recall_when: ["Änderungen an der Lösung"] });
  assert.equal(fieldSimilarity(a, b), 1, "identical German text must be a perfect match, not a fragment match");

  const c = mem({ title: "Lösung für die Größe" });
  const d = mem({ title: "Abstand und Farbe" });
  assert.equal(fieldSimilarity(c, d), 0, "no shared content word → 0, not a stopword-driven partial");
});

test("diacritics fold only on Latin letters — another alphabet keeps its letters", () => {
  assert.equal(foldUmlauts("café"), "cafe");
  assert.equal(foldUmlauts("Größe"), "Groesse");
  // й and ё are letters of their own, not и/е with an accent.
  assert.equal(foldUmlauts("край"), "край");
  assert.equal(foldUmlauts("ёлка"), "ёлка");
  assert.equal(foldUmlauts("край").length, 4, "recomposed to NFC, not a letter plus a combining mark");
  const a = mem({ title: "мой ключ", recall_when: ["мой ключ от сервера"] });
  const b = mem({ title: "мои ключ", recall_when: ["мои ключ от сервера"] });
  assert.ok(fieldSimilarity(a, b) < 1, "different Cyrillic letters are different words");
});

test("stopwords alone never produce similarity", () => {
  const a = mem({ title: "Das ist eine Lösung für den Daemon", summary: "und das wird dann so sein" });
  const b = mem({ title: "Das ist eine Frage an die Kamera", summary: "und das wird dann so sein" });
  const sim = fieldSimilarity(a, b);
  assert.ok(sim < DUPLICATE_SIMILARITY_MIN, `function words must not carry the score, got ${sim.toFixed(3)}`);
});

test("a shared word counts by its WEAKER role — trigger on one side, prose on the other is weak evidence", () => {
  const asTrigger = mem({ recall_when: ["telemetrie auswerten"] });
  const alsoTrigger = mem({ recall_when: ["telemetrie auswerten"] });
  const asProse = mem({ summary: "telemetrie auswerten" });
  assert.ok(
    fieldSimilarity(asTrigger, asProse) < fieldSimilarity(asTrigger, alsoTrigger),
    "trigger↔prose overlap must be weaker than trigger↔trigger overlap",
  );
});

test("an empty memory is never similar to anything", () => {
  assert.equal(fieldSimilarity(CORS_FIX, mem({})), 0);
  assert.equal(fieldSimilarity(mem({}), mem({})), 0);
});

test("single characters and one-letter noise do not count as shared content", () => {
  const a = mem({ title: "a b c Daemon" });
  const b = mem({ title: "a b c Kamera" });
  assert.equal(fieldSimilarity(a, b), 0, "only 1-char tokens overlap → must be 0");
});

// ─── #238: recall_when that merely restates the summary ──────────────────
// zzallirog measured 81% of a real 471-note vault with recall_when[0] as a
// verbatim copy of summary — the weight-5 field spending itself on text
// already indexed at weight 2.

const SUMMARY =
  "Der Daemon lehnte OPTIONS-Preflights vom Browser ab, weil der Origin-Header nicht in der Allowlist stand.";

test("#238: a verbatim copy of the summary is flagged", () => {
  assert.equal(triggerRestatesSummary(SUMMARY, SUMMARY), true);
});

test("#238: a near-verbatim copy (leading clause) is flagged", () => {
  assert.equal(
    triggerRestatesSummary("Der Daemon lehnte OPTIONS-Preflights vom Browser ab", SUMMARY),
    true,
  );
});

test("#238: a real trigger — a situation, not a paraphrase — is NOT flagged", () => {
  assert.equal(triggerRestatesSummary("CORS-Fehler im Browser gegen den lokalen Daemon debuggen", SUMMARY), false);
});

test("#238: incidental vocabulary overlap does not fire", () => {
  // Shares 'browser' and 'daemon' with the summary, but names its own situation.
  assert.equal(triggerRestatesSummary("Browser kommt nicht an den Daemon ran nach dem Update", SUMMARY), false);
});

test("#238: a short trigger never fires — three shared words is a coincidence", () => {
  assert.equal(
    triggerRestatesSummary("Origin-Header fehlt", SUMMARY),
    false,
    "below the content-token floor the ratio is noise",
  );
});

test("#238: an empty summary cannot be restated", () => {
  assert.equal(triggerRestatesSummary(SUMMARY, ""), false);
  assert.equal(triggerRestatesSummary(SUMMARY, "   "), false);
});

test("#238: containment is directional — trigger⊂summary is not summary⊂trigger", () => {
  const part = "Der Daemon lehnte OPTIONS-Preflights vom Browser ab";
  assert.equal(containedIn(part, SUMMARY), 1, "every content word of the part is in the whole");
  assert.ok(containedIn(SUMMARY, part) < 1, "the whole is not contained in the part");
});

test("#238: stopwords do not carry containment", () => {
  // Only function words in common — must not read as a restatement.
  assert.equal(triggerRestatesSummary("und das ist eine von den Sachen", SUMMARY), false);
});
