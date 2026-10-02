/**
 * Follow-up to #787: the switches that still compared by hand read the same
 * words as the rest — 0 | false | off | no is off, 1 | true | on | yes is on.
 * A variable with more states keeps them (`host`, `shadow`, `live`, a size)
 * and reads its off value through the same parser.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/env-switches-787.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { banterModeFromEnv } from "@bastra-recall/core";
import { gitShim, gitShimSwitchedOff, rmShim, rmShimSwitchedOff } from "../src/bash-pre-patterns.js";
import { archiveMaxItem } from "../src/rm-archive.js";
import { commonsRepoRefusal } from "../src/cli/commons.js";
import { daemonOrigin } from "../src/daemon-spawn-env.js";
import { queryRouterMode } from "../src/http-hook-routes.js";
import { salienceRankMode } from "../src/salience-shadow.js";
import { trustRankMode } from "../src/trust-shadow.js";
import { hintSuppressionMode } from "../src/hint-suppression.js";
import { isOptedOut } from "../src/update-check.js";

const OFF = ["0", "false", "off", "no", " No "];
const ON = ["1", "true", "on", "yes", " YES "];

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("rm/git shim and 'shim switched off' are complements for every off and on word", () => {
  // Before #787 the pair compared against "0" only: BASTRA_RM_SHIM=off left
  // the shim on. The shims exist in the checkout (packages/daemon/shims).
  const pairs = [
    ["BASTRA_RM_SHIM", rmShim, rmShimSwitchedOff],
    ["BASTRA_GIT_SHIM", gitShim, gitShimSwitchedOff],
  ] as const;
  for (const [name, shim, switchedOff] of pairs) {
    for (const v of OFF) {
      withEnv({ BASTRA_RM_ARCHIVES: "1", [name]: v }, () => {
        assert.equal(shim("claude-code"), false, `${name}=${v}`);
        assert.equal(switchedOff("claude-code"), true, `${name}=${v}`);
      });
    }
    for (const v of [undefined, ...ON]) {
      withEnv({ BASTRA_RM_ARCHIVES: "1", [name]: v }, () => {
        assert.equal(shim("claude-code"), true, `${name}=${v}`);
        assert.equal(switchedOff("claude-code"), false, `${name}=${v}`);
      });
    }
    // Not opted in: neither, whatever the shim switch says.
    withEnv({ BASTRA_RM_ARCHIVES: "no", [name]: "off" }, () => {
      assert.equal(shim("claude-code", true), false);
      assert.equal(switchedOff("claude-code", true), false);
    });
  }
});

test("opt-ins that only took \"1\" take every on word, and nothing else", () => {
  const foreign = "https://example.com/someone/commons.git";
  for (const v of ON) {
    withEnv({ BASTRA_ALLOW_REMOTE_COMMONS: v }, () => assert.equal(commonsRepoRefusal(foreign), null, v));
    assert.equal(daemonOrigin({ BASTRA_AUTOSTART_MANAGED: v }).startedBy, "launchagent", v);
  }
  for (const v of [undefined, "", "maybe", ...OFF]) {
    withEnv({ BASTRA_ALLOW_REMOTE_COMMONS: v }, () => assert.notEqual(commonsRepoRefusal(foreign), null, String(v)));
    assert.equal(daemonOrigin({ BASTRA_AUTOSTART_MANAGED: v }).startedBy, "direct", String(v));
  }
});

test("a variable with more states keeps them and reads its off value like every switch", () => {
  for (const v of OFF) {
    assert.equal(archiveMaxItem({ BASTRA_ARCHIVE_MAX_ITEM: v }, "2GB"), null, `max-item ${v} lifts the stored limit`);
    assert.equal(banterModeFromEnv({ BASTRA_BANTER: v }), "off", `banter ${v}`);
    withEnv({ BASTRA_QUERY_ROUTER: v, BASTRA_SALIENCE_RANK: v, BASTRA_TRUST_RANK: v, BASTRA_HINT_SUPPRESS: v, BASTRA_UPDATE_CHECK: v }, () => {
      assert.equal(queryRouterMode(), "off", `router ${v}`);
      assert.equal(salienceRankMode(), "off", `salience ${v}`);
      assert.equal(trustRankMode(), "off", `trust ${v}`);
      assert.equal(hintSuppressionMode(), "off", `hint-suppress ${v}`);
      assert.equal(isOptedOut(), true, `update-check ${v}`);
    });
  }
  // The extra values are untouched.
  assert.equal(archiveMaxItem({ BASTRA_ARCHIVE_MAX_ITEM: "500MB" }, "2GB"), 500 * 1024 * 1024);
  assert.equal(archiveMaxItem({}, "2GB"), 2 * 1024 ** 3);
  assert.equal(banterModeFromEnv({ BASTRA_BANTER: "terse" }), "terse");
  assert.equal(banterModeFromEnv({}), "on");
  withEnv({ BASTRA_QUERY_ROUTER: "shadow", BASTRA_SALIENCE_RANK: "live", BASTRA_TRUST_RANK: "live" }, () => {
    assert.equal(queryRouterMode(), "shadow");
    assert.equal(salienceRankMode(), "live");
    assert.equal(trustRankMode(), "live");
  });
  withEnv({ BASTRA_QUERY_ROUTER: undefined, BASTRA_SALIENCE_RANK: undefined, BASTRA_TRUST_RANK: undefined, BASTRA_UPDATE_CHECK: undefined }, () => {
    assert.equal(queryRouterMode(), "live");
    assert.equal(salienceRankMode(), "shadow");
    assert.equal(trustRankMode(), "shadow");
    assert.equal(isOptedOut(), false);
  });
});
