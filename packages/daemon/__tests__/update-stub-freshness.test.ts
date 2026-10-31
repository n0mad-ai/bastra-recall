import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySourceStubs } from "../src/cli/update.js";

function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bastra-update-stub-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "stub")); mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "stub/bastra-hook.ts"), "// source");
  writeFileSync(join(root, "scripts/stub-source-digest.mjs"), 'export const stubSourceDigest = () => "fresh";');
  return { home: root, packageRoot: root, ownBinary: join(root, "stub/bastra-hook"), exists: () => true,
    statuslineDigest: async () => "bundle", stamp: () => ({ source_digest: "fresh", statusline_digest: "bundle" }) };
}
for (const [name, stamp] of Object.entries({
  stale: { source_digest: "old", statusline_digest: "bundle" },
  "stale embedded statusline": { source_digest: "fresh", statusline_digest: "old" },
  unstamped: {}, unreadable: null,
})) test(`source update refuses ${name} hook before registration or reload`, async t => {
  const io = fixture(t); const output: string[] = [];
  const rc = await verifySourceStubs(s => output.push(s), { ...io, stamp: () => stamp });
  assert.equal(rc, 1); assert.match(output.join(""), /build:deploy/);
});
test("source update accepts verified own stub even before client registration", async t => {
  assert.equal(await verifySourceStubs(() => {}, fixture(t)), 0);
});
test("source update accepts node thin clients when no compiled stub exists", async t => {
  assert.equal(await verifySourceStubs(() => {}, { ...fixture(t), exists: () => false }), 0);
});
test("source update refuses a missing registered hook instead of treating it as node-only", async t => {
  const io = fixture(t);
  mkdirSync(join(io.home, ".claude"));
  writeFileSync(join(io.home, ".claude/settings.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ command: `'${io.ownBinary}' gate` }] }],
  } }));
  assert.equal(await verifySourceStubs(() => {}, { ...io, exists: () => false }), 1);
});

test("foreign stale registration recommends reinstall, not a build that leaves it untouched", async t => {
  const io = fixture(t);
  mkdirSync(join(io.home, ".claude"));
  const foreign = join(io.home, "other", "bastra-hook");
  writeFileSync(join(io.home, ".claude/settings.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ command: `'${foreign}' gate` }] }],
  } }));
  const output: string[] = [];
  assert.equal(await verifySourceStubs(s => output.push(s), {
    ...io, stamp: binary => ({ source_digest: binary === foreign ? "old" : "fresh", statusline_digest: "bundle" }),
  }), 1);
  assert.match(output.join(""), /bastra install claude-code/);
  assert.doesNotMatch(output.join(""), /build:deploy|build:stub/);
});
