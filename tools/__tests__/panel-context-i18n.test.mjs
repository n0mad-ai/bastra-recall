import test from 'node:test';
import assert from 'node:assert/strict';
import { contextWarning } from '../../packages/statusline/src/panel/context-level.ts';

test('context warnings preserve German defaults at every threshold', () => {
  for (const [percent, expected] of [
    [0, null], [39.9, null], [40, 'Qualität lässt nach'], [59.9, 'Qualität lässt nach'],
    [60, 'Bald neue Sitzung starten'], [69.9, 'Bald neue Sitzung starten'],
    [70, 'Context Rot: neu starten'], [100, 'Context Rot: neu starten'],
  ]) {
    assert.equal(contextWarning(percent), expected);
    assert.equal(contextWarning(percent, 'de'), expected);
  }
});

test('English context warnings use the same thresholds', () => {
  for (const [percent, expected] of [
    [0, null], [39.9, null], [40, 'Quality is degrading'], [59.9, 'Quality is degrading'],
    [60, 'Start a new session soon'], [69.9, 'Start a new session soon'],
    [70, 'Context rot: restart'], [100, 'Context rot: restart'],
  ]) assert.equal(contextWarning(percent, 'en'), expected);
});

test('unknown context measurements remain quiet in both languages', () => {
  for (const percent of [null, undefined, NaN, Infinity, -Infinity, '70']) {
    for (const lang of ['de', 'en']) assert.equal(contextWarning(percent, lang), null);
  }
});
