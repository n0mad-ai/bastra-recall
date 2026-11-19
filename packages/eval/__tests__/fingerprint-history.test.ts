import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs script without type declarations
import { RECIPES, history } from "../scripts/fingerprint-history.mjs";
// @ts-expect-error — plain .mjs script, no declarations
import { dropCallerGitEnv } from "../../../scripts/caller-git-env.mjs";

// #1669: started without test-env.mjs, this file's git must still not reach a caller's GIT_DIR/GIT_WORK_TREE.
dropCallerGitEnv();

interface Recipe {
  files: string[];
}
interface Row {
  sha256: string;
  first_commit: string;
}
interface Mapping {
  formatter_commit: string;
  formatter_breaks: {
    recipe: string;
    registered_sha256: string;
    registered_at_commit: string;
    after_reformat_sha256: string;
    registrations: string[];
  }[];
}

const regDir = join(import.meta.dirname, "..", "registrations");
const map = JSON.parse(readFileSync(join(regDir, "fingerprint-map-1536.json"), "utf8")) as Mapping;

const hasHistory = (() => {
  try {
    execFileSync("git", ["cat-file", "-e", `${map.formatter_commit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test(
  "every mapped pair is recomputed from git: registered hash, then the Prettier commit (#1536)",
  { skip: !hasHistory && "shallow clone" },
  () => {
    const recipes = RECIPES as Record<string, Recipe>;
    for (const e of map.formatter_breaks) {
      const rows = (history as (r: Recipe) => Row[])(recipes[e.recipe]);
      const i = rows.findIndex((r) => r.sha256 === e.registered_sha256);
      assert.ok(i >= 0, `${e.recipe}: registered hash not reproduced`);
      assert.equal(rows[i].first_commit, e.registered_at_commit, e.recipe);
      assert.deepEqual(
        { sha256: rows[i + 1].sha256, commit: rows[i + 1].first_commit },
        { sha256: e.after_reformat_sha256, commit: map.formatter_commit },
        `${e.recipe}: the next fingerprint must come from the formatter commit and nothing between`
      );
    }
  }
);

test("the mapping names hashes the frozen registrations really carry (#1536)", () => {
  for (const e of map.formatter_breaks)
    for (const f of e.registrations)
      assert.ok(readFileSync(join(regDir, f), "utf8").includes(e.registered_sha256), `${f} ${e.recipe}`);
});
