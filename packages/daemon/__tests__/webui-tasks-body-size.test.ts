// The Tasks calendar body lays out from its own size (#1732): the ledger scales the hour rows by the
// body height and stacks the day heads below 1152 px body width, so a one-pixel change on either axis
// must redraw it. tasks.js needs the whole shell to run, so its body observer is read from the source
// and run against stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const src = await readFile(new URL("../webui/app/js/sections/tasks.js", import.meta.url), "utf8");
const block =
  /ro = new ResizeObserver\(\(\) => \{[\s\S]*?\n {2}\}\);/.exec(src)?.[0] ?? assert.fail("body observer not found");

function observer(bw: number, bh: number) {
  const ctx = {
    size: { bw, bh },
    bodyEl: { clientWidth: bw, clientHeight: bh },
    draws: 0,
    cb: null as null | (() => void),
    ResizeObserver: class {
      constructor(fn: () => void) {
        ctx.cb = fn;
      }
    },
    drawCal: () => ctx.draws++,
  };
  runInNewContext(`var ro; ${block}`, ctx);
  return ctx;
}

test("#1732: a one-pixel change of the body width redraws the calendar", () => {
  const o = observer(1152, 639);
  o.bodyEl.clientWidth = 1151; // the day heads stack below 1152 px
  o.cb?.();
  assert.equal(o.draws, 1);
  assert.deepEqual({ ...o.size }, { bw: 1151, bh: 639 });
});

test("#1732: a one-pixel change of the body height redraws the calendar", () => {
  const o = observer(1070, 603);
  o.bodyEl.clientHeight = 604; // the hour rows scale with the height
  o.cb?.();
  assert.equal(o.draws, 1);
  assert.deepEqual({ ...o.size }, { bw: 1070, bh: 604 });
});

test("#1732: the observer stays quiet when the size did not change, so a redraw does not feed itself", () => {
  const o = observer(1070, 603);
  o.cb?.(); // the new body's first notification after a redraw
  o.cb?.();
  assert.equal(o.draws, 0);
  o.bodyEl.clientWidth = 0; // hidden: nothing to lay out
  o.cb?.();
  assert.equal(o.draws, 0);
});
