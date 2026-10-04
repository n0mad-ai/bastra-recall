/** Sheen on the active strands for the canvas renderer — split out of
 *  renderer.js (#680); the renderer owns the state and hands it in. */

/** Sheen on the active strands: a soft band of light glides along each
 *  edge from the pivot outward — the line itself catches light, nothing
 *  travels ON it. Constant world speed, staggered per strand so the
 *  strands breathe instead of marching in sync, eased in after a pivot
 *  change. Additive blend in the dark theme. */
export function drawFlow(now, pivotId, { ctx, camera, theme, sim, semEdges, pivotSince, strokeEdge }) {
  const ramp = Math.min(1, (now - pivotSince) / 400);
  if (ramp <= 0.02) return;
  const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
  ctx.save();
  ctx.globalCompositeOperation = theme.flowBlend;
  ctx.lineWidth = 1.6 / camera.scale;
  const WAVE_SPAN = 200; // period reference (~mid-length line); see phase below
  let k = 0;
  for (const e of semEdges ? [...sim.edges, ...semEdges] : sim.edges) {
    if (e.s.id !== pivotId && e.t.id !== pivotId) continue;
    if (e.s.ringHidden || e.t.ringHidden) continue;
    k++;
    const from = e.s.id === pivotId ? e.s : e.t;
    const to = e.s.id === pivotId ? e.t : e.s;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 24) continue;
    const fade = Math.min(from.ringFade ?? 1, to.ringFade ?? 1);
    if (fade <= 0.05) continue;
    // fixed-length band of light (not a fraction of the strand): long
    // cross-cloud strands get the same compact glint as short local ones,
    // and enough of them that the next pass is never far away
    const W = Math.min(60, dist * 0.4) / dist; // half-width as a fraction
    // one wave every ~280 px — the SAME density on the mindspace's long
    // rays as on short local strands (a cap here visibly thinned them out)
    const count = 1 + Math.floor(dist / 280);
    // unhurried, and each strand at its own slightly different pace —
    // organic drift instead of a synchronized march
    const speed = 42 + ((k * 53) % 23);
    // Zeitbasierte Phase mit EINHEITLICHER Periode auf allen Linien: die
    // gewrappte Weltstrecke wird über die feste WAVE_SPAN normiert, NICHT über
    // `dist` — sonst hängt die wahrgenommene Wellenfrequenz an der Linienlänge
    // (kurze flackern schnell durch, lange kriechen). WAVE_SPAN ≈ mittellange
    // Linie, damit sich das Tempo dort nicht ändert. Erst wrappen (Zähler
    // bleibt < WAVE_SPAN), dann normieren: konstante Periode, kein
    // Zeitdilatations-Bug (period hing sonst an dist, und now · Δperiod/period²
    // skalierte jede minimale Node-Drift mit dem Session-Alter → Welle wurde
    // umso schneller, je länger die Map offen war).
    const phase = (((now * speed) / 1000) % WAVE_SPAN) / WAVE_SPAN;
    ctx.globalAlpha = 0.4 * ramp * fade;
    for (let p = 0; p < count; p++) {
      // peak sweeps -W → 1+W so the sheen slides off both ends (no popping)
      const t = ((phase + k * 0.41 + p / count) % 1) * (1 + 2 * W) - W;
      const g = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
      g.addColorStop(clamp01(t - W), theme.flowTail);
      g.addColorStop(clamp01(t), theme.flow);
      g.addColorStop(clamp01(t + W), theme.flowTail);
      ctx.strokeStyle = g;
      strokeEdge(e);
    }
  }
  ctx.restore();
}
