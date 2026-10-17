/** Visit valid retrieved replacement edges, predecessor first. Missing targets
 * stop traversal; self-links, cycles and paths into cycles produce no edge.
 * Shared by score promotion and batch ordering; no retrieval or score mutation.
 */
export function visitSupersession<T extends { id: string }>(
  hits: readonly T[],
  successorId: (hit: T) => string | undefined,
  onEdge: (predecessor: T, successor: T) => void,
): void {
  const byId = new Map(hits.map(h => [h.id, h]));
  const edges: [T, T][] = [];
  const state = new Map<string, "visiting" | boolean>();
  const visit = (hit: T): boolean => {
    const seen = state.get(hit.id);
    if (seen !== undefined) return seen === true;
    state.set(hit.id, "visiting");
    const id = successorId(hit);
    const successor = id === undefined ? undefined : byId.get(id);
    const valid = !successor || visit(successor);
    if (successor && valid) edges.push([hit, successor]);
    state.set(hit.id, valid);
    return valid;
  };
  for (const hit of hits) visit(hit);
  // Reverse postorder propagates a strong old score all the way to the newest.
  for (const [hit, successor] of edges.reverse()) onEdge(hit, successor);
}
