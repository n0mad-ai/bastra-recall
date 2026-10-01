import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPattern } from "../src/bash-pre-lane.js";

test("a git message after --work-tree is prose, including a quoted data heredoc", () => {
  for (const command of [
    'git --work-tree /repo commit -m "docs: explain rm -rf build"',
    'git --work-tree /repo commit -m "$(cat <<\'EOF\'\nexplain rm -rf build\nEOF\n)"',
  ]) {
    assert.equal(matchPattern(command), null, command);
  }
  assert.equal(matchPattern('git --work-tree /repo commit -m "docs"; rm -rf /tmp/x')?.label, "rm -rf");
});
