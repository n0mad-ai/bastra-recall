/** Orbit decor (#216/#217) — the universe's backdrop, split out of
 *  orbit-view.js: starfield (shell + drifters, twinkle), the shooting star,
 *  galaxy glows + nebulae + labels, solar-system rings, the galactic mode's
 *  orbit guides + black-hole core, and the opt-in weather layer (#217: rain
 *  streaks, distant thunder, cloud/fog haze — see managers/weather.js). Pure
 *  drawing: all view state arrives through the env getters, geometry helpers
 *  are passed in from the view (they close over its camera state). */

import { clusterColor, glowSprite } from "../graph-data.js";
import { rnd } from "./orbit-galaxy.js";
import { coreOf } from "./orbit-core.js";

const SHOOTING_EVERY = 24000;

// Weather layer (#217): the user's local weather modulates the backdrop. Every
// value here is deliberately small — the brief was "really, really subtle". It
// should register that something changed without the viewer being able to name
// what. Whoever looks at this map is working; they are not watching.
// First pass sat so far under the threshold that the layer was not readable at
// all — "subtle" had turned into "invisible". These values are the second pass:
// still ambient, but you can now tell rain from clear without being told.
const RAIN_STREAKS_MAX = 11; // concurrent rain streaks in steady rain
const RAIN_ALPHA = 0.26; // still half the real shooting star (0.5)
const THUNDER_EVERY = 8000; // base interval between two sheet-lightning flashes
const THUNDER_ALPHA = 0.1; // full-screen lift — visible, not blinding
const HAZE_BANDS = 13; // cloud/fog banks drifting through the volume
const HAZE_ALPHA = 0.085; // the dial that carries most of the "weathery" feel

