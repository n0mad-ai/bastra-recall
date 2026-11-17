/**
 * #1490 unit tests for the rendering of the three Neural panel designs
 * (Classic, Orbital, Ember) across the panel states a session goes through.
 * Translation details live in the panel-*-i18n tests; this file checks the
 * frame (exact width, colour on/off), the content per state and pins the full
 * output with a golden digest so a rendering change is a deliberate one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderNeural, NEURAL_DEMO } from "../../packages/statusline/src/panel/neural.ts";
import { visibleLength } from "../../packages/statusline/src/utils/terminal.ts";

const NOW = Date.parse("2026-11-17T10:00:00.000Z");
const DESIGNS = ["classic", "orbital", "ember"];
const LIVE = {
  ...NEURAL_DEMO,
  mode: "live",
  client: "claude",
  fresh: true,
  project: "panel-project",
  model: "OPUS TEST",
  effort: "high",
  context: 31,
  contextTotal: 200000,
  contextFree: 138000,
  usage: 44,
  usageResetsAt: NOW / 1000 + 3 * 86400,
  usage5h: 12,
  usage5hResetsAt: NOW / 1000 + 5400,
  apiDurationMs: 61000,
  durationMs: 3600000,
  costUsd: 1.25,
  cacheHitRatio: 0.8,
  tokens: 120000,
  linesAdded: 12,
  linesRemoved: 3,
  vault: 1500,
  searches: 3,
  hits: 9,
  loads: 2,
  saves: 1,
  latency: 180,
  clientLatency: 210,
  timingSource: "forwarder",
  errors: 0,
  loadedTitles: ["Erste Erinnerung", "Zweite Erinnerung"],
  git: { branch: "main", staged: 1, changed: 2, untracked: 0, conflicts: 0, ahead: 1, behind: 0, known: true },
  now: NOW,
  active: false,
  agentActive: false,
  recent: false,
  stage: "Recall bereit",
  stageText: { key: "stage.ready" },
};
const STATES = {
  demo: { ...NEURAL_DEMO, now: NOW },
  idle: LIVE,
  active: {
    ...LIVE,
    active: true,
    agentActive: true,
    stage: "Semantik abgleichen",
    stageText: { key: "stage.raw", vars: { text: "Semantik abgleichen" } },
  },
  error: {
    ...LIVE,
    errors: 2,
    recent: true,
    agentActive: true,
    stage: "Zuletzt: recall · Fehler",
    stageText: { key: "stage.recentError", vars: { tool: "recall" } },
  },
  full: { ...LIVE, context: 92, contextFree: 16000, usage: 97, usage5h: 99 },
  unknown: {
    ...LIVE,
    fresh: false,
    context: null,
    contextTotal: null,
    contextFree: null,
    usage: null,
    usageResetsAt: null,
    usage5h: null,
    usage5hResetsAt: null,
    searches: null,
    hits: null,
    loads: null,
    saves: null,
    latency: null,
    clientLatency: null,
    tokens: null,
    durationMs: null,
    vault: null,
    git: null,
    loadedTitles: undefined,
    stage: "Codex-Transcript nicht verfügbar",
    stageText: { key: "stage.codexUnavailable" },
  },
  codex: { ...LIVE, client: "codex", model: "gpt-test", cachedInputRatio: 0.25, cacheHitRatio: null, costUsd: null },
};

const ESC = "\x1b";
/** Every combination of the given axes, in a fixed order. */
const combos = (axes) =>
  Object.entries(axes).reduce(
    (acc, [key, values]) => acc.flatMap((c) => values.map((value) => ({ ...c, [key]: value }))),
    [{}]
  );

test("every design fills exactly the requested width in every state, view and colour mode", () => {
  const cases = combos({
    design: DESIGNS,
    name: Object.keys(STATES),
    width: [60, 90, 120, 160],
    compact: [false, true],
    color: [false, true],
  });
  for (const { design, name, width, compact, color } of cases) {
    const lines = renderNeural(STATES[name], width, 3, color, design, { compact });
    const label = `${design}/${name}/${width}/${compact ? "compact" : "full"}/${color ? "colour" : "plain"}`;
    assert.ok(lines.length > 0, label);
    for (const [i, line] of lines.entries()) assert.equal(visibleLength(line), width, `${label} line ${i}`);
    assert.equal(lines.join("").includes(ESC), color, `${label}: escape codes only with colour`);
  }
});

test("the header names model and project, and the Recall counters appear in the full view", () => {
  for (const design of DESIGNS) {
    const text = renderNeural(STATES.idle, 120, 0, false, design).join("\n");
    assert.match(text, /OPUS TEST/, design);
    assert.match(text, /panel-project/, design);
    assert.match(text, /Erste Erinnerung/, `${design} lists loaded titles`);
    assert.match(text, /Recall bereit/, `${design} shows the stage`);
    assert.doesNotMatch(text, /Semantik abgleichen/, `${design} shows no stale demo stage`);
  }
});

test("the live stage is shown only while Recall is running", () => {
  for (const design of DESIGNS) {
    const active = renderNeural(STATES.active, 120, 0, false, design).join("\n");
    assert.match(active, /Semantik abgleichen/, design);
    const error = renderNeural(STATES.error, 120, 0, false, design).join("\n");
    assert.match(error, /Fehler/, `${design} reports the failed call`);
  }
});

test("unknown values render as a dash, never as invented numbers", () => {
  for (const design of DESIGNS) {
    const text = renderNeural(STATES.unknown, 120, 0, false, design).join("\n");
    assert.match(text, /—/, design);
    assert.doesNotMatch(text, /\b1500\b|\b1\.500\b/, `${design} shows no vault size it does not know`);
    assert.doesNotMatch(text, /\b44 %/, `${design} shows no usage it does not know`);
    assert.match(text, /Codex-Transcript nicht verfügbar/, design);
  }
});

test("the same input renders the same output; an idle panel does not change between frames", () => {
  for (const design of DESIGNS) {
    const a = renderNeural(STATES.idle, 120, 5, true, design);
    assert.deepEqual(renderNeural(STATES.idle, 120, 5, true, design), a, design);
    assert.deepEqual(renderNeural(STATES.idle, 120, 6, true, design), a, `${design} idles without animation`);
  }
});

test("rendered panels stay byte-identical across designs, states and views (golden digest)", () => {
  const hash = createHash("sha256");
  const cases = combos({
    design: DESIGNS,
    name: Object.keys(STATES),
    width: [72, 120],
    view: [{}, { compact: true }, { light: true }, { lang: "en" }, { paper: [20, 20, 30] }],
    frame: [0, 7],
  });
  for (const { design, name, width, view, frame } of cases)
    hash
      .update(`${design}/${name}/${width}/${JSON.stringify(view)}/${frame}\n`)
      .update(renderNeural(STATES[name], width, frame, true, design, view).join("\n"));
  const digest = hash.digest("hex");
  assert.equal(digest, GOLDEN_PANELS, `panel output changed: ${digest}`);
});

// Generated from main at the start of #1490. A deliberate design change updates it.
const GOLDEN_PANELS = "dae17a931aeb498d084180675dbf694bc5931c4c33a0605152dff1663880299b";
