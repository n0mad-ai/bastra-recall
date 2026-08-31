/**
 * Unit tests for scope-filter.ts (#107/#110/#148, split from hook-skip.test.ts
 * under #360 — isScopeCompatible/passesScopeFilter moved out of hook-skip.ts
 * so hook.ts's per-tool-call thin client never pays the `@bastra-recall/core`
 * import cost). Run with:
 *   npx tsx --test packages/daemon/__tests__/scope-filter.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isScopeCompatible, passesScopeFilter } from "../src/scope-filter.js";

test("isScopeCompatible (#107): foreign project scopes are filtered, family/global scopes pass", () => {
  // Das beobachtete Problem: bastra-io-Hint bei einem bastra-recall-Edit.
  assert.equal(isScopeCompatible("bastra-io", "bastra-recall"), false);
  assert.equal(isScopeCompatible("carnexus", "bastra-recall"), false);
  // Eigener Scope + Scope-Familie über Präfix.
  assert.equal(isScopeCompatible("bastra-recall", "bastra-recall"), true);
  assert.equal(isScopeCompatible("bastra", "bastra-recall"), true);
  assert.equal(isScopeCompatible("bastra-recall", "bastra"), true);
  // Globale Scopes immer.
  assert.equal(isScopeCompatible("all-projects", "bastra-recall"), true);
  assert.equal(isScopeCompatible("user-preference", "bastra-recall"), true);
  assert.equal(isScopeCompatible("taxonomy", "bastra-recall"), true);
  // Ohne erkanntes Projekt oder ohne Scope: kein Filter.
  assert.equal(isScopeCompatible("bastra-io", null), true);
  assert.equal(isScopeCompatible("", "bastra-recall"), true);
});

test("passesScopeFilter (#148): strong, deliberate cross-scope hits pass; tag/topic noise stays filtered", () => {
  const MUST_LOAD = 100;
  const p = "bastra-recall";

  // Compatible scopes always pass, regardless of recall_when / score.
  assert.equal(passesScopeFilter({ scope: "bastra-recall", score: 40 }, p, MUST_LOAD), true);
  assert.equal(passesScopeFilter({ scope: "all-projects", score: 40 }, p, MUST_LOAD), true);
  assert.equal(passesScopeFilter({ scope: "bastra", score: 40 }, p, MUST_LOAD), true);

  // ── The #148 case: a foreign-scope hit that matched its hand-written
  //    recall_when in the REQUIRED band IS deliberate cross-project relevance.
  assert.equal(
    passesScopeFilter({ scope: "bastra-io", score: 150, matched_recall_when: true }, p, MUST_LOAD),
    true,
    "foreign scope + recall_when match + REQUIRED band → passes (the Discord #dev case)",
  );

  // ── The #110 noise case MUST stay filtered: a foreign-scope hit that scored
  //    high on tag/topic overlap WITHOUT a recall_when match (the bastra-io
  //    hit at 159 that disproved the original score-only bypass).
  assert.equal(
    passesScopeFilter({ scope: "bastra-io", score: 159, matched_recall_when: false }, p, MUST_LOAD),
    false,
    "foreign scope, high score, but no recall_when match → still filtered (#110)",
  );
  assert.equal(
    passesScopeFilter({ scope: "bastra-io", score: 159 }, p, MUST_LOAD),
    false,
    "missing matched_recall_when is treated as no-match → filtered",
  );

  // ── A recall_when match BELOW the REQUIRED band does not pass — deliberate
  //    but weak is still curation noise for a foreign project.
  assert.equal(
    passesScopeFilter({ scope: "bastra-io", score: 80, matched_recall_when: true }, p, MUST_LOAD),
    false,
    "recall_when match but below REQUIRED band → filtered",
  );
});

test("passesScopeFilter (P0): a weak anchor no longer buys a cross-scope pass", () => {
  const MUST_LOAD = 100;
  const p = "bastra-recall";
  const foreign = { scope: "some-other-project", score: 150, matched_recall_when: true };

  // Vor P0 reichte das Flag allein. Ein einzelnes häufiges Wort, das zufällig
  // in der Triggerphrase eines fremden Projekts steht, ist aber keine Absicht —
  // und der Bypass ist genau die Stelle, an der das teuer wird.
  assert.equal(
    passesScopeFilter({ ...foreign, anchor_strength: "weak" }, p, MUST_LOAD),
    false,
    "one common trigger term must not open a foreign scope",
  );
  assert.equal(
    passesScopeFilter({ ...foreign, anchor_strength: "strong" }, p, MUST_LOAD),
    true,
    "a rare identifier or two authored terms still pass — the #148 case is intact",
  );

  // Rückwärtskompatibilität: Eine Antwort ohne das Feld (älterer Daemon,
  // fremder Aufrufer) darf nicht STRENGER behandelt werden als vorher —
  // sonst verschwinden absichtliche Cross-Scope-Hits still.
  assert.equal(
    passesScopeFilter(foreign, p, MUST_LOAD),
    true,
    "an absent field keeps the pre-P0 behaviour",
  );

  // Und die Score-Bedingung bleibt eine UND-Bedingung.
  assert.equal(
    passesScopeFilter({ ...foreign, score: 40, anchor_strength: "strong" }, p, MUST_LOAD),
    false,
    "a strong anchor below the REQUIRED band still does not pass",
  );
});

test("isScopeCompatible: a project's own memories survive a capitalised directory name", () => {
  // `detectProject()` gibt das Verzeichnissegment unverändert zurück — bei
  // /Users/x/Projekte/CarNexus also "CarNexus". Die Memories tragen den Scope
  // konventionell klein. Case-sensitiv verglichen war das eigene Projekt
  // dadurch ein fremdes: seine Memories flogen aus jedem Band, und nur die
  // globalen kamen noch durch. Still, und genau verkehrt herum.
  assert.equal(isScopeCompatible("carnexus", "CarNexus"), true, "own scope, capitalised cwd");
  assert.equal(isScopeCompatible("CarNexus", "carnexus"), true, "and the other way round");
  assert.equal(isScopeCompatible("bastra-recall", "Bastra-Recall"), true, "hyphenated too");

  // Die Scope-Familie über das Präfix muss ebenfalls gefaltet greifen …
  assert.equal(isScopeCompatible("bastra", "Bastra-Recall"), true, "family prefix, folded");
  // … ohne dass die Trennung zwischen Geschwistern aufweicht.
  assert.equal(isScopeCompatible("bastra-io", "Bastra-Recall"), false, "siblings stay separate");
  assert.equal(isScopeCompatible("carnexus", "Bastra-Recall"), false, "a foreign project stays foreign");

  // Globale Scopes bleiben global, auch groß geschrieben.
  assert.equal(isScopeCompatible("All-Projects", "CarNexus"), true, "global scopes fold too");
});
