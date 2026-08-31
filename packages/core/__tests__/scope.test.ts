/**
 * Unit tests for scope.ts (#360-Folgefund): normalizeScopeKey, scopeEquals,
 * isScopeCompatible — die zentrale Scope-Identität, die vorher als
 * case-sensitiver Copy-Paste an mehreren Stellen (hook-skip.ts,
 * candidate-union.ts, floors.ts, search.ts, bridge.ts, save-quality.ts)
 * auseinanderdriftete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOBAL_SCOPES, normalizeScopeKey, scopeEquals, isScopeCompatible } from "../src/scope.js";

test("normalizeScopeKey: folds case only, no other normalization", () => {
  assert.equal(normalizeScopeKey("CarNexus"), "carnexus");
  assert.equal(normalizeScopeKey("carnexus"), "carnexus");
  assert.equal(normalizeScopeKey("Bastra-Recall"), "bastra-recall");
});

test("scopeEquals: exact match, folded — the semantics passesRecallFilters needs", () => {
  assert.equal(scopeEquals("carnexus", "CarNexus"), true);
  assert.equal(scopeEquals("CarNexus", "carnexus"), true);
  assert.equal(scopeEquals("bastra-recall", "bastra-recall"), true);
  // Anders als isScopeCompatible: KEINE Familie/Präfix-Toleranz, KEIN
  // Global-Bypass — ein exact-match-Scope-Filter meint genau diesen Scope.
  assert.equal(scopeEquals("bastra", "bastra-recall"), false);
  assert.equal(scopeEquals("all-projects", "bastra-recall"), false);
});

test("isScopeCompatible: foreign project scopes filtered, family/global scopes pass", () => {
  assert.equal(isScopeCompatible("bastra-io", "bastra-recall"), false);
  assert.equal(isScopeCompatible("carnexus", "bastra-recall"), false);
  assert.equal(isScopeCompatible("bastra-recall", "bastra-recall"), true);
  assert.equal(isScopeCompatible("bastra", "bastra-recall"), true);
  assert.equal(isScopeCompatible("bastra-recall", "bastra"), true);
  for (const g of GLOBAL_SCOPES) {
    assert.equal(isScopeCompatible(g, "bastra-recall"), true, `${g} is global`);
  }
  assert.equal(isScopeCompatible("bastra-io", null), true, "no project → no filter");
  assert.equal(isScopeCompatible("", "bastra-recall"), true, "no scope → no filter");
});

test("isScopeCompatible: a project's own memories survive a capitalised directory name", () => {
  // `detectProject()` liefert das Verzeichnissegment unverändert ("CarNexus"),
  // Vault-Scopes sind konventionell klein ("carnexus"). Case-sensitiv
  // verglichen war das eigene Projekt nie mit seinem eigenen Scope kompatibel.
  assert.equal(isScopeCompatible("carnexus", "CarNexus"), true);
  assert.equal(isScopeCompatible("CarNexus", "carnexus"), true);
  assert.equal(isScopeCompatible("bastra", "Bastra-Recall"), true, "family prefix, folded");
  assert.equal(isScopeCompatible("bastra-io", "Bastra-Recall"), false, "siblings stay separate, folded");
  assert.equal(isScopeCompatible("All-Projects", "CarNexus"), true, "global scopes fold too");
});
