import test from 'node:test';
import assert from 'node:assert/strict';
import { resetCountdown } from '../../packages/statusline/src/panel/reset-time.ts';

const now = 1_800_000_000_000;
const resetAfter = ms => (now + ms) / 1000;

test('reset countdown retains German by default and explicitly', () => {
  for (const lang of [undefined, 'de']) {
    assert.equal(resetCountdown(resetAfter(0), now, lang), 'RESET FÄLLIG');
    assert.equal(resetCountdown(resetAfter(-1), now, lang), 'RESET FÄLLIG');
    assert.equal(resetCountdown(resetAfter(60_000), now, lang), 'RESET IN 1m');
  }
});

test('English translates due resets at and after the deadline', () => {
  assert.equal(resetCountdown(resetAfter(0), now, 'en'), 'RESET DUE');
  assert.equal(resetCountdown(resetAfter(-1), now, 'en'), 'RESET DUE');
});

test('countdown prefixes, invalid input and minute/hour/day boundaries stay identical in both languages', () => {
  for (const lang of ['de', 'en']) {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, 0, -1]) {
      assert.equal(resetCountdown(value, now, lang), 'RESET —');
    }
    for (const [remaining, expected] of [
      [1, 'RESET IN 1m'],
      [60_000, 'RESET IN 1m'],
      [60_001, 'RESET IN 2m'],
      [59 * 60_000, 'RESET IN 59m'],
      [59 * 60_000 + 1, 'RESET IN 1h 0m'],
      [61 * 60_000, 'RESET IN 1h 1m'],
      [1439 * 60_000, 'RESET IN 23h 59m'],
      [1439 * 60_000 + 1, 'RESET IN 1d 0h'],
      [25 * 60 * 60_000, 'RESET IN 1d 1h'],
    ]) assert.equal(resetCountdown(resetAfter(remaining), now, lang), expected);
  }
});
