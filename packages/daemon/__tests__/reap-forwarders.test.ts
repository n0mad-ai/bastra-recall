/**
 * Tests für den Desktop-Zombie-Reap (#80): parsePsTable + findStaleForwarders.
 * Die ps-Roundtrips selbst (parentPidOf/commandOf) sind triviale Wrapper und
 * werden nicht gemockt-getestet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePsTable, findStaleForwarders } from "../src/reap-forwarders.js";

const FWD = "/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js";
const DISCLAIMER = "/Applications/Claude.app/Contents/Helpers/disclaimer /opt/homebrew/bin/node …/mcp-forwarder.js";

test("parsePsTable: parses pid/ppid/command rows, skips garbage", () => {
  const rows = parsePsTable(
    [
      "  101     1 /sbin/launchd",
      "  202   101 /Applications/Claude.app/Contents/MacOS/Claude",
      "  303   202 " + DISCLAIMER,
      "  404   303 " + FWD,
      "not a row",
      "",
    ].join("\n")
  );
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[3], { pid: 404, ppid: 303, command: FWD });
});

test("findStaleForwarders: live Desktop chain (Claude alive) → not stale", () => {
  const rows = parsePsTable(
    [
      "  202     1 /Applications/Claude.app/Contents/MacOS/Claude", // app alive (launchd child — normal for GUI apps)
      "  303   202 " + DISCLAIMER, // wrapper parented to the LIVING app
      "  404   303 " + FWD,
    ].join("\n")
  );
  assert.deepEqual(findStaleForwarders(rows, 999), []);
});

test("findStaleForwarders: dead Desktop (wrapper reparented to init) → forwarder is stale", () => {
  const rows = parsePsTable(
    [
      "  303     1 " + DISCLAIMER, // Desktop died → wrapper now child of init
      "  404   303 " + FWD,
    ].join("\n")
  );
  assert.deepEqual(findStaleForwarders(rows, 999), [404]);
});

test("findStaleForwarders: classic orphan (forwarder itself under init) → stale", () => {
  const rows = parsePsTable(["  404     1 " + FWD].join("\n"));
  assert.deepEqual(findStaleForwarders(rows, 999), [404]);
});

test("findStaleForwarders: Claude Code shape (forwarder under living claude) → not stale", () => {
  const rows = parsePsTable(
    [
      "  500   100 claude", // CC process, parent = shell
      "  404   500 " + FWD,
    ].join("\n")
  );
  assert.deepEqual(findStaleForwarders(rows, 999), []);
});

test("findStaleForwarders: never reports self", () => {
  const rows = parsePsTable(["  404     1 " + FWD].join("\n"));
  assert.deepEqual(findStaleForwarders(rows, 404), []);
});

// #345: Terminal-Tab-Klasse — der Client stirbt, ein generischer Wrapper
// (sh -c, npx …) überlebt mit den Pipes, der Forwarder-ppid wird nie 1.
const SH_WRAPPER = "/bin/sh -c " + FWD;

test("findStaleForwarders: sh wrapper reparented to init (#345 tab class) → forwarder stale, wrapper spared", () => {
  const rows = parsePsTable(
    [
      "  300     1 " + SH_WRAPPER, // claude died → wrapper now child of init
      "  404   300 " + FWD,
    ].join("\n")
  );
  assert.deepEqual(findStaleForwarders(rows, 999), [404]);
});

test("findStaleForwarders: sh wrapper under living claude → not stale", () => {
  const rows = parsePsTable(["  500   100 claude", "  300   500 " + SH_WRAPPER, "  404   300 " + FWD].join("\n"));
  assert.deepEqual(findStaleForwarders(rows, 999), []);
});

test("findStaleForwarders: lingering wrapper without child under init → reaped like a forwarder", () => {
  const rows = parsePsTable(["  300     1 " + SH_WRAPPER].join("\n"));
  assert.deepEqual(findStaleForwarders(rows, 999), [300]);
});
