/**
 * The flare spread starts at its default, not at zero.
 *
 * storedBoltSpread() read `Number(localStorage.getItem(key))`; with nothing
 * stored that is Number(null) = 0, so every fresh browser drew the bolts flat
 * on the strand although BOLT_SPREAD_DEFAULT is 1. A stored 0 stays 0.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/bolt-spread-default.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain browser module, no types (same as the other map module tests)
import { storedBoltSpread, BOLT_SPREAD_KEY, BOLT_SPREAD_DEFAULT } from "../webui/js/bolt-styles.js";

function withStorage(value: string | null, fn: () => void) {
  const prev = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (k === BOLT_SPREAD_KEY ? value : null),
  };
  try {
    fn();
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = prev;
  }
}

test("nothing stored → the default spread, not 0", () => {
  withStorage(null, () => assert.equal(storedBoltSpread(), BOLT_SPREAD_DEFAULT));
  withStorage("", () => assert.equal(storedBoltSpread(), BOLT_SPREAD_DEFAULT));
});

test("a stored value is kept and clamped", () => {
  withStorage("0", () => assert.equal(storedBoltSpread(), 0));
  withStorage("0.35", () => assert.equal(storedBoltSpread(), 0.35));
  withStorage("7", () => assert.equal(storedBoltSpread(), 1));
  withStorage("-1", () => assert.equal(storedBoltSpread(), BOLT_SPREAD_DEFAULT));
  withStorage("abc", () => assert.equal(storedBoltSpread(), BOLT_SPREAD_DEFAULT));
});
