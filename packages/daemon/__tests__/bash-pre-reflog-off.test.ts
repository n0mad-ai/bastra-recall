import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPattern } from "../src/bash-pre-analysis.js";

test("reflog-off amend settings are destructive, while unrelated git commands stay clear", () => {
  for (const value of ["false", "0", "no", "off"]) {
    const command = `git -c core.logAllRefUpdates=${value} commit --amend --no-edit`;
    assert.equal(matchPattern(command)?.label, "git commit --amend (reflog off)", command);
    assert.equal(matchPattern(`git -c core.logAllRefUpdates=${value} fetch`), null);
  }
  assert.equal(matchPattern("git reflog drop --all")?.label, "git reflog drop");
});
