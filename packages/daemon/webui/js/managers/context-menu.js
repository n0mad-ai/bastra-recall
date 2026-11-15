/** Right-click menu on the canvas (vendored ctxmenu.js).
 *
 *  Split out of app.js (#284) unchanged. Offers node actions when the click
 *  landed on a node, plus "fit this cloud" for whichever cluster is nearest —
 *  nearest counted with a size discount, so a big cloud claims clicks from
 *  further out than a small one.
 */

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {object} deps.sim
 * @param {object} deps.renderer
 * @param {object} deps.inspector
 * @param {() => object} deps.getInteractions  created after this manager
 * @param {(node: object) => void} deps.select
 */
export function createContextMenu({ canvas, sim, renderer, inspector, getInteractions, select }) {
  function nearestCluster(wx, wy) {
    let best = null;
    let bestD = Infinity;
    for (const [key, c] of sim.centers) {
      const d = Math.hypot(c.x - wx, c.y - wy) - Math.sqrt(c.count) * 14;
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best;
  }

  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const node = renderer.pick(ev.clientX, ev.clientY);
    const w = renderer.toWorld(ev.clientX, ev.clientY);
    const cluster = node?.cluster ?? nearestCluster(w.x, w.y);
    const interactions = getInteractions();
    const items = [];
    if (node) {
      items.push(
        { text: node.title.length > 34 ? `${node.title.slice(0, 33)}…` : node.title, isHeading: true },
        { text: "Zoom to connections", action: () => select(node) },
        {
          text: "Open in inspector",
          action: () => {
            renderer.setFocus(node);
            inspector.show(node);
          },
        },
        { isDivider: true }
      );
    }
    if (cluster) items.push({ text: `Fit cloud “${cluster}”`, action: () => interactions.flyToCluster(cluster) });
    items.push({
      text: "Fit everything",
      action: () => interactions.flyToBounds(sim.nodes, { padding: 90, maxScale: 1.6 }),
    });
    window.ctxmenu.show(items, ev);
  });
}
