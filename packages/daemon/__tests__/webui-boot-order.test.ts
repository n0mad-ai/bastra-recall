// #1663: on load the stage slid from its default left edge under the agent panel for about 0.2 s while
// the panel faded in: mounting the panel measured the page before the first draw, and the first draw
// was the stored view, the address hash's place came right after. Now the hash is followed before the
// first draw and that draw puts the stage in place without sliding. The real boot code (js/main.js)
// runs here with its imports replaced by recorders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");

async function boot(hash: string, saved = "chronos") {
  const source = strip(await readFile(new URL("../webui/app/js/main.js", import.meta.url), "utf8"));
  const state: Record<string, unknown> = { view: saved };
  const listeners: Array<(s: Record<string, unknown>) => void> = [];
  const drawn: unknown[] = []; // the view of every layout the shell applied
  const steps: string[] = []; // layouts and what happened to the stage's transition, in order
  const stageEl = {
    style: {
      set transition(v: string) {
        steps.push(`transition=${v}`);
      },
    },
    get offsetLeft() {
      steps.push("measured");
      return 0;
    },
    getAnimations: () => [{ finish: () => steps.push("animation finished") }],
  };
  const el = () => ({
    append() {},
    addEventListener() {},
    querySelector: (q: string) => (q === ".stage" ? stageEl : null),
  });
  const noop = () => {};
  const part = { render: noop, mountStage: noop, mountAgent: noop, mountFooter: noop, mountLens: noop };
  const setState = (patch: Record<string, unknown>) => {
    Object.assign(state, patch);
    listeners.forEach((fn) => fn(state));
  };
  runInNewContext(source, {
    h: el,
    t: (k: string) => k,
    state,
    setState,
    subscribe: (fn: (s: Record<string, unknown>) => void) => listeners.push(fn),
    computeLayout: (s: Record<string, unknown>) => ({ view: s.view }),
    applyLayout: (_app: unknown, L: { view: unknown }) => {
      drawn.push(L.view);
      steps.push("layout");
    },
    getArea: noop,
    data: {},
    onData: noop,
    startPolling: noop,
    mountNav: noop,
    updateNav: noop,
    // the real one opens the hash's place through the store (js/nav.js, tested in webui-nav-hash)
    followHash: () => hash && setState({ view: hash }),
    mountHeader: noop,
    updateHeader: noop,
    agent: { ...part, ask: noop },
    footer: part,
    lens: { ...part, color: noop, toggleLens: noop, peekIn: noop, peekOut: noop, refreshLens: noop },
    stage: part,
    assistantName: () => "Jarvis",
    loadSettings: async () => {},
    onStore: noop,
    mountBackdrop: noop,
    document: { getElementById: el, addEventListener: noop },
    window: { addEventListener: noop, innerWidth: 1368, innerHeight: 913 },
  });
  return { drawn, steps };
}

test("#1663: with an address hash the shell never draws the stored view first", async () => {
  const { drawn } = await boot("tasks");
  assert.ok(drawn.length > 0, "the shell drew");
  assert.deepEqual([...new Set(drawn)], ["tasks"], `layouts drawn: ${drawn.join(", ")}`);
});

test("#1663: without a hash the first draw is the stored view, as before", async () => {
  const { drawn } = await boot("");
  assert.deepEqual([...new Set(drawn)], ["chronos"]);
});

test("#1663: after the first draw the stage takes its place without a transition or a wait, then gets it back", async () => {
  for (const hash of ["tasks", ""]) {
    const { steps } = await boot(hash);
    const after = steps.slice(steps.lastIndexOf("layout") + 1);
    assert.deepEqual(
      after,
      ["transition=none", "measured", "animation finished", "transition="],
      `${hash || "no hash"}: ${steps.join(", ")}`
    );
  }
});
