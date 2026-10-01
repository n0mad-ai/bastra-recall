/**
 * Every env kill switch reads the same values: 0 | false | off | no is off,
 * 1 | true | on | yes is on — any case, whitespace ignored. Before, some
 * switches took only "off" (BASTRA_TELEMETRY=0 kept writing telemetry) and
 * others only "0"; BASTRA_RM_ARCHIVES=true fell through to "off".
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/env-off-switch.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { envBool, envOff, isOffValue, isOnValue } from "../src/env.js";
import { Telemetry } from "../src/telemetry.js";
import { archiveMode } from "../src/bash-pre-patterns.js";
import { mcpEnvFeatures } from "../src/cli/helpers.js";

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

test("one parser: off and on values, any case, whitespace ignored", () => {
  for (const v of ["0", "false", "off", "no", "OFF", " No ", "False"]) assert.equal(isOffValue(v), true, v);
  for (const v of ["1", "true", "on", "yes", "ON", " Yes "]) assert.equal(isOnValue(v), true, v);
  for (const v of [undefined, null, "", "host", "maybe"]) {
    assert.equal(isOffValue(v), false, String(v));
    assert.equal(isOnValue(v), false, String(v));
  }
  withEnv({ BASTRA_X_SWITCH: "no" }, () => {
    assert.equal(envOff("BASTRA_X_SWITCH"), true);
    assert.equal(envBool("BASTRA_X_SWITCH", true), false);
  });
  withEnv({ BASTRA_X_SWITCH: undefined }, () => assert.equal(envOff("BASTRA_X_SWITCH"), false, "unset is not off"));
});

test("BASTRA_TELEMETRY=0 / no / false switch telemetry off, not only \"off\"", () => {
  for (const v of ["0", "no", "false", "off"]) {
    withEnv({ BASTRA_TELEMETRY: v, NEXUS_TELEMETRY: undefined }, () => {
      assert.equal(new Telemetry().isEnabled(), false, `BASTRA_TELEMETRY=${v}`);
    });
  }
  withEnv({ BASTRA_TELEMETRY: undefined, NEXUS_TELEMETRY: undefined }, () => {
    assert.equal(new Telemetry().isEnabled(), true, "unset stays on");
  });
});

test("BASTRA_RM_ARCHIVES=true opts in like 1, and no/off opt out over the setting", () => {
  withEnv({ BASTRA_RM_ARCHIVES: "true" }, () => assert.equal(archiveMode(false), "bastra"));
  withEnv({ BASTRA_RM_ARCHIVES: "yes" }, () => assert.equal(archiveMode(false), "bastra"));
  withEnv({ BASTRA_RM_ARCHIVES: "no" }, () => assert.equal(archiveMode(true), "off"));
  withEnv({ BASTRA_RM_ARCHIVES: "Host" }, () => assert.equal(archiveMode(false), "host"));
});

test("doctor reads BASTRA_MCP_SESSION_CONTEXT in a client entry like the forwarder does", () => {
  // Regression: helpers.ts compared against "0" only, so doctor reported the
  // switch as on for values the forwarder (envOff) already treats as off.
  for (const v of ["0", "false", "off", "no", " No "]) {
    assert.deepEqual(
      mcpEnvFeatures({ command: "node", env: { BASTRA_MCP_SESSION_CONTEXT: v } }, "/c.json"),
      { sessionContextOff: true, mcpConfig: "/c.json" },
      v,
    );
  }
  for (const v of ["1", "true", "on", ""]) {
    assert.deepEqual(mcpEnvFeatures({ command: "node", env: { BASTRA_MCP_SESSION_CONTEXT: v } }, "/c.json"), {}, v);
  }
});
