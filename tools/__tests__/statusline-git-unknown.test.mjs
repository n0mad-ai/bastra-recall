/**
 * getStatusWithBranchAsync returned status "clean" from its catch block, so a
 * timeout, a locked index or a broken repo drew the same clean symbol as a
 * verified clean tree. A failed `git status` must surface as "unknown" -> "?".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../../packages/statusline/src/segments/git.ts";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";

async function gitInfoWith(statusOutput) {
  const dir = mkdtempSync(join(tmpdir(), "statusline-git-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  try {
    const svc = new GitService();
    svc.execGitAsync = async (cmd) => {
      if (cmd.startsWith("git status")) {
        if (statusOutput === null) throw new Error("index.lock exists");
        return { stdout: statusOutput };
      }
      throw new Error("not stubbed");
    };
    return await svc.getGitInfo(dir, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderGit(info) {
  const renderer = new PowerlineRenderer(structuredClone(DEFAULT_CONFIG));
  return renderer.segmentRenderer.renderGit(
    info,
    renderer.getThemeColors(),
    { enabled: true },
  ).text;
}

test("a failed git status is reported as unknown, not clean", async () => {
  const info = await gitInfoWith(null);
  assert.equal(info.status, "unknown");
  assert.ok(renderGit(info).endsWith("?"));
});

test("a verified clean tree is still clean", async () => {
  const info = await gitInfoWith("## main\n");
  assert.equal(info.status, "clean");
  assert.ok(!renderGit(info).endsWith("?"));
});
