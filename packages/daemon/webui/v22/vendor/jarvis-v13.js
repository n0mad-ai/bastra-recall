// Recall agent presence: particle-sphere head with eyes + voice-waveform mouth.
// mountJarvis(canvas, { scale, points, face }) → { set(mode), destroy() }
// modes: idle | listening | thinking | speaking
const TAU = Math.PI * 2;

export function mountJarvis(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const N = opts.points || 1200;
  const scale = opts.scale || 0.3;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r, Math.random()]);
  }
  const st = { mode: "idle", active: true };
  const BUCKETS = 7, bucketCyan = [], bucketAmber = [], cyanStyle = [], amberStyle = [];
  for (let b = 0; b < BUCKETS; b++) { const d = (b + 0.5) / BUCKETS, a = (0.08 + 0.75 * d * d).toFixed(3); cyanStyle.push(`rgba(56,217,245,${a})`); amberStyle.push(`rgba(217,164,65,${a})`); bucketCyan.push([]); bucketAmber.push([]); }
  let frameN = 0;
  let w = 0, h = 0, dpr = 1, raf = 0, energy = 0, level = 0, rot = 0, blink = 0, nextBlink = 1.5, lastT = 0;
  const resize = () => {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const b = canvas.getBoundingClientRect();
    w = b.width; h = b.height;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
  };
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  // head turn: spontaneous glances, or follow the pointer while it moves
  let yaw = 0, yawV = 0, pitch = 0, pitchV = 0, tYaw = 0, tPitch = 0, nextGlance = 2 + Math.random() * 3, holdUntil = 0, lastMouse = -1e9, mx = 0, my = 0;
  const onMove = (e) => { const b = canvas.getBoundingClientRect(); mx = (e.clientX - (b.left + b.width / 2)) / Math.max(200, window.innerWidth * 0.45); my = (e.clientY - (b.top + b.height / 2)) / Math.max(200, window.innerHeight * 0.6); lastMouse = performance.now(); };
  window.addEventListener("pointermove", onMove, { passive: true });
  const t0 = performance.now();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    frameN++;
    if (!st.active || document.hidden || w < 2) return;
    if (st.mode === "idle" && energy < 0.2 && (frameN & 1)) return;
    const t = (now - t0) / 1000, dt = Math.min(0.05, Math.max(0, t - lastT)); lastT = t;
    const target = { idle: 0.15, listening: 0.65, thinking: 0.5, speaking: 1 }[st.mode] ?? 0.15;
    energy += (target - energy) * 0.04;
    const raw = st.mode === "speaking" ? 0.3 + 0.7 * Math.abs(Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1) + 0.3 * Math.sin(t * 17))
      : st.mode === "listening" ? 0.2 + 0.45 * Math.abs(Math.sin(t * 5.3) * Math.sin(t * 2.2)) : 0.03;
    level += (Math.min(1, raw) - level) * 0.22;
    nextBlink -= dt; if (nextBlink <= 0) { blink = 1; nextBlink = 2.5 + Math.random() * 3.5; }
    blink = Math.max(0, blink - dt * 7);
    if (now - lastMouse < 2500) { tYaw = Math.max(-0.7, Math.min(0.7, mx)); tPitch = Math.max(-0.35, Math.min(0.35, my)); nextGlance = 2 + Math.random() * 3; }
    else {
      nextGlance -= dt;
      if (nextGlance <= 0) {
        if (Math.abs(tYaw) > 0.1 && Math.random() < 0.55) { tYaw = 0; tPitch = 0; }
        else { tYaw = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.45); tPitch = (Math.random() - 0.5) * 0.25; }
        nextGlance = 1.6 + Math.random() * 4.5;
      }
    }
    yawV += (tYaw - yaw) * 0.045; yawV *= 0.82; yaw += yawV;
    pitchV += (tPitch - pitch) * 0.045; pitchV *= 0.82; pitch += pitchV;
    const eyeOpen = 1 - Math.sin(Math.min(1, blink) * Math.PI);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * scale * (1 + 0.015 * Math.sin(t * 1.4) + energy * 0.04);

    const g = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 2.1);
    g.addColorStop(0, `rgba(56,217,245,${0.16 + energy * 0.14})`);
    g.addColorStop(0.5, `rgba(56,217,245,${0.05 + energy * 0.05})`);
    g.addColorStop(1, "rgba(56,217,245,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    if (st.mode === "listening") {
      for (let i = 0; i < 3; i++) {
        const f = (t * 0.7 + i / 3) % 1;
        ctx.strokeStyle = `rgba(56,217,245,${0.45 * (1 - f)})`;
        ctx.beginPath(); ctx.arc(cx, cy, R * (1.05 + f * 0.75), 0, TAU); ctx.stroke();
      }
    }

    const TR = R * 1.62, NT = 96;
    ctx.lineWidth = 1;
    for (let i = 0; i < NT; i++) {
      const a = (i / NT) * TAU + t * 0.05;
      const amp = st.mode === "listening" || st.mode === "speaking" ? level * 12 * (0.5 + 0.5 * Math.sin(i * 0.9 + t * 8)) : 0;
      const L = (i % 8 === 0 ? 7 : 3) + amp;
      ctx.strokeStyle = i % 8 === 0 ? "rgba(56,217,245,.55)" : "rgba(126,164,210,.28)";
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * TR, cy + Math.sin(a) * TR);
      ctx.lineTo(cx + Math.cos(a) * (TR + L), cy + Math.sin(a) * (TR + L));
      ctx.stroke();
    }

    for (let k = 0; k < 3; k++) {
      ctx.save(); ctx.translate(cx, cy);
      ctx.rotate((k % 2 ? -1 : 1) * t * (0.12 + k * 0.05) + k * 1.1);
      const rx = R * (1.28 + k * 0.14), ry = R * (0.34 + k * 0.16);
      ctx.strokeStyle = `rgba(126,164,210,${0.22 - k * 0.04})`;
      ctx.setLineDash(k === 1 ? [2, 5] : []);
      ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      const s0 = t * (0.8 + k * 0.3) * (k % 2 ? -1 : 1);
      ctx.strokeStyle = k === 2 ? "rgba(217,164,65,.85)" : `rgba(56,217,245,${0.6 + energy * 0.4})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, s0, s0 + 0.5 + energy * 0.8); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.restore();
    }

    rot += dt * (0.25 + energy * 0.5);
    const rr = rot + yaw * 0.9;
    const cr = Math.cos(rr), sr = Math.sin(rr), tilt = 0.28 + pitch * 0.5, ct = Math.cos(tilt), stl = Math.sin(tilt);
    ctx.globalCompositeOperation = "lighter";
    for (let b = 0; b < BUCKETS; b++) { bucketCyan[b].length = 0; bucketAmber[b].length = 0; }
    const lvl10 = level * 0.1, en02 = energy * 0.02, t7 = t * 7, t3 = t * 3;
    const stride = R < 34 ? 3 : R < 52 ? 2 : 1, szK = R < 52 ? 0.75 : 1;
    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i];
      let x = p[0] * cr + p[2] * sr, z = -p[0] * sr + p[2] * cr, y = p[1];
      const y2 = y * ct - z * stl; z = y * stl + z * ct; y = y2;
      const bump = 1 + lvl10 * Math.sin(y * 9 - t7 + p[3] * 2) + en02 * Math.sin(t3 + p[3] * 6);
      const d = (z + 1) / 2, b = Math.min(BUCKETS - 1, (d * BUCKETS) | 0);
      const sz = (0.5 + 1.3 * d) * szK;
      (p[3] > 0.97 ? bucketAmber : bucketCyan)[b].push(cx + x * R * bump - sz / 2, cy + y * R * bump - sz / 2, sz);
    }
    for (let b = 0; b < BUCKETS; b++) {
      const A = bucketCyan[b]; if (A.length) { ctx.fillStyle = cyanStyle[b]; for (let k = 0; k < A.length; k += 3) ctx.fillRect(A[k], A[k + 1], A[k + 2], A[k + 2]); }
      const B = bucketAmber[b]; if (B.length) { ctx.fillStyle = amberStyle[b]; for (let k = 0; k < B.length; k += 3) ctx.fillRect(B[k], B[k + 1], B[k + 2], B[k + 2]); }
    }
    ctx.globalCompositeOperation = "source-over";

    if (opts.face !== false) {
      const look = Math.sin(yaw * 1.15) * R * 0.42 + Math.sin(t * 0.37) * R * 0.015, lookY = pitch * R * 0.32 + Math.sin(t * 0.23) * R * 0.01;
      const spread = Math.cos(yaw * 1.15);
      ctx.shadowColor = "rgba(56,217,245,.95)"; ctx.shadowBlur = R * 0.14;
      ctx.fillStyle = "#e9fbff";
      for (const side of [-1, 1]) {
        const near = 1 + side * Math.sin(yaw * 1.15) * 0.28;
        const ex = cx + side * R * 0.34 * spread + look, ey = cy - R * 0.1 + lookY;
        const ew = R * 0.22 * spread * near, eh = Math.max(1.2, R * (st.mode === "thinking" ? 0.035 : 0.075) * eyeOpen);
        ctx.beginPath(); ctx.ellipse(ex, ey, ew / 2, eh / 2, 0, 0, TAU); ctx.fill();
      }
      ctx.shadowBlur = R * 0.08;
      ctx.strokeStyle = "rgba(233,251,255,.95)";
      ctx.lineWidth = Math.max(1.2, R * 0.014);
      const mw = R * 0.62 * (0.75 + 0.25 * spread), mY = cy + R * 0.36 + lookY * 0.8, M = 56;
      ctx.beginPath();
      for (let i = 0; i <= M; i++) {
        const u = i / M, env = Math.sin(u * Math.PI);
        const yy = mY + Math.sin(u * 22 + t * 15) * Math.cos(u * 7 - t * 5) * R * 0.11 * level * env;
        const xx = cx - mw / 2 + u * mw + look * 0.85;
        i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
      }
      ctx.stroke();
      ctx.shadowBlur = 0; ctx.lineWidth = 1;
    }

    if (st.mode === "thinking") {
      ctx.strokeStyle = "rgba(217,164,65,.9)"; ctx.lineWidth = 2;
      const s = t * 4;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, s, s + 1.1); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, s + Math.PI, s + Math.PI + 0.5); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
  raf = requestAnimationFrame(frame);
  return { set(mode) { st.mode = mode; }, setActive(on) { st.active = !!on; }, destroy() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener("pointermove", onMove); } };
}
