/** Ring view manager — owns everything the wheel does: layout state, the
 *  canvas decor (band, dividers, emblem, headline), the ring browser
 *  (drill in/out with the fan-out morph), the vault-image emblem, and the
 *  band hover/click hit-testing. `app.js` only orchestrates view switches
 *  and node-position transitions via the injected `startTransition`.
 *
 *  Factory per the module convention: stateful → createRingView(deps).
 *
 *  @param {object} deps
 *  @param {object} deps.sim              simulation (nodes, centers)
 *  @param {object} deps.renderer         canvas renderer (decor hook, flags)
 *  @param {() => object} deps.getInteractions  camera flights (lazy — created later)
 *  @param {object} deps.graph            graph payload (vault_name for the monogram)
 *  @param {() => Map} deps.getHues       active cluster→hue map
 *  @param {() => [string, string]} deps.getSatLight  theme HSL parts
 *  @param {() => string} deps.getStructureMode      "clusters" | "blocks"
 *  @param {(from: Map, to: Map) => void} deps.startTransition  node flight, no end-fit
 */
import { computeRingLayout } from "../ring-layout.js";
import { clusterColor } from "../graph-data.js";
import { easeFly, lerp } from "../utils/easing.js";
import { openImageCropper } from "../components/image-cropper.js";

const $ = (sel) => document.querySelector(sel);

/** Areas with more distinct subcategories than this get the instance mode:
 *  the wheel shows ONE instance (e.g. one project), a sidebar switcher flips
 *  between them. Few subcategories fan out directly. PROJECTS is exempt from
 *  the count: its instances ARE projects, so it always browses one at a time
 *  — otherwise the mode would flip under the user's feet when the number of
 *  project clusters crosses the threshold. */
const INSTANCE_THRESHOLD = 12;
const instanceMode = (key, instanceCount) =>
  instanceCount > INSTANCE_THRESHOLD || (key === "projects" && instanceCount > 1);

