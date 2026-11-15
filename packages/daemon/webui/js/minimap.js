/** Minimap: the whole graph as dots plus the current viewport rectangle.
 *  Click (or drag) jumps the camera. Redrawn every frame — a few hundred
 *  fillRects are cheap. */

export function createMinimap(canvas, sim, renderer, colorOf, flyTo) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // last world→minimap transform, for click mapping
  let mScale = 1;
  let mX = 0;
  let mY = 0;

  function draw() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of sim.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) return;
    const pad = 8;
    mScale = Math.min((W - pad * 2) / Math.max(maxX - minX, 1), (H - pad * 2) / Math.max(maxY - minY, 1));
    mX = W / 2 - ((minX + maxX) / 2) * mScale;
    mY = H / 2 - ((minY + maxY) / 2) * mScale;

    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = 0.9;
    for (const n of sim.nodes) {
      ctx.fillStyle = colorOf(n);
      ctx.fillRect(n.x * mScale + mX - 1, n.y * mScale + mY - 1, 2, 2);
    }
    ctx.globalAlpha = 1;

    // viewport rectangle from the main camera
    const cam = renderer.camera;
    const stage = canvas.ownerDocument.querySelector("#map");
    const vx = (0 - cam.x) / cam.scale;
    const vy = (0 - cam.y) / cam.scale;
    const vw = stage.clientWidth / cam.scale;
    const vh = stage.clientHeight / cam.scale;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    ctx.lineWidth = 1;
    ctx.strokeRect(vx * mScale + mX, vy * mScale + mY, vw * mScale, vh * mScale);
  }

  function jump(ev) {
    const rect = canvas.getBoundingClientRect();
    const wx = (ev.clientX - rect.left - mX) / mScale;
    const wy = (ev.clientY - rect.top - mY) / mScale;
    flyTo(wx, wy, renderer.camera.scale, 350);
  }

  let down = false;
  canvas.addEventListener("pointerdown", (ev) => {
    down = true;
    canvas.setPointerCapture(ev.pointerId);
    jump(ev);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (down) jump(ev);
  });
  canvas.addEventListener("pointerup", () => (down = false));

  return { draw };
}