/** @param {object} env  getters + geometry helpers from createOrbitView */
export function createOrbitDecor(env) {
  const {
    project,
    trigNow,
    inPlane,
    add,
    scale3,
    norm,
    depthScale,
    depthFade,
    frontFade,
    viewRect,
    inView,
    getSatLight,
    getHues,
  } = env;

  return function decor(ctx, camera, theme, now) {
    const universe = env.getUniverse();
    if (!universe) return;
    const stars = env.getStars();
    const hole = env.getHole();
    const orbitRings = env.getOrbitRings();
    const mode = env.getMode();
    const enterAt = env.getEnterAt();
    const R = env.getR();

    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const trig = trigNow();
    const tSec = now / 1000;
    const [sat, light] = getSatLight();
    const hues = getHues();
    // the whole backdrop eases in with the entry flight — no frame-1 pop
    const fadeIn = Math.min((now - enterAt) / 950, 1);
    const view = viewRect(120 / camera.scale);

    // starfield — culled, twinkling brights, screen-constant sizes
    ctx.fillStyle = theme.label;
    for (const s of stars) {
      const pr = project(s, trig, cx, cy);
      if (!inView(view, pr.x, pr.y)) continue;
      const r = s.size / camera.scale;
      const twinkle = s.bright ? 0.75 + 0.25 * Math.sin(tSec * 2.1 + s.tw) : 1;
      ctx.globalAlpha = s.alpha * twinkle * (pr.d > 0 ? 0.55 : 1) * frontFade(pr.d) * fadeIn;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, s.bright ? r * 1.8 : r, 0, Math.PI * 2);
      ctx.fill();
      if (s.bright) {
        ctx.globalAlpha *= 0.4;
        ctx.lineWidth = 0.6 / camera.scale;
        ctx.strokeStyle = theme.label;
        const g = 5 / camera.scale;
        ctx.beginPath();
        ctx.moveTo(pr.x - g, pr.y);
        ctx.lineTo(pr.x + g, pr.y);
        ctx.moveTo(pr.x, pr.y - g);
        ctx.lineTo(pr.x, pr.y + g);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // ── Weather (#217) — only if the user switched it on; otherwise all four
    // dials are 0 and the three blocks below fall straight through.
    const wx = env.getWeather() ?? { rain: 0, thunder: 0, clouds: 0, fog: 0 };

    // Clouds + fog: ONE shared bank layer. Two separate systems would not be
    // tellable apart against a starfield — clouds are the large, faster banks
    // here, fog the dense ground veil.
    const haze = Math.min(wx.clouds * 0.7 + wx.fog, 1);
    if (haze > 0.02) {
      ctx.globalCompositeOperation = theme.flowBlend;
      for (let i = 0; i < HAZE_BANDS; i++) {
        const drift = tSec * (0.004 + rnd(i, 191) * 0.006) + rnd(i, 193) * Math.PI * 2;
        const p = {
          px: Math.cos(drift) * R * (0.6 + rnd(i, 197) * 0.9),
          py: (rnd(i, 199) - 0.5) * R * 0.7,
          pz: Math.sin(drift) * R * (0.6 + rnd(i, 211) * 0.9),
        };
        const pr = project(p, trig, cx, cy);
        if (!inView(view, pr.x, pr.y)) continue;
        const br = R * (0.28 + rnd(i, 223) * 0.3) * depthScale(pr) * (1 + wx.clouds * 0.4);
        ctx.globalAlpha = HAZE_ALPHA * haze * depthFade(pr.d) * fadeIn;
        ctx.drawImage(glowSprite(theme.label), pr.x - br, pr.y - br, br * 2, br * 2);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }

    // Thunderstorm: NO forked lightning. Zigzags belong to the activity bolts
    // at the nodes (renderer.js) — a second zigzag effect would be exactly the
    // confusion you can never unsee. A storm here is distant sheet lightning:
    // the sky brightens for a moment, the source stays off-frame.
    if (wx.thunder > 0.02) {
      const every = THUNDER_EVERY / (0.5 + wx.thunder);
      const epoch = Math.floor(now / every);
      const t = (now % every) / every;
      // two flickers in quick succession — a single flash reads as a rendering
      // glitch, the double reads as a storm
      const flash = t < 0.03 ? 1 - t / 0.03 : t > 0.08 && t < 0.1 ? 0.5 : 0;
      if (flash > 0 && rnd(epoch, 227) < 0.55 + wx.thunder * 0.4) {
        ctx.globalAlpha = THUNDER_ALPHA * flash * wx.thunder * fadeIn;
        ctx.fillStyle = theme.label;
        ctx.fillRect(view.l, view.t, view.r - view.l, view.b - view.t);
        ctx.globalAlpha = 1;
      }
    }

    // Rain: the existing shooting star is NOT clocked faster — it stays the
    // rare event. Rain is its OWN layer of short, pale streaks that all fall
    // roughly the same way.
    const streaks = Math.round(wx.rain * RAIN_STREAKS_MAX);
    for (let i = 0; i < streaks; i++) {
      const period = 1400 + rnd(i, 229) * 900;
      const epoch = Math.floor(now / period) + i * 17;
      const p = (now % period) / period;
      const s0 = {
        px: (rnd(epoch, 233) - 0.5) * R * 2.4,
        py: R * 0.9,
        pz: (rnd(epoch, 239) - 0.5) * R * 2.4,
      };
      const fall = R * 0.5;
      const head = { ...s0, py: s0.py - p * fall };
      const tail = { ...s0, py: s0.py - Math.max(p - 0.16, 0) * fall };
      const a = project(head, trig, cx, cy);
      const b = project(tail, trig, cx, cy);
      if (!inView(view, a.x, a.y)) continue;
      ctx.globalAlpha = RAIN_ALPHA * Math.sin(p * Math.PI) * wx.rain * fadeIn;
      ctx.strokeStyle = theme.label;
      ctx.lineWidth = 0.7 / camera.scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // one shooting star every ~24 s
    {
      const epoch = Math.floor(now / SHOOTING_EVERY);
      const t = (now % SHOOTING_EVERY) / SHOOTING_EVERY;
      if (t < 0.055) {
        const p = t / 0.055;
        const s0 = {
          px: (rnd(epoch, 121) - 0.5) * R * 2.6,
          py: (rnd(epoch, 127) - 0.5) * R * 1.4,
          pz: (rnd(epoch, 131) - 0.5) * R * 2.2,
        };
        const dir = norm({ px: rnd(epoch, 137) - 0.5, py: rnd(epoch, 139) - 0.5, pz: rnd(epoch, 149) - 0.5 });
        const head = add(s0, scale3(dir, p * R * 0.9));
        const tail = add(s0, scale3(dir, Math.max(p - 0.12, 0) * R * 0.9));
        const a = project(head, trig, cx, cy);
        const b = project(tail, trig, cx, cy);
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, theme.label);
        grad.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.5 * Math.sin(p * Math.PI) * fadeIn;
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.1 / camera.scale;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // galactic mode: faint orbit guides + the black hole core. The "hole"
    // is punched with the label-halo ink (≈ background in both themes), the
    // event horizon rings carry the accent — dark core, bright rim.
    // `hole` is only ever set by the galactic modes (galaxy, galaxy-lab), so
    // testing it alone is identical in behaviour for universe and adds the
    // lab mode's Sgr A* without a second condition. orbitRings is empty in
    // galaxy-lab — nothing orbits the core as its own galaxy there.
    if (hole) {
      const origin = { px: 0, py: 0, pz: 0 };
      ctx.strokeStyle = theme.bandBorder;
      ctx.globalAlpha = 0.09 * fadeIn;
      ctx.lineWidth = 0.8 / camera.scale;
      for (const orbitR of orbitRings) {
        ctx.beginPath();
        for (let k = 0; k < 33; k++) {
          const a = (k / 32) * Math.PI * 2;
          const pr = project({ px: Math.cos(a) * orbitR, py: 0, pz: Math.sin(a) * orbitR }, trig, cx, cy);
          if (k === 0) ctx.moveTo(pr.x, pr.y);
          else ctx.lineTo(pr.x, pr.y);
        }
        ctx.closePath();
        ctx.stroke();
      }
      // The centre graphic is swappable (orbit-core.js). `classic` is the
      // shipped black hole moved there unchanged, so the default still renders
      // exactly as before — the switch only picks a different draw function.
      const pr = project(origin, trig, cx, cy);
      const r0 = Math.max(hole.r * depthScale(pr), 24 / camera.scale);
      coreOf(env.getCore()).draw(
        ctx,
        {
          x: pr.x,
          y: pr.y,
          r: r0,
          t: tSec,
          camScale: camera.scale,
          theme,
          // the user's memories, for the cores that bind to them (gravity web)
          anchors: env.getUserAnchors(),
          // kept SEPARATE on purpose: the shipped core applies depth only to
          // its outer glow, while the dark core and the rim ride on fadeIn
          // alone. Folding them into one number would dim the centre on the
          // far side and `classic` would no longer be pixel-identical.
          fade: fadeIn,
          depth: depthFade(pr.d),
        },
        glowSprite
      );
      ctx.globalAlpha = 1;
    }

    // galaxies back-to-front, all glow via sprites in ONE additive batch
    // ("lighter" on dark theme sums overlapping light like real light;
    // the light theme's flowBlend stays source-over)
    ctx.globalCompositeOperation = theme.flowBlend;
    const sorted = [...universe.galaxies].sort((a, b) => b.d - a.d);
    for (const g of sorted) {
      if (!inView(view, g.sx, g.sy)) continue;
      const color = clusterColor(hues, g.key, sat, light);
      const depthAlpha = depthFade(g.d) * fadeIn;
      if (depthAlpha <= 0.02) continue;

      if (g.nebula) {
        for (const b of g.nebula) {
          const wob = b.phase + tSec * b.drift;
          const wx = b.ox + Math.cos(wob) * g.r * 0.22;
          const wy = b.oy + Math.sin(wob * 0.8) * g.r * 0.22;
          const wp = inPlane(g.center, g.basis, wx, wy, 0);
          const pr = project(wp, trig, cx, cy);
          const br = b.r * depthScale(pr) * (0.9 + 0.12 * Math.sin(wob * 0.6));
          ctx.globalAlpha = 0.05 * depthAlpha * (0.8 + 0.2 * Math.sin(wob));
          ctx.drawImage(glowSprite(color), pr.x - br, pr.y - br, br * 2, br * 2);
        }
      }

      const rr = g.r * g.scale * (g.dwarf ? 1.6 : 2.3);
      ctx.globalAlpha = (g.dwarf ? 0.045 : 0.055) * depthAlpha;
      ctx.drawImage(glowSprite(color), g.sx - rr, g.sy - rr, rr * 2, rr * 2);

      const breathe = 1 + 0.07 * Math.sin(tSec * 0.7 + g.phase);
      const coreR = Math.max(g.r * g.scale * 0.3, 8) * breathe;
      ctx.globalAlpha = (g.dwarf ? 0.09 : 0.18) * depthAlpha * (0.88 + 0.12 * Math.sin(tSec * 0.9 + g.phase));
      ctx.drawImage(glowSprite(color, theme.label), g.sx - coreR, g.sy - coreR, coreR * 2, coreR * 2);
    }
    ctx.globalCompositeOperation = "source-over";

    // galaxy names — outside the additive batch. Two deliberate departures from
    // the screen-px playbook, both for the same reason: the nameplate should
    // belong to its galaxy, not float above the scene.
    //
    // 1) FIXED world offset instead of g.r * 1.4. The old offset grew with the
    //    disc radius, and since that grows with member count, the name of a
    //    large area drifted further and further above the thing it names. All
    //    labels now sit the same distance above their galaxy.
    // 2) NO screen-px floor on the font size, but g.rawScale (the unclamped
    //    perspective) instead. A floor renders far and near labels at the same
    //    size, which made the cloud read as flat. The small remaining floor only
    //    stops very distant names from rastering into mush — the lesson the
    //    floor originally came from.
    const LABEL_LIFT = 34; // world units above the galaxy centre
    for (const g of sorted) {
      if (!inView(view, g.sx, g.sy)) continue;
      const depthAlpha = depthFade(g.d) * fadeIn;
      if (depthAlpha <= 0.05) continue;
      const color = clusterColor(hues, g.key, sat, light);
      ctx.globalAlpha = 0.7 * depthAlpha;
      const fontPx = Math.max((g.dwarf ? 9.5 : 11) * g.rawScale, 4.5 / camera.scale);
      ctx.font = `700 ${fontPx}px "Avenir Next", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.lineWidth = 3 / camera.scale;
      ctx.lineJoin = "round";
      ctx.strokeStyle = theme.labelHalo;
      const ly = g.sy - LABEL_LIFT * g.rawScale;
      ctx.strokeText(g.key.toUpperCase(), g.sx, ly);
      ctx.fillStyle = color;
      ctx.fillText(g.key.toUpperCase(), g.sx, ly);
      ctx.globalAlpha = 1;
    }

    // solar systems: culled orbit rings (17 pts) + pulsing sun glow sprites
    ctx.strokeStyle = theme.bandBorder;
    for (const s of [...universe.systems].sort((a, b) => b.d - a.d)) {
      if (!s.sunWorld || !inView(view, s.sx, s.sy)) continue;
      const depthAlpha = depthFade(s.d) * fadeIn;
      if (depthAlpha <= 0.02) continue;
      ctx.globalAlpha = 0.16 * depthAlpha;
      ctx.lineWidth = 0.7 / camera.scale;
      for (const orbitR of s.rings) {
        ctx.beginPath();
        for (let k = 0; k < 17; k++) {
          const a = (k / 16) * Math.PI * 2;
          const wp = inPlane(s.sunWorld, s.basis, Math.cos(a) * orbitR, Math.sin(a) * orbitR);
          const pr = project(wp, trig, cx, cy);
          if (k === 0) ctx.moveTo(pr.x, pr.y);
          else ctx.lineTo(pr.x, pr.y);
        }
        ctx.closePath();
        ctx.stroke();
      }
      const glowR = 13 * s.scale * (1 + 0.14 * Math.sin(tSec * 1.4 + s.pulse));
      ctx.globalAlpha = 0.3 * depthAlpha * (0.85 + 0.15 * Math.sin(tSec * 1.1 + s.pulse));
      ctx.globalCompositeOperation = theme.flowBlend;
      ctx.drawImage(glowSprite(theme.label), s.sx - glowR, s.sy - glowR, glowR * 2, glowR * 2);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
  };
}
