// #1449: the memory browser's reader re-reads a memory after a live change,
// even when the vault total stays the same, after a reopen, and never lets a
// late answer of an older generation win (membrowser-detail.js, pure logic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function load() {
  const source = await readFile(new URL("../webui/v22/js/views/membrowser-detail.js", import.meta.url), "utf8");
  return runInNewContext(source.replace(/^export /gm, "") + "\n({ detailCache, readerKey, readerPlan })", {});
}

/** A fake GET /ui/graph/node: every call waits until the test answers it. */
function fakeFetch() {
  const calls: Array<{ id: string; answer: (d: unknown) => void }> = [];
  const fn = (id: string) => new Promise((answer) => calls.push({ id, answer }));
  return { fn, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("same vault total: a graph change makes the reader refresh and fetch the new text", async () => {
  const { detailCache, readerKey, readerPlan } = await load();
  const f = fakeFetch();
  const cache = detailCache(f.fn);
  const m = { id: "a" };
  const drawn = readerKey(m, { total: 10 }, false, cache.gen);
  const first = cache.load("a");
  f.calls[0].answer({ body: "old" });
  assert.equal(((await first) as { body: string }).body, "old");
  assert.equal(cache.load("a"), first, "no second request within a generation");
  assert.equal(readerPlan(drawn, readerKey(m, { total: 10 }, false, cache.gen)), "keep");

  cache.invalidate(); // the memory was edited, the total is unchanged
  const next = readerKey(m, { total: 10 }, false, cache.gen);
  assert.equal(readerPlan(drawn, next), "refresh", "same memory, newer data: redraw, keep scroll");
  const fresh = cache.load("a");
  assert.equal(f.calls.length, 2, "the edited memory is fetched again");
  f.calls[1].answer({ body: "new" });
  assert.equal(((await fresh) as { body: string }).body, "new");
});

test("reopening the browser reads the memory fresh", async () => {
  const { detailCache, readerKey, readerPlan } = await load();
  const f = fakeFetch();
  const cache = detailCache(f.fn);
  const drawn = readerKey({ id: "a" }, { total: 3 }, false, cache.gen);
  void cache.load("a");
  f.calls[0].answer({ body: "v1" });
  await tick();
  cache.invalidate(); // show(): every open starts a new generation
  assert.equal(readerPlan(drawn, readerKey({ id: "a" }, { total: 3 }, false, cache.gen)), "refresh");
  void cache.load("a");
  assert.equal(f.calls.length, 2);
});

test("a late answer of the old generation never wins over the new text", async () => {
  const { detailCache } = await load();
  const f = fakeFetch();
  const cache = detailCache(f.fn);
  const old = cache.load("a"); // still on its way …
  cache.invalidate(); // … when the memory changes
  const fresh = cache.load("a");
  f.calls[1].answer({ body: "new" });
  f.calls[0].answer({ body: "old" }); // arrives last
  assert.equal(((await fresh) as { body: string }).body, "new");
  assert.equal(((await old) as { body: string }).body, "new", "whoever waited for the old answer gets the current one");
  assert.equal(((await cache.load("a")) as { body: string }).body, "new", "the cache keeps the new text");
  assert.equal(f.calls.length, 2);
});

test("a failed load is retried; selection and layout changes rebuild; an open editor holds the refresh", async () => {
  const { detailCache, readerKey, readerPlan } = await load();
  const f = fakeFetch();
  const cache = detailCache(f.fn);
  const failed = cache.load("a");
  f.calls[0].answer(null);
  assert.equal(await failed, null);
  void cache.load("a");
  assert.equal(f.calls.length, 2, "null is not cached");

  const a = readerKey({ id: "a" }, { total: 5 }, false, 0);
  assert.equal(readerPlan(undefined, null), "rebuild", "first draw, even without a selection");
  assert.equal(readerPlan(null, null), "keep");
  assert.equal(
    readerPlan(a, readerKey({ id: "b" }, { total: 5 }, false, 0)),
    "rebuild",
    "another memory: from the top"
  );
  assert.equal(readerPlan(a, readerKey({ id: "a" }, { total: 5 }, true, 0)), "rebuild", "narrow layout");
  assert.equal(
    readerPlan(a, readerKey({ id: "a" }, { total: 6 }, false, 0)),
    "refresh",
    "total changed: links may differ"
  );
  assert.equal(
    readerPlan(a, readerKey({ id: "a" }, { total: 5 }, false, 1), true),
    "keep",
    "the editor and its draft stay"
  );
  assert.equal(readerPlan(a, null), "rebuild", "selection cleared");
});
