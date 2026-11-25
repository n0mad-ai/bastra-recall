// A reloaded graph can change what a node already on the map is: "Is a skill" on an unwritten
// note turns a ghost into a skill (#1715). The engine is built once per graph and only rebuilt
// on the next entry, so the view on screen adopts the new kind in place; the renderer reads
// `kind` every frame. Nodes are not added or removed here (live updates do that). The collision
// radius depends on the kind, so it follows at once (#1730); a skill's is smaller than a ghost's,
// so nothing has to move and the node keeps its position.
/** Copy changed `kind`s from graph nodes (external data) onto the simulation's nodes; returns the count. */
export function adoptKinds(byId, nodes, radius) {
  let changed = 0;
  for (const g of Array.isArray(nodes) ? nodes : []) {
    if (!g || typeof g.id !== "string" || typeof g.kind !== "string") continue;
    const n = byId.get(g.id);
    if (n && n.kind !== g.kind) {
      n.kind = g.kind;
      if (radius) n.cr = radius(n);
      changed++;
    }
  }
  return changed;
}