export function createRingView(deps) {
  let ring = null; // current computeRingLayout result
  let ringDrill = null; // group key while drilled into one area
  let drillState = null; // { mode: "direct"|"instance", area, instances?, active? }
  let instAnim = null; // instance switch crossfade { t0, ms, out, in }
  let bandAnim = null; // fan-out morph: { t0, ms, dir, key, overview, drill, outside }
  let bandHover = null; // band segment key under the cursor
  let headlineBounds = null; // world-space box of the drill headline (= back)
  let headlineHover = false; // cursor over the headline (back affordance)
  let headlineHoverT = 0; // eased 0..1 for the hover animation
  let emblemAlpha = 1; // eases down while a node is active, back up after

  // ── center emblems: the vault image, plus one per project instance
  // (stored openly as vault-image.<ext> inside the project's folder) ──
  const emblems = new Map(); // "" = vault root, otherwise the instance name
  function emblemFor(key) {
    let e = emblems.get(key);
    if (!e) {
      e = { img: new Image(), ok: false };
      e.img.onload = () => (e.ok = true);
      e.img.onerror = () => (e.ok = false);
      e.img.src = `/ui/vault-image?ts=${Date.now()}${key ? `&entity=${encodeURIComponent(key)}` : ""}`;
      emblems.set(key, e);
    }
    return e;
  }
  const activeEmblemKey = () => (drillState && drillState.mode === "instance" ? drillState.active : "");
  $("#vault-image-input").addEventListener("change", async () => {
    const file = $("#vault-image-input").files[0];
    $("#vault-image-input").value = "";
    if (!file) return;
    const key = activeEmblemKey();
    // frame first: zoom/pan in the circular cropper, upload the framed square
    const blob = await openImageCropper(file);
    if (!blob) return;
    const res = await fetch(`/ui/vault-image${key ? `?entity=${encodeURIComponent(key)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: blob,
    });
    if (res.ok) {
      emblems.delete(key);
      emblemFor(key);
    }
  });

  /** Text along a circle arc, centered on `mid`. World-space font size (the
   *  wheel is zoomable — text scales WITH the map so layout stays planable).
   *  Flips on the lower half; trims with an ellipsis only as a last resort
   *  (the band radius already grows so full names fit). */
  function drawArcText(ctx, camera, text, r, mid, maxArc, color, fontPx = 12, alpha = 1) {
    if (alpha <= 0.02) return;
    ctx.font = `700 ${fontPx}px "Avenir Next", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = alpha;
    const track = 1.3; // letterspacing on the arc
    const chars = [...text];
    const widths = chars.map((c) => ctx.measureText(c).width);
    let total = widths.reduce((s, w) => s + w, 0) * track;
    while (chars.length > 2 && total / r > maxArc) {
      chars.pop();
      widths.pop();
      chars[chars.length - 1] = "…";
      widths[widths.length - 1] = ctx.measureText("…").width;
      total = widths.reduce((s, w) => s + w, 0) * track;
    }
    if (total / r > maxArc) {
      ctx.globalAlpha = 1;
      ctx.textBaseline = "alphabetic";
      return;
    }
    const flip = Math.sin(mid) > 0; // bottom half: rotate to stay readable
    const dir = flip ? -1 : 1;
    let a = mid - (dir * total) / (2 * r);
    for (let k = 0; k < chars.length; k++) {
      const w = widths[k] * track;
      const ca = a + (dir * w) / (2 * r);
      ctx.save();
      ctx.translate(ring.center.x + Math.cos(ca) * r, ring.center.y + Math.sin(ca) * r);
      ctx.rotate(ca + (flip ? -Math.PI / 2 : Math.PI / 2));
      ctx.fillStyle = color;
      ctx.fillText(chars[k], 0, 0);
      ctx.restore();
      a += (dir * w) / r;
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = "alphabetic";
  }

  function decor(ctx, camera, theme, now, hasActive) {
    if (!ring) return;
    const { center } = ring;
    const [sat, light] = deps.getSatLight();
    const hues = deps.getHues();
    // fan-out progress: f = 0 → overview geometry, f = 1 → drill geometry
    let f = ring.headline ? 1 : 0;
    if (bandAnim) {
      const t = Math.min((now - bandAnim.t0) / bandAnim.ms, 1);
      const e = easeFly(t);
      f = bandAnim.dir === 1 ? e : 1 - e;
    }
    const geoA = bandAnim ? bandAnim.overview : ring;
    const geoB = bandAnim ? bandAnim.drill : ring;
    const bandRI = lerp(geoA.band.rInner, geoB.band.rInner, f);
    const bandRO = lerp(geoA.band.rOuter, geoB.band.rOuter, f);
    const bandMid = (bandRI + bandRO) / 2;

    // the emblem fades out with the rest when a node takes the stage
    const targetAlpha = hasActive ? Math.max(theme.dim, 0.15) : 1;
    emblemAlpha += (targetAlpha - emblemAlpha) * 0.12;

    // ── band annulus ──
    ctx.beginPath();
    ctx.arc(center.x, center.y, bandMid, 0, Math.PI * 2);
    ctx.lineWidth = bandRO - bandRI;
    ctx.strokeStyle = theme.band;
    ctx.stroke();
    ctx.lineWidth = 1 / camera.scale;
    ctx.strokeStyle = theme.bandBorder;
    for (const r of [bandRI, bandRO]) {
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // hover highlight: a gentle accent wash over the WHOLE band cell
    if (bandHover !== null && !bandAnim) {
      const seg = ring.segments.find((s) => s.key === bandHover);
      if (seg) {
        ctx.beginPath();
        ctx.arc(center.x, center.y, bandRO - 0.5, seg.b0 ?? seg.a0, seg.b1 ?? seg.a1);
        ctx.arc(center.x, center.y, bandRI + 0.5, seg.b1 ?? seg.a1, seg.b0 ?? seg.a0, true);
        ctx.closePath();
        ctx.fillStyle = theme.accentSoft;
        ctx.fill();
      }
    }

    // ── inner staggering ring ──
    ctx.strokeStyle = theme.bandBorder;
    ctx.lineWidth = 1 / camera.scale;
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.arc(center.x, center.y, center.rInnerRing, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    /** dividers (middle of each gap) + curved names for one segment list */
    const drawSegmentSet = (segs, alpha) => {
      if (alpha <= 0.02) return;
      ctx.strokeStyle = theme.bandBorder;
      ctx.lineWidth = 1 / camera.scale;
      for (let i = 0; i < segs.length; i++) {
        const cur = segs[i];
        const next = segs[(i + 1) % segs.length];
        const a = i === segs.length - 1 ? (cur.a1 + next.a0 + Math.PI * 2) / 2 : (cur.a1 + next.a0) / 2;
        ctx.globalAlpha = 0.65 * alpha;
        ctx.beginPath();
        ctx.moveTo(center.x + Math.cos(a) * center.rInnerRing, center.y + Math.sin(a) * center.rInnerRing);
        ctx.lineTo(center.x + Math.cos(a) * bandRO, center.y + Math.sin(a) * bandRO);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const seg of segs) {
        const mid = (seg.a0 + seg.a1) / 2;
        drawArcText(
          ctx,
          camera,
          seg.key.toUpperCase(),
          bandMid,
          mid,
          (seg.a1 - seg.a0) * 0.92,
          clusterColor(hues, seg.key, sat, light),
          12,
          alpha
        );
      }
    };

    if (!bandAnim) {
      drawSegmentSet(ring.segments, 1);
    } else {
      // ── the fan-out: the clicked segment widens across the whole rondel,
      // the others get squeezed out in place; then the subcategories fade in
      const ov = bandAnim.overview.segments;
      const focus = ov.find((s) => s.key === bandAnim.key) ?? ov[0];
      const span0 = focus.a1 - focus.a0;
      const TAUm = Math.PI * 2 - 0.002;
      const focusA0 = lerp(focus.a0, -Math.PI / 2, f);
      const focusSpan = lerp(span0, TAUm, f);
      const restScale = (Math.PI * 2 - focusSpan) / Math.max(Math.PI * 2 - span0, 0.001);
      const othersAlpha = Math.max(0, 1 - f * 1.8);
      // rebuild the shrinking overview ring, starting after the focus wedge
      const idx = ov.indexOf(focus);
      const morphed = [{ key: focus.key, a0: focusA0, a1: focusA0 + focusSpan }];
      let a = focusA0 + focusSpan;
      for (let k = 1; k < ov.length; k++) {
        const seg = ov[(idx + k) % ov.length];
        const w = (seg.a1 - seg.a0) * restScale;
        morphed.push({ key: seg.key, a0: a, a1: a + w });
        a += w;
      }
      // focus name rides its widening wedge, fading over to the sub-names
      drawSegmentSet(morphed.slice(1), othersAlpha);
      drawArcText(
        ctx,
        camera,
        focus.key.toUpperCase(),
        bandMid,
        focusA0 + focusSpan / 2,
        focusSpan * 0.92,
        clusterColor(hues, focus.key, sat, light),
        12,
        Math.max(0, 1 - f * 1.4)
      );
      const subAlpha = Math.max(0, (f - 0.55) / 0.45);
      drawSegmentSet(bandAnim.drill.segments, subAlpha);
    }

    // ── meta band (#216): the framing layer — rules + skills — as its own
    // outer ring around the content band. Drill layouts carry no metaBand,
    // so it fades with the rest during the fan-out (no radius lerp needed).
    const metaGeo = ring.metaBand ?? (bandAnim ? bandAnim.overview.metaBand : null);
    const metaAlpha = bandAnim ? Math.max(0, 1 - f * 1.8) : ring.metaBand ? 1 : 0;
    if (metaGeo && metaAlpha > 0.02) {
      const mMid = (metaGeo.rInner + metaGeo.rOuter) / 2;
      ctx.globalAlpha = metaAlpha;
      ctx.beginPath();
      ctx.arc(center.x, center.y, mMid, 0, Math.PI * 2);
      ctx.lineWidth = metaGeo.rOuter - metaGeo.rInner;
      ctx.strokeStyle = theme.band;
      ctx.stroke();
      ctx.lineWidth = 1 / camera.scale;
      ctx.strokeStyle = theme.bandBorder;
      for (const r of [metaGeo.rInner, metaGeo.rOuter]) {
        ctx.beginPath();
        ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const seg of metaGeo.segments) {
        const mid = (seg.a0 + seg.a1) / 2;
        drawArcText(
          ctx,
          camera,
          seg.key.toUpperCase(),
          mMid,
          mid,
          (seg.a1 - seg.a0) * 0.92,
          clusterColor(hues, seg.key, sat, light),
          11,
          metaAlpha
        );
      }
    }

    // ── unwritten orbit: kept clear of the band and its own nodes ──
    let maxOrbitR = bandRO;
    if (metaGeo && metaAlpha > 0.02) maxOrbitR = Math.max(maxOrbitR, metaGeo.rOuter);
    const orbitsNow = f > 0.5 ? geoB.orbits : geoA.orbits;
    for (const o of orbitsNow) {
      const or = lerp(
        geoA.orbits.find((x) => x.key === o.key)?.r ?? o.r,
        geoB.orbits.find((x) => x.key === o.key)?.r ?? o.r,
        f
      );
      maxOrbitR = Math.max(maxOrbitR, or);
      ctx.strokeStyle = theme.edge;
      ctx.lineWidth = 1 / camera.scale;
      if (o.dashed) ctx.setLineDash([4 / camera.scale, 5 / camera.scale]);
      ctx.beginPath();
      ctx.arc(center.x, center.y, or, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (o.key === "unwritten") {
        // well outside the orbit so it never covers nodes, and shifted
        // sideways whenever the drill headline owns the top spot
        drawArcText(ctx, camera, "UNWRITTEN", or + 26, -Math.PI / 2 + (ring.headline ? 0.55 : 0), 0.8, theme.label, 11);
      }
    }

    // ── drill headline: the area name at the top — click (or Esc) = back.
    // The chevron is DRAWN (not a glyph), so it centers exactly on the text
    // midline; on hover it slides left and everything tints accent — the
    // "this takes you back out" affordance.
    headlineHoverT += ((headlineHover ? 1 : 0) - headlineHoverT) * 0.18;
    if (ring.headline) {
      const headAlpha = bandAnim ? Math.max(0, (f - 0.6) / 0.4) : 1;
      if (headAlpha > 0.02) {
        const fontPx = 18;
        const text = ring.headline.toUpperCase();
        ctx.font = `700 ${fontPx}px "Avenir Next", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.globalAlpha = headAlpha;
        const ty = center.y - maxOrbitR - 34;
        const midY = ty - fontPx * 0.36; // optical midline of the uppercase text
        const color =
          headlineHoverT > 0.02
            ? `color-mix(in srgb, ${theme.accent} ${Math.round(headlineHoverT * 100)}%, ${theme.label})`
            : theme.label;
        ctx.lineWidth = 4;
        ctx.strokeStyle = theme.labelHalo;
        ctx.strokeText(text, center.x, ty);
        ctx.fillStyle = color;
        ctx.fillText(text, center.x, ty);
        const w = ctx.measureText(text).width;
        // chevron, vertically centered on the text midline, sliding on hover
        const chevX = center.x - w / 2 - 18 - headlineHoverT * 5;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(chevX + 7, midY - 7);
        ctx.lineTo(chevX, midY);
        ctx.lineTo(chevX + 7, midY + 7);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const pad = 10;
        headlineBounds = {
          x: chevX - pad,
          y: ty - fontPx - pad,
          w: w / 2 + (center.x - chevX) + pad * 2,
          h: fontPx + pad * 2,
        };
      }
    } else {
      headlineBounds = null;
    }

    // ── center disc with emblem or monogram ──
    ctx.globalAlpha = emblemAlpha;
    ctx.fillStyle = theme.labelHalo;
    ctx.beginPath();
    ctx.arc(center.x, center.y, center.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = theme.edgeHi;
    ctx.lineWidth = 1.6 / camera.scale;
    ctx.stroke();
    const em = emblemFor(activeEmblemKey());
    if (em.ok) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(center.x, center.y, center.r - 5, 0, Math.PI * 2);
      ctx.clip();
      // cover fit — non-square uploads must not distort
      const d = (center.r - 5) * 2;
      const s = Math.max(d / em.img.naturalWidth, d / em.img.naturalHeight);
      ctx.drawImage(
        em.img,
        center.x - (em.img.naturalWidth * s) / 2,
        center.y - (em.img.naturalHeight * s) / 2,
        em.img.naturalWidth * s,
        em.img.naturalHeight * s
      );
      ctx.restore();
    } else {
      const initials = (activeEmblemKey() || deps.graph.vault_name || "V")
        .split(/\s+/)
        .map((w) => w[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();
      ctx.font = `700 ${center.r * 0.62}px "Avenir Next", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = theme.label;
      ctx.fillText(initials, center.x, center.y + 2);
      ctx.textBaseline = "alphabetic";
    }
    ctx.globalAlpha = 1;
  }

  // ── hit testing ───────────────────────────────────────────────────
  function bandSegmentAt(wx, wy) {
    if (!ring) return null;
    const dx = wx - ring.center.x;
    const dy = wy - ring.center.y;
    const r = Math.hypot(dx, dy);
    if (r < ring.band.rInner - 4 || r > ring.band.rOuter + 4) return null;
    let a = Math.atan2(dy, dx);
    while (a < -Math.PI / 2 - 0.02) a += Math.PI * 2;
    return ring.segments.find((s) => a >= (s.b0 ?? s.a0) && a <= (s.b1 ?? s.a1)) ?? null;
  }

  const inHeadline = (w) =>
    headlineBounds !== null &&
    w.x >= headlineBounds.x &&
    w.x <= headlineBounds.x + headlineBounds.w &&
    w.y >= headlineBounds.y &&
    w.y <= headlineBounds.y + headlineBounds.h;

  /** Camera glides along with any ring re-layout so the wheel keeps its
   *  on-screen size while the content scales — no end-of-animation snap. */
  function flyToRing(layout) {
    const R = layout.outerRadius + 70; // headline breathing room
    const c = layout.center;
    deps.getInteractions().flyToBounds(
      [
        { x: c.x - R, y: c.y - R },
        { x: c.x + R, y: c.y + R },
      ],
      { padding: 30, maxScale: 8, ms: 950 }
    );
  }

  // ── ring browser ──────────────────────────────────────────────────
  const activeInstanceKey = (area) => `bastra-vault-map-drill-active:${area}`;

  /** Segment rule inside a drill: prefer the level with more distinct keys —
   *  sub-areas (project areas, knowledge domains) over instance names. */
  const drillKeyOf = (members) => {
    const bases = new Set(members.map((n) => n.baseCluster));
    const subs = new Set(members.map((n) => n.sub ?? "general"));
    return subs.size > bases.size ? (n) => n.sub ?? "general" : (n) => n.baseCluster;
  };

  /** An area is drillable only when the drill would actually show MORE
   *  structure — many instances, or at least two distinct sub-segments.
   *  PEOPLE with seven flat memos gets no pointless zoom-in. */
  function canDrill(key) {
    const areaNodes = deps.sim.nodes.filter((n) => n.cluster === key);
    const instances = new Set(areaNodes.map((n) => n.baseCluster));
    if (instanceMode(key, instances.size)) return true;
    const keyOf = drillKeyOf(areaNodes);
    return new Set(areaNodes.map(keyOf)).size > 1;
  }

  function drillInto(key) {
    if (bandAnim || ringDrill) return;
    ringDrill = key;
    bandHover = null;
    const overview = ring;
    const areaNodes = deps.sim.nodes.filter((n) => n.cluster === key);
    const instanceNames = [...new Set(areaNodes.map((n) => n.baseCluster))];
    let inside = areaNodes;
    let drill;
    if (instanceMode(key, instanceNames.length)) {
      // instance mode: the wheel shows ONE instance, segmented by sub-areas;
      // the sidebar switcher (rendered via onDrillChange) flips instances
      const counts = new Map();
      for (const n of areaNodes) counts.set(n.baseCluster, (counts.get(n.baseCluster) ?? 0) + 1);
      const instances = [...counts]
        .map(([k, count]) => ({ key: k, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
      const remembered = localStorage.getItem(activeInstanceKey(key));
      const active = instances.some((i) => i.key === remembered) ? remembered : instances[0].key;
      inside = areaNodes.filter((n) => n.baseCluster === active);
      const keyOf = (n) => n.sub ?? "general";
      drill = computeRingLayout(inside, innerWidth, innerHeight, { keyOf, headline: active });
      drillState = { mode: "instance", area: key, instances, active, matchKey: keyOf };
    } else {
      const keyOf = drillKeyOf(areaNodes);
      drill = computeRingLayout(inside, innerWidth, innerHeight, { keyOf, headline: key });
      drillState = { mode: "direct", area: key, matchKey: keyOf };
    }
    // segment list with counts — the sidebar legend/signals focus on these
    {
      const counts = new Map();
      for (const n of inside) counts.set(drillState.matchKey(n), (counts.get(drillState.matchKey(n)) ?? 0) + 1);
      drillState.segments = drill.segments.map((sg) => ({ key: sg.key, count: counts.get(sg.key) ?? 0 }));
    }
    const insideSet = new Set(inside);
    const outside = deps.sim.nodes.filter((n) => !insideSet.has(n));
    ring = drill;
    // the area's own nodes glide to their fanned-out spots; everyone else
    // fades away IN PLACE while the band widens — nothing flies off-screen
    const from = new Map(inside.map((n) => [n.id, { x: n.x, y: n.y }]));
    deps.startTransition(from, drill.positions);
    bandAnim = { t0: performance.now(), ms: 950, dir: 1, key, overview, drill, outside };
    flyToRing(drill);
    deps.onDrillChange?.(drillState);
  }

  /** Instance mode: flip the wheel to another instance — the old one fades
   *  out in place, the new one fades in already seated in its segments. */
  function switchInstance(name) {
    if (!drillState || drillState.mode !== "instance" || bandAnim || instAnim) return;
    if (name === drillState.active) return;
    const area = drillState.area;
    const out = deps.sim.nodes.filter((n) => !n.ringHidden);
    const next = deps.sim.nodes.filter((n) => n.cluster === area && n.baseCluster === name);
    const keyOf = (n) => n.sub ?? "general";
    const layout = computeRingLayout(next, innerWidth, innerHeight, { keyOf, headline: name });
    ring = layout;
    const counts = new Map();
    for (const n of next) counts.set(keyOf(n), (counts.get(keyOf(n)) ?? 0) + 1);
    drillState = {
      ...drillState,
      active: name,
      matchKey: keyOf,
      segments: layout.segments.map((sg) => ({ key: sg.key, count: counts.get(sg.key) ?? 0 })),
    };
    localStorage.setItem(activeInstanceKey(area), name);
    for (const n of next) {
      const p = layout.positions.get(n.id);
      if (p) {
        n.x = p.x;
        n.y = p.y;
      }
      delete n.ringHidden;
      n.ringFade = 0;
    }
    instAnim = { t0: performance.now(), ms: 450, out, in: next };
    flyToRing(layout);
    deps.onDrillChange?.(drillState);
  }

  function drillOut() {
    if (bandAnim || instAnim || !ringDrill) return;
    const key = ringDrill;
    ringDrill = null;
    drillState = null;
    deps.onDrillChange?.(null);
    headlineBounds = null;
    const drillLayout = ring;
    const overview = computeRingLayout(deps.sim.nodes, innerWidth, innerHeight);
    ring = overview;
    const inside = deps.sim.nodes.filter((n) => !n.ringHidden);
    const outside = deps.sim.nodes.filter((n) => n.ringHidden);
    // hidden areas reappear at their overview spots, fading back in
    for (const n of outside) {
      const p = overview.positions.get(n.id);
      if (p) {
        n.x = p.x;
        n.y = p.y;
      }
      delete n.ringHidden;
      n.ringFade = 0;
    }
    const from = new Map(inside.map((n) => [n.id, { x: n.x, y: n.y }]));
    deps.startTransition(from, overview.positions);
    bandAnim = { t0: performance.now(), ms: 950, dir: -1, key, overview, drill: drillLayout, outside };
    flyToRing(overview);
  }

  // ── lifecycle ─────────────────────────────────────────────────────
  /** Enter the ring view: compute the wheel, arm decor/flags, glide camera.
   *  Returns the node target positions for the caller's transition. */
  function enter() {
    ring = computeRingLayout(deps.sim.nodes, innerWidth, innerHeight);
    for (const [key, c] of deps.sim.centers) {
      const rc = ring.centers.get(key);
      if (rc) {
        c.x = rc.x;
        c.y = rc.y;
      }
    }
    deps.renderer.setDecor(decor);
    deps.renderer.setQuietEdges(true); // ring: strands only on hover/focus
    deps.renderer.setBendCenter(ring.center); // chords bow toward the hub
    deps.renderer.setClusterLabelsVisible(false); // names live in the band
    $("#ring-hint").hidden = false;
    flyToRing(ring);
    return ring.positions;
  }

  /** Leave the ring view: clear decor/flags and every per-node ring state. */
  function exit() {
    ring = null;
    ringDrill = null;
    drillState = null;
    deps.onDrillChange?.(null);
    bandAnim = null;
    instAnim = null;
    bandHover = null;
    headlineBounds = null;
    deps.renderer.setDecor(null);
    deps.renderer.setQuietEdges(false);
    deps.renderer.setBendCenter(null);
    deps.renderer.setClusterLabelsVisible(true);
    $("#ring-hint").hidden = true;
    for (const c of deps.sim.centers.values()) delete c.ly;
    for (const n of deps.sim.nodes) {
      delete n.ringScale; // full size in the clouds
      delete n.ringHidden; // ring browser state ends with the ring
      delete n.ringFade;
    }
  }

  /** Structure mode changed while the ring is showing: reset any drill and
   *  recompute the whole wheel. Returns {from, to} for the caller's flight. */
  function refreshForStructure() {
    ringDrill = null;
    drillState = null;
    deps.onDrillChange?.(null);
    bandAnim = null;
    instAnim = null;
    headlineBounds = null;
    for (const n of deps.sim.nodes) delete n.ringHidden;
    const from = new Map(deps.sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    ring = computeRingLayout(deps.sim.nodes, innerWidth, innerHeight);
    for (const [key, c] of deps.sim.centers) {
      const rc = ring.centers.get(key);
      if (rc) {
        c.x = rc.x;
        c.y = rc.y;
      }
    }
    flyToRing(ring);
    return { from, to: ring.positions };
  }

  /** Per-frame: advance the fan-out crossfade (non-drilled areas dissolve
   *  or reappear in place). */
  function tick(now) {
    if (instAnim) {
      const t = Math.min((now - instAnim.t0) / instAnim.ms, 1);
      for (const n of instAnim.out) n.ringFade = 1 - t;
      for (const n of instAnim.in) n.ringFade = t;
      if (t >= 1) {
        for (const n of instAnim.out) {
          n.ringHidden = true;
          delete n.ringFade;
        }
        for (const n of instAnim.in) delete n.ringFade;
        instAnim = null;
      }
    }
    if (!bandAnim) return;
    const t = Math.min((now - bandAnim.t0) / bandAnim.ms, 1);
    const f = bandAnim.dir === 1 ? easeFly(t) : 1 - easeFly(t);
    for (const n of bandAnim.outside) n.ringFade = 1 - Math.min(f / 0.5, 1);
    if (t >= 1) {
      for (const n of bandAnim.outside) {
        if (bandAnim.dir === 1) n.ringHidden = true;
        delete n.ringFade;
      }
      bandAnim = null;
    }
  }

  /** World-space click: headline = back, center = image picker, band = drill.
   *  Returns true when the click was consumed. */
  function handleClick(w) {
    if (!ring) return false;
    if (inHeadline(w)) {
      drillOut();
      return true;
    }
    if (Math.hypot(w.x - ring.center.x, w.y - ring.center.y) <= ring.center.r) {
      $("#vault-image-input").click();
      return true;
    }
    const seg = bandSegmentAt(w.x, w.y);
    if (seg && !ringDrill && deps.getStructureMode() === "blocks" && canDrill(seg.key)) {
      drillInto(seg.key);
      return true;
    }
    return false;
  }

  /** World-space hover: maintains the band highlight; true = show pointer. */
  function updateHover(w) {
    if (!ring) return false;
    const seg = !ringDrill && deps.getStructureMode() === "blocks" ? bandSegmentAt(w.x, w.y) : null;
    const drillable = seg !== null && canDrill(seg.key);
    bandHover = drillable ? seg.key : null; // no highlight where a click does nothing
    headlineHover = inHeadline(w);
    return drillable || headlineHover || Math.hypot(w.x - ring.center.x, w.y - ring.center.y) <= ring.center.r;
  }

  return {
    enter,
    exit,
    refreshForStructure,
    tick,
    handleClick,
    updateHover,
    drillOut,
    switchInstance,
    isDrilled: () => ringDrill !== null,
    isAnimating: () => bandAnim !== null || instAnim !== null,
    clearHover: () => (bandHover = null),
  };
}
