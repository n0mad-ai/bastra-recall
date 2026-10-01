import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

test("the release workflow stages the stub manifest for npm, not the local desktop bundle", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/publish-npm.yml"), "utf8");
  const publishAt = workflow.indexOf("\n  publish:");
  const desktopAt = workflow.indexOf("\n  desktop-extension:");
  const installerAt = workflow.indexOf("\n  installer-scripts:");
  assert.ok(publishAt >= 0 && desktopAt > publishAt && installerAt > desktopAt);

  const publish = workflow.slice(publishAt, desktopAt);
  const desktop = workflow.slice(desktopAt, installerAt);
  assert.match(publish, /stub-manifest\.mjs stub-checksums --out packages\/daemon\/stub\/manifest\.json/);
  assert.match(desktop, /npm run build:mcpb:local --workspace=@bastra-recall\/daemon/);
  assert.doesNotMatch(desktop, /stub-manifest\.mjs/);

  const pkg = JSON.parse(readFileSync(resolve(root, "packages/daemon/package.json"), "utf8"));
  assert.ok(pkg.files.includes("stub/manifest.json"), "npm includes the manifest when publish staged it");
  assert.match(readFileSync(resolve(root, ".gitignore"), "utf8"), /^packages\/daemon\/stub\/manifest\.json$/m);
});
