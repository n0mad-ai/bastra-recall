// Memory-browser reader detail (#1449): the node details the reader shows
// (GET /ui/graph/node) and when the reader must fetch and redraw them.
//
// The cache has a generation. A graph change (live update, own save) and
// every reopen of the browser start a new one: the next read fetches again,
// so a memory edited without changing the vault total shows its new text. An
// answer that was still on its way from the old generation is never kept or
// shown — whoever waits for it gets the current one instead.

/** GET /ui/graph/node?id= → the detail object, or null (failed). */
export async function fetchNodeDetail(id) {
  try {
    const r = await fetch(`/ui/graph/node?id=${encodeURIComponent(id)}`, { credentials: "same-origin" });
    if (!r.ok) return null;
    const b = await r.json();
    return b && typeof b === "object" ? b : null;
  } catch {
    return null;
  }
}

/** Details by id, per generation. `load(id)` → Promise<detail | null>. */
export function detailCache(fetchDetail = fetchNodeDetail) {
  let gen = 0;
  const entries = new Map(); // id → { gen, promise }
  const cache = {
    get gen() {
      return gen;
    },
    load(id) {
      const hit = entries.get(id);
      if (hit && hit.gen === gen) return hit.promise;
      const at = gen;
      const promise = fetchDetail(id).then((d) => {
        if (at !== gen) return cache.load(id); // late answer of an older generation
        if (d === null && entries.get(id)?.promise === promise) entries.delete(id); // a failure is retried next time
        return d;
      });
      entries.set(id, { gen: at, promise });
      return promise;
    },
    /** The vault changed or the browser reopened: every detail is stale. */
    invalidate() {
      gen++;
      entries.clear();
    },
  };
  return cache;
}

/** What identifies the reader's content: the memory, the vault size (its
 *  links), the layout (back button) and the detail generation. */
export const readerKey = (m, vault, narrow, gen) => (m ? { id: m.id, total: vault.total, narrow, gen } : null);

/**
 * The reader's next step for a render: "keep" (nothing changed), "refresh"
 * (same memory, newer data: fetch first, then redraw at the same scroll
 * position) or "rebuild" (another memory or layout: from the top). While the
 * memory is being edited a refresh waits — the editor and its draft stay.
 * `prev` is undefined before the first draw.
 */
export function readerPlan(prev, next, editing = false) {
  if (prev === undefined) return "rebuild";
  if (!prev || !next) return prev === next ? "keep" : "rebuild";
  if (prev.id !== next.id || prev.narrow !== next.narrow) return "rebuild";
  if (prev.gen === next.gen && prev.total === next.total) return "keep";
  return editing ? "keep" : "refresh";
}
