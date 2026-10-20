/** Pan / zoom / hover / click / camera flights. */

export function createInteractions(canvas, renderer, sim, { onSelect, onHoverChange, onClusterDragEnd, getInsets, canDragClusters }) {
  // UI overlays (inspector, sidebar, topbar) shrink the usable viewport —
  // every fit/flight centers inside THIS rectangle so nodes never end up
  // hidden behind a panel.
  const insets = () => getInsets?.() ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const { camera } = renderer;
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;
  let dragCluster = null; // cluster key while a cloud is being dragged
  let dragDelegate = null; // orbit view: background drags rotate instead of pan; returning false falls back to panning (shift-drag)
  let flight = null; // { fromX, fromY, fromS, toX, toY, toS, t0, ms }

  canvas.addEventListener("pointerdown", (ev) => {
    dragging = true;
    moved = false;
    lastX = ev.clientX;
    lastY = ev.clientY;
    // grabbing a cluster label moves the whole cloud instead of panning
    // (computed views like the ring don't allow rearranging)
    dragCluster = (canDragClusters?.() ?? true)
      ? renderer.pickClusterLabel(ev.clientX, ev.clientY)
      : null;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(ev.pointerId);
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (dragging) {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (dragCluster) {
        sim.shiftCluster(dragCluster, dx / camera.scale, dy / camera.scale);
      } else if (dragDelegate && dragDelegate(dx, dy, ev) !== false) {
        // delegate consumed the drag (orbit rotation); false = fall through
        flight = null;
      } else {
        camera.x += dx;
        camera.y += dy;
        flight = null;
      }
      lastX = ev.clientX;
      lastY = ev.clientY;
      return;
    }
    const n = renderer.pick(ev.clientX, ev.clientY);
    renderer.setHover(n);
    const overLabel = n === null && renderer.pickClusterLabel(ev.clientX, ev.clientY) !== null;
    canvas.classList.toggle("pointing", n !== null);
    canvas.style.cursor = overLabel ? "move" : "";
    onHoverChange?.(n, ev.clientX, ev.clientY);
  });

  canvas.addEventListener("pointerup", (ev) => {
    // stray release: the press began on other UI (e.g. a search result that
    // hid itself on pointerdown) — treating it as a canvas click would wipe
    // the selection that click just made
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove("dragging");
    if (dragCluster) {
      const key = dragCluster;
      dragCluster = null;
      if (moved) onClusterDragEnd?.(key);
      return;
    }
    if (!moved) {
      const n = renderer.pick(ev.clientX, ev.clientY);
      onSelect?.(n, ev.clientX, ev.clientY);
    }
  });

  canvas.addEventListener("pointerleave", () => {
    renderer.setHover(null);
    onHoverChange?.(null, 0, 0);
  });

  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      flight = null;
      const factor = Math.exp(-ev.deltaY * 0.0015);
      const next = Math.min(Math.max(camera.scale * factor, 0.12), 8);
      const applied = next / camera.scale;
      // zoom towards the cursor
      camera.x = ev.clientX - (ev.clientX - camera.x) * applied;
      camera.y = ev.clientY - (ev.clientY - camera.y) * applied;
      camera.scale = next;
    },
    { passive: false },
  );

  const easeFly = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** Animate the camera so that world point (wx, wy) lands center-screen. */
  function flyTo(wx, wy, scale = Math.max(camera.scale, 1.6), ms = 750) {
    flight = {
      fromX: camera.x,
      fromY: camera.y,
      fromS: camera.scale,
      toX: canvas.clientWidth / 2 - wx * scale,
      toY: canvas.clientHeight / 2 - wy * scale,
      toS: scale,
      t0: performance.now(),
      ms,
    };
  }

  /** Fit a set of world points into the UNOBSTRUCTED viewport, animated. */
  function flyToBounds(points, { padding = 110, maxScale = 3, ms = 800 } = {}) {
    if (!points.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const ins = insets();
    const availW = canvas.clientWidth - ins.left - ins.right;
    const availH = canvas.clientHeight - ins.top - ins.bottom;
    const scale = Math.min(
      (availW - padding * 2) / Math.max(maxX - minX, 1),
      (availH - padding * 2) / Math.max(maxY - minY, 1),
      maxScale,
    );
    flight = {
      fromX: camera.x,
      fromY: camera.y,
      fromS: camera.scale,
      toX: ins.left + availW / 2 - ((minX + maxX) / 2) * scale,
      toY: ins.top + availH / 2 - ((minY + maxY) / 2) * scale,
      toS: scale,
      t0: performance.now(),
      ms,
    };
  }

  /** Fit one whole cloud (all nodes of a cluster) into view. */
  function flyToCluster(key) {
    const members = sim.nodes.filter((n) => n.cluster === key);
    flyToBounds(members, { padding: 90, maxScale: 2.4, ms: 850 });
  }

  /** Advance an in-progress flight; call once per frame. */
  function step(now) {
    if (!flight) return;
    const t = Math.min((now - flight.t0) / flight.ms, 1);
    const e = easeFly(t);
    camera.x = flight.fromX + (flight.toX - flight.fromX) * e;
    camera.y = flight.fromY + (flight.toY - flight.fromY) * e;
    camera.scale = flight.fromS + (flight.toS - flight.fromS) * e;
    if (t >= 1) flight = null;
  }

  /** Fit the whole graph into the unobstructed viewport (initial view).
   *  Nodes drilled away in the ring browser don't count. */
  function fitAll(padding = 90) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of sim.nodes) {
      if (n.ringHidden || (n.ringFade !== undefined && n.ringFade < 0.5)) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) return;
    const ins = insets();
    const availW = canvas.clientWidth - ins.left - ins.right;
    const availH = canvas.clientHeight - ins.top - ins.bottom;
    const scale = Math.min(
      (availW - padding * 2) / Math.max(maxX - minX, 1),
      (availH - padding * 2) / Math.max(maxY - minY, 1),
      1.6,
    );
    camera.scale = scale;
    camera.x = ins.left + availW / 2 - ((minX + maxX) / 2) * scale;
    camera.y = ins.top + availH / 2 - ((minY + maxY) / 2) * scale;
  }

  return { flyTo, flyToBounds, flyToCluster, step, isFlying: () => flight !== null, fitAll, draggedCluster: () => dragCluster, setDragDelegate: (fn) => (dragDelegate = fn) };
}
