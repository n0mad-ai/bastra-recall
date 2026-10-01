/**
 * getDisplayDirectoryName used a bare startsWith(projectDir), so the sibling
 * directory /w/app-backup/src against project /w/app was sliced to
 * "ackup/src". The prefix has to end at a path separator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";

function directory(currentDir, projectDir) {
  const renderer = new PowerlineRenderer(structuredClone(DEFAULT_CONFIG));
  return renderer.segmentRenderer.renderDirectory(
    { workspace: { current_dir: currentDir, project_dir: projectDir } },
    renderer.getThemeColors(),
    { enabled: true, style: "full" },
  ).text;
}

test("a sibling sharing the project path as a prefix keeps its full path", () => {
  assert.equal(directory("/w/app-backup/src", "/w/app"), "/w/app-backup/src");
});

test("a real subdirectory is still shown relative to the project", () => {
  assert.equal(directory("/w/app/src/lib", "/w/app"), "src/lib");
  assert.equal(directory("/w/app/src", "/w/app/"), "src");
});
