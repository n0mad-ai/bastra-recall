import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

test("the release workflow stages the stub manifest for npm and for the desktop bundle (#957)", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/publish-npm.yml"), "utf8");
  const publishAt = workflow.indexOf("\n  publish:");
  const desktopAt = workflow.indexOf("\n  desktop-extension:");
  const installerAt = workflow.indexOf("\n  installer-scripts:");
  assert.ok(publishAt >= 0 && desktopAt > publishAt && installerAt > desktopAt);

  const publish = workflow.slice(publishAt, desktopAt);
  const desktop = workflow.slice(desktopAt, installerAt);
  assert.match(publish, /stub-manifest\.mjs stub-checksums --out packages\/daemon\/stub\/manifest\.json/);
  assert.match(desktop, /npm run build:mcpb:local --workspace=@bastra-recall\/daemon/);
  // #957: the manifest is written before the bundle is packed, from the same checksums.
  const manifestAt = desktop.search(/stub-manifest\.mjs stub-checksums --out packages\/daemon\/stub\/manifest\.json/);
  assert.ok(manifestAt >= 0, "desktop job stages the stub manifest");
  assert.ok(manifestAt < desktop.indexOf("build:mcpb:local"), "staged before build:mcpb:local");
  assert.match(desktop, /pattern: stub-checksums-\*/);
  assert.match(desktop, /needs: \[gate, stub\]/);
  assert.match(desktop, /unzip -l packages\/daemon\/mcpb\/\*\.mcpb \| grep -q 'daemon\/stub\/manifest\.json'/);

  const pkg = JSON.parse(readFileSync(resolve(root, "packages/daemon/package.json"), "utf8"));
  assert.ok(pkg.files.includes("stub/manifest.json"), "npm includes the manifest when publish staged it");
  assert.match(readFileSync(resolve(root, ".gitignore"), "utf8"), /^packages\/daemon\/stub\/manifest\.json$/m);
});
