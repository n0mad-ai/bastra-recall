// v22 Live tab: the session feed behind js/views/live-tab.js (DOM-free).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeed, shortAge } from "../../packages/daemon/webui/v22/js/views/live-feed.js";

test("ingest keeps valid entries newest first and labels the read source", () => {
  const f = createFeed();
  const seen = [];
  f.onAdd((fresh) => seen.push(fresh.map((e) => e.id)));
  // one delivery, oldest first as GET /ui/updates sends it
  const fresh = f.ingest(
    [
      { id: "a", kind: "add", title: "A", type: "decision", cluster: "x", count: 1 },
      { id: "b", kind: "read", title: "B", band: "required" },
      { id: "c", kind: "read", title: "C" },
      { id: "d", kind: "change", count: 3 },
    ],
    1000
  );
  assert.deepEqual(
    fresh.map((e) => e.id),
    ["d", "c", "b", "a"]
  );
  assert.deepEqual(
    f.events.map((e) => e.id),
    ["d", "c", "b", "a"]
  );
  assert.equal(f.events[1].via, "load_memory");
  assert.equal(f.events[2].via, "recall");
  assert.equal(f.events[3].via, "");
  assert.equal(f.events[0].title, "d"); // missing title falls back to the id
  assert.equal(f.events[0].count, 3);
  assert.deepEqual(seen, [["d", "c", "b", "a"]]);
  f.ingest([{ id: "e", kind: "delete" }], 2000);
  assert.deepEqual(
    f.events.map((e) => e.id),
    ["e", "d", "c", "b", "a"]
  );
  assert.deepEqual(f.counts(), { add: 1, change: 1, delete: 1, read: 2 });
  assert.equal(new Set(f.events.map((e) => e.key)).size, 5);
});

test("ingest drops malformed input and caps the session", () => {
  const f = createFeed({ max: 3 });
  assert.deepEqual(f.ingest(null), []);
  assert.deepEqual(
    f.ingest([null, 1, {}, { id: "", kind: "add" }, { id: "x", kind: "rename" }, { id: 5, kind: "add" }]),
    []
  );
  let calls = 0;
  f.onAdd(() => calls++);
  f.ingest([
    { id: "1", kind: "add" },
    { id: "2", kind: "add" },
  ]);
  f.ingest([
    { id: "3", kind: "read" },
    { id: "4", kind: "read", title: 7, summary: {} },
  ]);
  assert.deepEqual(
    f.events.map((e) => e.id),
    ["4", "3", "2"]
  );
  assert.equal(f.events[0].title, "4");
  assert.equal(f.events[0].summary, "");
  assert.equal(calls, 2);
});

test("shortAge", () => {
  assert.equal(shortAge(0, 0), "0s");
  assert.equal(shortAge(0, 59_000), "59s");
  assert.equal(shortAge(0, 61_000), "1m");
  assert.equal(shortAge(0, 3 * 3600_000), "3h");
  assert.equal(shortAge(0, 2 * 86400_000), "2d");
  assert.equal(shortAge(5000, 0), "0s");
});
