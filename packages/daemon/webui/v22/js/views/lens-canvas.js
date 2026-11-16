// Lens canvas — mountLens() from the prototype's memory-lenses.js: view
// transform with tweened zoom/pan, hit testing, hover tooltip, selection
// marker and click pulse. The tooltip is built from classes (views.css);
// dynamic values go through CSSOM only (CSP style-src 'self').
// Additions: onFrame (cards and marks follow zoom/pan), screenOf(id),
// onHoverArea (couples canvas hover with the Areas list).
import { h, setVars } from "../dom.js";
import { t as tr } from "../i18n.js";
import { TC, ACC, INK } from "./chrome.js";
import { VIEWS, prep, rgba, dstr } from "./lens-draw.js";

const ease = (x) => 1 - Math.pow(1 - x, 3);
const TAU = Math.PI * 2;

export function mountLens(canvas, opts) {
  let o = { ...opts },
    P = null,
    Pv = null,
    w = 0,
    h0 = 0,
    dpr = 1,
    t0 = performance.now(),
    prog = 0,
    raf = 0,
    hov = null,
    pts = [],
    regs = [],
    dead = false;
  let z = 1,
    tx = 0,
    ty = 0,
    Z = 1,
    TX = 0,
    TY = 0,
    sel = null,
    fx = [],
    drag = null,
    lastZ = -1,
    openT = 0,
    resync = false;
  const ZMIN = 1,
    ZMAX = 6;
  const clampT = (zz, x, y) => [Math.min(0, Math.max(w - w * zz, x)), Math.min(0, Math.max(h0 - h0 * zz, y))];
  const aim = (zz, x, y) => {
    Z = Math.max(ZMIN, Math.min(ZMAX, zz));
    [TX, TY] = clampT(Z, x, y);
    req();
  };
  const zoomAt = (f, sx, sy) => {
    const nz = Math.max(ZMIN, Math.min(ZMAX, Z * f)),
      wx = (sx - TX) / Z,
      wy = (sy - TY) / Z;
    aim(nz, sx - wx * nz, sy - wy * nz);
  };
  const focusOn = (wx, wy, zz) => aim(zz, w / 2 - wx * zz, h0 / 2 - wy * zz);
  const ctx = canvas.getContext("2d"),
    host = canvas.parentElement;
  const tip = h("div.ltip");
  host.appendChild(tip);

  function showTip(hit, mx, my) {
    tip.replaceChildren();
    if (hit.m) {
      const m = hit.m,
        c = TC[m.cls] || INK;
      tip.append(
        h(
          "div.ltip__top",
          null,
          h("span.ltip__chip", { text: tr(`vv.cls.${m.cls}`), vars: { "--tc": c } }),
          h("span.ltip__m", { text: m.area })
        ),
        h("div.ltip__t", { text: m.title }),
        h("div.ltip__m", {
          text: `${dstr(hit.d)} · ${tr("vv.recalledN", { n: m.recalled })} · ${tr("vv.linksN", { n: m.links.length })}`,
        }),
        h("div.ltip__m.ltip__hint", { text: tr("vv.lens.open") })
      );
    } else if (hit.day != null) {
      tip.append(
        h("div.ltip__t.ltip__t--day", { text: dstr(hit.day) }),
        h("div.ltip__m.ltip__sub", { text: tr("vv.lens.dayStats", { c: hit.created, r: hit.updated }) })
      );
      hit.items
        .slice(0, 4)
        .forEach((x) =>
          tip.append(
            h(
              "div.ltip__row",
              null,
              h("span.ltip__dot", { vars: { "--tc": TC[x.m.cls] || INK } }),
              h("span.ltip__rt", { text: x.m.title })
            )
          )
        );
      if (hit.items.length > 4)
        tip.append(h("div.ltip__m.ltip__more", { text: tr("vv.lens.more", { n: hit.items.length - 4 }) }));
      if (hit.items.length) tip.append(h("div.ltip__m.ltip__hint", { text: tr("vv.lens.openFirst") }));
    } else
      tip.append(
        h("div.ltip__t.ltip__t--day", { text: hit.title }),
        h("div.ltip__m", { text: hit.sub }),
        h("div.ltip__m.ltip__hint", { text: o.focus === hit.area ? tr("vv.lens.clearFocus") : hit.hint })
      );
    const hb = host.getBoundingClientRect(),
      tw = tip.offsetWidth || 240,
      th = tip.offsetHeight || 80;
    let x = mx + 16,
      y = my + 16;
    if (x + tw > hb.width - 8) x = mx - tw - 16;
    if (y + th > hb.height - 8) y = my - th - 16;
    setVars(tip, { "--x": `${Math.max(8, x)}px`, "--y": `${Math.max(8, y)}px` });
    tip.classList.add("is-on");
  }
  const hideTip = () => tip.classList.remove("is-on");
  const resize = () => {
    const b = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, b.width);
    h0 = Math.max(1, b.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h0 * dpr);
    [TX, TY] = clampT(Z, TX, TY);
    tx = TX;
    ty = TY;
    req();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  function req() {
    if (!raf && !dead) raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    raf = 0;
    if (dead) return;
    prog = Math.min(1, (now - t0) / 1100);
    const k = drag ? 1 : 0.22;
    z += (Z - z) * k;
    tx += (TX - tx) * k;
    ty += (TY - ty) * k;
    const moving = Math.abs(Z - z) > 0.001 || Math.abs(TX - tx) > 0.2 || Math.abs(TY - ty) > 0.2;
    if (!moving) {
      z = Z;
      tx = TX;
      ty = TY;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h0);
    pts = [];
    regs = [];
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * tx, dpr * ty);
    if (P && VIEWS[o.kind])
      VIEWS[o.kind]({
        ctx,
        w,
        h: h0,
        P,
        o,
        t: ease(prog),
        hov,
        pt: (x, y, r, d) => pts.push([x, y, r, d]),
        reg: (test, d) => regs.push([test, d]),
      });
    // after new data the selected memory may sit elsewhere (Chronos: a longer needle)
    if (resync) {
      resync = false;
      const p = sel && findPt(sel.id);
      if (p) {
        sel.x = p[0];
        sel.y = p[1];
        sel.r = p[2] || 3;
      }
    }
    const px = 1 / z;
    if (sel) {
      const s = 7 * px + sel.r,
        a = 4 * px;
      ctx.strokeStyle = ACC;
      ctx.lineWidth = 1.5 * px;
      ctx.shadowColor = ACC;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].forEach(([sx, sy]) => {
        ctx.moveTo(sel.x + sx * s, sel.y + sy * (s - a));
        ctx.lineTo(sel.x + sx * s, sel.y + sy * s);
        ctx.lineTo(sel.x + sx * (s - a), sel.y + sy * s);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    fx = fx.filter((f) => now - f.t < 720);
    fx.forEach((f) => {
      const u = (now - f.t) / 720;
      for (let i = 0; i < 2; i++) {
        const v = Math.max(0, u - i * 0.18) / (1 - i * 0.18);
        if (v <= 0) continue;
        const e = 1 - Math.pow(1 - v, 3);
        ctx.strokeStyle = rgba(f.c, (1 - v) * 0.9);
        ctx.lineWidth = (1.6 - i * 0.6) * px;
        ctx.beginPath();
        ctx.arc(f.x, f.y, (f.r + e * 34) * px, 0, TAU);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(f.c, 0.35 * (1 - u));
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r + 2, 0, TAU);
      ctx.fill();
    });
    if (o.onZoom && Math.round(Z * 100) !== lastZ) {
      lastZ = Math.round(Z * 100);
      o.onZoom(lastZ);
    }
    o.onFrame && o.onFrame();
    if (prog < 1 || moving || fx.length) req();
  }
  const toW = (x, y) => [(x - tx) / z, (y - ty) / z];
  function hitAt(x, y) {
    let best = null,
      bd = 1e9;
    const [wx, wy] = toW(x, y),
      slack = 2 / z;
    for (const [px, py, r, d] of pts) {
      const dd = Math.hypot(px - wx, py - wy);
      if (dd <= r + slack && dd < bd) {
        bd = dd;
        best = { ...d, _x: px, _y: py, _r: r };
      }
    }
    if (best) return best;
    for (const [test, d] of regs) if (test(wx, wy)) return { ...d, _x: wx, _y: wy, _r: 3 };
    return null;
  }
  const setHov = (hit) => {
    const was = hov && hov.area && !hov.m ? hov.area : null,
      now = hit && hit.area && !hit.m ? hit.area : null;
    hov = hit;
    req();
    if (was !== now && o.onHoverArea) o.onHoverArea(now);
  };
  const onMove = (e) => {
    const b = canvas.getBoundingClientRect(),
      x = e.clientX - b.left,
      y = e.clientY - b.top;
    if (drag) {
      if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) > 4) {
        drag.moved = true;
        hideTip();
        setHov(null);
        canvas.dataset.cur = "grabbing";
      }
      if (drag.moved) {
        [TX, TY] = clampT(Z, drag.tx + x - drag.x, drag.ty + y - drag.y);
        tx = TX;
        ty = TY;
        req();
      }
      return;
    }
    const hit = hitAt(x, y);
    canvas.dataset.cur = hit ? "pointer" : Z > 1.001 ? "grab" : "";
    if ((hit && hit.key) !== (hov && hov.key)) setHov(hit);
    if (hit) showTip(hit, x, y);
    else hideTip();
  };
  const onLeave = () => {
    hideTip();
    if (hov) setHov(null);
  };
  const onClick = () => {
    if (drag && drag.moved) {
      drag = null;
      return;
    }
    drag = null;
    if (!hov) return;
    const h1 = hov,
      now = performance.now();
    const id = h1.m ? h1.m.id : h1.items && h1.items.length ? h1.items[0].m.id : null;
    if (id) {
      sel = { x: h1._x, y: h1._y, r: h1._r || 3, id };
      fx.push({ x: h1._x, y: h1._y, r: h1._r || 3, c: TC[(h1.m || h1.items[0].m).cls] || ACC, t: now });
      hideTip();
      focusOn(h1._x, h1._y, Math.max(Z, 2.4));
      req();
      clearTimeout(openT);
      openT = setTimeout(() => {
        if (!dead) o.onOpen && o.onOpen(id);
      }, 430);
    } else if (h1.area) {
      fx.push({ x: h1._x, y: h1._y, r: 4, c: ACC, t: now });
      req();
      o.onArea && o.onArea(h1.area);
    }
  };
  const onDown = (e) => {
    if (e.button !== 0) return;
    const b = canvas.getBoundingClientRect();
    drag = { x: e.clientX - b.left, y: e.clientY - b.top, tx: TX, ty: TY, moved: false };
    if (Z > 1.001) canvas.setPointerCapture?.(e.pointerId);
  };
  const onUp = () => {
    if (drag && drag.moved) {
      canvas.dataset.cur = Z > 1.001 ? "grab" : "";
      setTimeout(() => {
        drag = null;
      }, 0);
    }
  };
  const onWheel = (e) => {
    e.preventDefault();
    const b = canvas.getBoundingClientRect();
    hideTip();
    zoomAt(Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.0025), e.clientX - b.left, e.clientY - b.top);
  };
  const onDbl = (e) => {
    const b = canvas.getBoundingClientRect(),
      x = e.clientX - b.left,
      y = e.clientY - b.top;
    if (Z > 1.05) aim(1, 0, 0);
    else zoomAt(2.2, x, y);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDbl);
  function update(n) {
    const kindChanged = n.kind && n.kind !== o.kind;
    const changed =
      kindChanged || n.focus !== o.focus || n.hoverArea !== o.hoverArea || (n.vault && n.vault !== Pv) || !P;
    const focusChanged = n.focus !== undefined && n.focus !== o.focus;
    o = { ...o, ...n };
    // New data swaps in place. The entrance sweep plays for the first data and
    // when asked (footer range change, as in the prototype) — not for a live
    // vault update, which keeps zoom, pan, hover and selection as they are.
    if (n.vault && n.vault !== Pv) {
      if (!P || n.replay) t0 = performance.now();
      Pv = n.vault;
      P = prep(n.vault);
      resync = true;
    }
    if (kindChanged) {
      t0 = performance.now();
      hov = null;
      hideTip();
      sel = null;
      fx = [];
      Z = z = 1;
      TX = tx = TY = ty = 0;
    }
    if (focusChanged) sel = null;
    if (changed) req();
  }
  update(opts);
  resize();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(req);
  // a memory's own dot, else the day dot that holds it (Chronos)
  function findPt(id) {
    return (
      pts.find(([, , , d]) => d && d.m && d.m.id === id) ||
      pts.find(([, , , d]) => d && Array.isArray(d.items) && d.items.some((x) => x.m && x.m.id === id))
    );
  }
  const scr = (x, y) => [x * z + tx, y * z + ty];
  const vault0 = (id) => {
    for (const [, , , d] of pts) {
      if (d?.m?.id === id) return d.m;
      const it = Array.isArray(d?.items) && d.items.find((x) => x.m && x.m.id === id);
      if (it) return it.m;
    }
    return null;
  };
  return {
    update,
    zoomBy(f) {
      zoomAt(f, w / 2, h0 / 2);
    },
    reset() {
      sel = null;
      aim(1, 0, 0);
    },
    /** Open a memory as a click on it would (mark, glide, onOpen); false when it is not drawn. */
    open(id) {
      const p = findPt(id);
      if (!p) return false;
      const [x, y, r] = p,
        m = vault0(id);
      sel = { x, y, r: r || 3, id };
      fx.push({ x, y, r: r || 3, c: (m && TC[m.cls]) || ACC, t: performance.now() });
      focusOn(x, y, Math.max(Z, 2.4));
      req();
      clearTimeout(openT);
      openT = setTimeout(() => {
        if (!dead) o.onOpen && o.onOpen(id);
      }, 430);
      return true;
    },
    /** Screen position of the selection marker, or null. */
    selScreen() {
      return sel ? [...scr(sel.x, sel.y), sel.id] : null;
    },
    /** Screen position of a memory drawn in the last frame, or null. */
    screenOf(id) {
      for (const [x, y, , d] of pts) if (d.m && d.m.id === id) return scr(x, y);
      return null;
    },
    destroy() {
      dead = true;
      clearTimeout(openT);
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDbl);
      tip.remove();
    },
  };
}
