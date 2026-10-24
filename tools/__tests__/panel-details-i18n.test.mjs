import test from 'node:test';
import assert from 'node:assert/strict';
import { gitLabel, sessionLabel, timingLabel } from '../../packages/statusline/src/panel/details.ts';

const git = { known: true, branch: 'main', sha: '1234567890', staged: 1, changed: 2, untracked: 3, conflicts: 4, ahead: 5, behind: 6 };

test('session labels translate German text while preserving German defaults and API formatting', () => {
  const data = { durationMs: 3_780_000, apiDurationMs: 1500, costUsd: 1.23, cacheHitRatio: 0.56, cachedInputRatio: 0.78, linesAdded: 12, linesRemoved: 3, tokens: 2_500_000 };
  const de = 'Session 1h 3m · API 2 s · Kosten ≈$1.23 · Cache 56% · Cache-Eingabe 78% · Zeilen +12/−3 · Tokens 2.50M';
  assert.equal(sessionLabel(data), de);
  assert.equal(sessionLabel(data, 'de'), de);
  assert.equal(sessionLabel(data, 'en'), 'Session 1h 3m · API 2 s · Cost ≈$1.23 · Cache 56% · Cached input 78% · Lines +12/−3 · Tokens 2.50M');
  assert.equal(sessionLabel({ costUsd: 0.001 }, 'en'), 'API — · Cost <$0.01');
  assert.equal(sessionLabel({ client: 'codex', mode: 'live' }, 'en'), 'API — · Cost —');
  assert.equal(sessionLabel({ costUsd: 0 }, 'en'), 'API — · Cost ≈$0.00');
  assert.equal(sessionLabel({}, 'en'), 'API —');
});

test('git labels preserve German defaults and translate counts into English', () => {
  const de = '⑂ main @1234567 · 1 staged · 2 geändert · 3 neu · 4 Konflikte · ↑5 ↓6';
  assert.equal(gitLabel({ git }), de);
  assert.equal(gitLabel({ git }, 'de'), de);
  assert.equal(gitLabel({ git }, 'en'), '⑂ main @1234567 · 1 staged · 2 changed · 3 new · 4 conflicts · ↑5 ↓6');
});

test('git clean, detached and unknown states keep their structure in both languages', () => {
  const clean = { ...git, branch: null, sha: null, staged: 0, changed: 0, untracked: 0, conflicts: 0, ahead: null, behind: null };
  assert.equal(gitLabel({ git: clean }), '⑂ detached · sauber');
  assert.equal(gitLabel({ git: clean }, 'en'), '⑂ detached · clean');
  for (const lang of ['de', 'en']) {
    assert.equal(gitLabel({}, lang), 'Git —');
    assert.equal(gitLabel({ git: { known: false } }, lang), 'Git —');
  }
});

test('timing translates demo tool time and preserves rounded client and Recall timings', () => {
  assert.equal(timingLabel({ mode: 'demo', latency: 12.6 }), 'Toolzeit 13 ms');
  assert.equal(timingLabel({ mode: 'demo', latency: 12.6 }, 'de'), 'Toolzeit 13 ms');
  assert.equal(timingLabel({ mode: 'demo', latency: 12.6 }, 'en'), 'Tool time 13 ms');
  for (const lang of ['de', 'en']) {
    assert.equal(timingLabel({ mode: 'live', latency: null }, lang), 'Client — ms');
    assert.equal(timingLabel({ timingSource: 'forwarder', latency: 12.6, clientLatency: 45.4 }, lang), 'Recall 13 ms · Client 45 ms');
    assert.equal(timingLabel({ timingSource: 'forwarder' }, lang), 'Recall 0 ms');
  }
});
