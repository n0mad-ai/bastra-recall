/** Visit valid retrieved replacement edges, successor first. Missing targets
 * stop traversal; self-links, cycles and paths into cycles produce no edge.
 * Shared by score capping and batch ordering; no retrieval or score mutation.
 */
export function visitSupersession<T extends { id: string }>(
  hits: readonly T[],
  successorId: (hit: T) => string | undefined,
  onEdge: (predecessor: T, successor: T) => void,
): void {
  const byId = new Map(hits.map(h => [h.id, h]));
  const state = new Map<string, "visiting" | boolean>();
  const visit = (hit: T): boolean => {
    const seen = state.get(hit.id);
    if (seen !== undefined) return seen === true;
    state.set(hit.id, "visiting");
    const id = successorId(hit);
    const successor = id === undefined ? undefined : byId.get(id);
    const valid = !successor || visit(successor);
    if (successor && valid) onEdge(hit, successor);
    state.set(hit.id, valid);
    return valid;
  };
  for (const hit of hits) visit(hit);
}
