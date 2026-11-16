/**
 * The .mcpb build checks every installed copy of a pinned package against the
 * repo's pin. A prerelease of the pinned version must not pass a caret pin:
 * `4.13.19-beta.1` sorts below `4.13.19`, the release the pin asks for.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/mcpb-pins.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- a plain .mjs build helper without type declarations
import { assertLockPackages, satisfiesPin } from "../scripts/mcpb-pins.mjs";

test("a caret pin takes the release and later compatible ones, never a prerelease", () => {
  for (const ok of ["4.13.19", "4.13.20", "4.14.0", "4.13.19+build.7"])
    assert.equal(satisfiesPin(ok, "^4.13.19"), true, ok);
  for (const bad of ["4.13.19-beta.1", "4.14.0-rc.1", "4.13.18", "5.0.0", "3.99.99", "", undefined])
    assert.equal(satisfiesPin(bad, "^4.13.19"), false, String(bad));
  // Zero major: the minor is fixed; zero minor too: the patch is fixed.
  assert.equal(satisfiesPin("0.2.7", "^0.2.6"), true);
  assert.equal(satisfiesPin("0.3.0", "^0.2.6"), false);
  assert.equal(satisfiesPin("0.2.6-alpha", "^0.2.6"), false);
  // Exact pins compare the whole version.
  assert.equal(satisfiesPin("2.0.1", "2.0.1"), true);
  assert.equal(satisfiesPin("2.0.1-beta.1", "2.0.1"), false);
});

test("a nested copy of a pinned package is checked like the top-level one", () => {
  const pins = { hono: "^4.13.19", "@hono/node-server": "^2.1.8" };
  const good = {
    "": { name: "server" },
    "node_modules/hono": { version: "4.13.19" },
    "node_modules/@hono/node-server": { version: "2.1.8" },
    "node_modules/other": { version: "1.0.0" },
  };
  assert.doesNotThrow(() => assertLockPackages(good, pins));
  assert.throws(
    () => assertLockPackages({ ...good, "node_modules/x/node_modules/hono": { version: "4.13.19-beta.1" } }, pins),
    /node_modules\/x\/node_modules\/hono@4\.13\.19-beta\.1 does not satisfy/
  );
  assert.throws(
    () => assertLockPackages({ ...good, "node_modules/x/node_modules/@hono/node-server": { version: "2.1.7" } }, pins),
    /@hono\/node-server@\^2\.1\.8/
  );
});
