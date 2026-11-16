import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// lens-draw.js without its imports: i18n, colours and hash are stubbed.
async function loadLensDraw() {
  const source = await readFile(
    new URL("../../packages/daemon/webui/v22/js/views/lens-draw.js", import.meta.url),
    "utf8"
  );
  const body = source.replace(/^import .*$/gm, "").replaceAll("export ", "");
  const context = vm.createContext({ Intl, Date, Math, Map, Set, Array, Number, String, Object, JSON });
  vm.runInContext(
    `
    const tr = (k) => k, LANG = "en";
    const TC = {}, ACC = "#38d9f5", AMB = "#d9a441", INK = "#d7e3f4", MUT = "#7d92a8", RC = { linked: INK, derived: MUT };
    function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
    ${body}
    globalThis.api = { prep, VIEWS };`,
    context
  );
  return context.api;
}

const ctx = new Proxy(
  { measureText: (s) => ({ width: String(s).length * 6 }) },
  {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: () => true,
  }
);

function chronosRegs(api, mems) {
  const P = api.prep(mems),
    regs = [],
    pts = [];
  api.VIEWS.chronos({
    ctx,
    w: 1000,
    h: 800,
    P,
    o: { kind: "chronos" },
    t: 1,
    hov: null,
    pt: (...a) => pts.push(a),
    reg: (test, d) => regs.push([test, d]),
  });
  return regs;
}

test("Chronos band hover only hits visible band dots and the band label, not the empty part of the ring", async () => {
  const api = await loadLensDraw();
  const DAY = 864e5,
    now = Date.now();
  // one area, memories created within the last 30 days only
  const mems = Array.from({ length: 20 }, (_, i) => ({
    id: "m" + i,
    area: "alpha",
    cls: "fact",
    recalled: 0,
    links: [],
    at: now - i * DAY,
    created: now - i * DAY,
  }));
  const [[hit, d]] = chronosRegs(api, mems);
  assert.equal(d.area, "alpha");
  const cx = 500,
    cy = 400,
    R = Math.min(1000, 800) / 2 - 10,
    bt = R * 0.05,
    r = R - 0.5 * bt;
  const GAP = 0.4,
    span = Math.PI * 2 - GAP,
    a0 = -Math.PI / 2 + GAP / 2;
  const at = (days) => {
    const a = a0 + ((364 - 1 - days + 0.5) / 364) * span;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  // recent days sit just left of the top gap, where the dots are drawn
  assert.equal(hit(...at(4)), true, "a filled 3-day dot is hoverable");
  // half a year ago: the ring has no dot there (right / bottom of the dial)
  assert.equal(hit(...at(180)), false, "the empty part of the band is not hoverable");
  assert.equal(hit(...at(300)), false, "the empty part of the band is not hoverable");
  // the band label in the top gap
  assert.equal(hit(cx, cy - r), true, "the band label is hoverable");
  // outside the band
  assert.equal(hit(cx + R + 30, cy), false);
});
