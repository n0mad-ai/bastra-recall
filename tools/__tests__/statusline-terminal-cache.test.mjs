import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTickCacheSession, readTickCache, writeTickCache } from "../../packages/statusline/src/utils/tick-cache.ts";
test("same resumed session keeps width, tty and feed PID local to its parent", t => {
  let stored = "{}";
  t.mock.method(fs, "readFileSync", () => stored);
  t.mock.method(fs, "writeFileSync", (_file, data) => { stored = data; });
  t.mock.method(fs, "mkdirSync", () => undefined);
  const ppid = Object.getOwnPropertyDescriptor(process, "ppid");
  t.after(() => { Object.defineProperty(process, "ppid", ppid); setTickCacheSession(undefined); });
  setTickCacheSession("resumed");
  // Node 22 refreshes the native ppid data property despite defineProperty(value).
  // An accessor override reliably simulates parent changes on every supported Node.
  let parent = process.pid;
  Object.defineProperty(process, "ppid", { get: () => parent, configurable: true });
  writeTickCache({ width: 90, tty: "ttys001", claudePid: process.pid, widthAt: Date.now() });
  assert.equal(readTickCache().width, 90);
  parent = process.pid + 1;
  assert.deepEqual(readTickCache(), {}, "another terminal must resolve its own parent chain and width");
});
