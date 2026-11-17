/**
 * Node 22 is no longer supported (Daniel, 17.11.2026). Below MIN_NODE_VERSION
 * every `bastra` command warns, and `bastra update` installs nothing: it must
 * not swap in a release that may need what this Node lacks. The staged path
 * leaves the reason for the next SessionStart instead of retrying unattended.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_NODE_VERSION, unsupportedNode, warnOnUnsupportedNode } from "../src/node-support.js";
import { cmdUpdate, type UpdateIo } from "../src/cli/update.js";
import { parseArgs } from "../src/cli/commands.js";
import { readBlockedUpdate } from "../src/update-blocked.js";

test("the floor: below is refused with a way to check, at or above is fine", () => {
  assert.equal(unsupportedNode(MIN_NODE_VERSION), null);
  assert.equal(unsupportedNode("v26.1.0"), null);
  assert.equal(unsupportedNode(process.versions.node), null, "the suite itself runs on a supported Node");
  const reason = unsupportedNode("v22.22.0");
  assert.ok(reason);
  assert.match(reason, /Node\.js 22\.22\.0/);
  assert.match(reason, new RegExp(`Node\\.js ${MIN_NODE_VERSION.replace(/\./g, "\\.")} or newer`));
  assert.match(reason, /node --version/);
  assert.ok(unsupportedNode("24.0.0"), "an early Node 24 is below the floor too");
});

test("every command but update warns on stderr; a supported Node stays silent", (t) => {
  let err = "";
  t.mock.method(process.stderr, "write", (s: string) => {
    err += s;
    return true;
  });
  warnOnUnsupportedNode("doctor", "22.23.5");
  assert.match(err, /^warning: this is Node\.js 22\.23\.5; bastra-recall needs Node\.js/);
  err = "";
  warnOnUnsupportedNode("update", "22.23.5");
  warnOnUnsupportedNode("doctor", MIN_NODE_VERSION);
  assert.equal(err, "");
});

function refusingIo(): { io: UpdateIo; calls: string[] } {
  const calls: string[] = [];
  const io: UpdateIo = {
    nodeVersion: "22.23.5",
    platform: "darwin",
    cliPath: "/usr/local/lib/node_modules/@bastra-recall/daemon/dist/cli/update.js",
    find: () => "/usr/local/bin/npm",
    run: (_bin, args) => {
      calls.push(args.join(" "));
      return { ok: true, signal: false, detail: "ok" };
    },
    captured: (_bin, args) => {
      calls.push(args.join(" "));
      return { ok: true, signal: false, detail: "ok", stdout: "/usr/local\n", stderr: "" };
    },
    preflight: async () => {
      calls.push("preflight");
      return { ok: true, dirty: [], notes: [] };
    },
    install: async () => {
      calls.push("install");
      return 0;
    },
    refresh: async () => {
      calls.push("refresh");
      return { ok: true, detail: "ok" };
    },
  };
  return { io, calls };
}

for (const staged of [false, true]) {
  test(`bastra update on Node 22 installs nothing (staged=${staged})`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "bastra-node-support-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    let out = "";
    t.mock.method(process.stdout, "write", (s: string) => {
      out += s;
      return true;
    });
    try {
      const { io, calls } = refusingIo();
      assert.equal(await cmdUpdate(parseArgs(["update", ...(staged ? ["--staged"] : [])]), io), 1);
      assert.deepEqual(calls, [], "no preflight, no npm, no re-registration, no autostart change");
      assert.match(out, /Update Node\.js first, then run 'bastra update'/);
      assert.match(out, /Nothing was installed/);
      const blocked = await readBlockedUpdate(home);
      if (staged) {
        assert.ok(blocked, "the unattended refusal is left for the next SessionStart");
        assert.match(blocked.reason, /Node\.js 22\.23\.5/);
      } else {
        assert.equal(blocked, null, "an interactive refusal is read right now and pauses nothing");
      }
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
}
