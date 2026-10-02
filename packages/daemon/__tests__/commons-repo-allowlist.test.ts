/**
 * #260 — `BASTRA_COMMONS_REPO` is a free-form env var that feeds both
 * `git clone` and `gh pr create --repo`. The clone is read-only, but the PR
 * path is egress: a redirected repo would receive verification records and
 * scrubbed bridges. This mirrors the `assertLocalOrOptIn` posture from
 * `packages/core/src/ollama-egress.ts` — default target only, anything else
 * needs an explicit opt-in.
 *
 * First tests for `cli/commons.ts` at all.
 *
 * Runner: `tsx --test __tests__/commons-repo-allowlist.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commonsRepoRefusal, commonsRepoSlug } from "../src/cli/commons.js";

function withoutOptIn<T>(fn: () => T): T {
  const prev = process.env.BASTRA_ALLOW_REMOTE_COMMONS;
  delete process.env.BASTRA_ALLOW_REMOTE_COMMONS;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_ALLOW_REMOTE_COMMONS;
    else process.env.BASTRA_ALLOW_REMOTE_COMMONS = prev;
  }
}

test("the default target passes", () => {
  withoutOptIn(() => {
    assert.equal(commonsRepoRefusal("https://github.com/n0mad-ai/bastra-commons.git"), null);
    assert.equal(commonsRepoRefusal("https://github.com/n0mad-ai/bastra-commons"), null);
    assert.equal(commonsRepoRefusal("git@github.com:n0mad-ai/bastra-commons.git"), null);
    assert.equal(commonsRepoRefusal("ssh://git@github.com/n0mad-ai/bastra-commons.git"), null);
  });
});

test("a foreign host is refused, and the message names the target", () => {
  withoutOptIn(() => {
    const refusal = commonsRepoRefusal("https://evil.example/n0mad-ai/bastra-commons.git");
    assert.ok(refusal, "a foreign host must be refused");
    assert.match(refusal!, /evil\.example/, "the refusal must name what it refused");
    assert.match(refusal!, /BASTRA_ALLOW_REMOTE_COMMONS/, "the refusal must name the opt-in");
  });
});

test("a foreign owner on the right host is refused too", () => {
  withoutOptIn(() => {
    assert.ok(commonsRepoRefusal("https://github.com/someone-else/bastra-commons.git"));
    assert.ok(commonsRepoRefusal("git@github.com:someone-else/bastra-commons.git"));
  });
});

test("host matching is case-insensitive and not prefix-fooled", () => {
  withoutOptIn(() => {
    assert.equal(commonsRepoRefusal("https://GitHub.com/N0mad-AI/bastra-commons.git"), null);
    // The classic near-miss: a host that merely ENDS with the allowed one.
    assert.ok(commonsRepoRefusal("https://github.com.evil.example/n0mad-ai/x.git"));
    assert.ok(commonsRepoRefusal("https://notgithub.com/n0mad-ai/x.git"));
  });
});

test("unparseable and non-remote forms are refused — fail closed, not fall through", () => {
  withoutOptIn(() => {
    // Unlike the Ollama guard (where a bad URL just makes fetch fail), git
    // would happily clone these, so an unrecognized shape must not pass.
    assert.ok(commonsRepoRefusal("not a url"));
    assert.ok(commonsRepoRefusal("/tmp/somewhere"));
    assert.ok(commonsRepoRefusal("file:///tmp/somewhere"));
    assert.ok(commonsRepoRefusal(""));
    assert.ok(commonsRepoRefusal("https://github.com/n0mad-ai"), "owner without repo is not a repo url");
  });
});

test("the explicit opt-in lets any target through", () => {
  const prev = process.env.BASTRA_ALLOW_REMOTE_COMMONS;
  process.env.BASTRA_ALLOW_REMOTE_COMMONS = "1";
  try {
    assert.equal(commonsRepoRefusal("https://evil.example/someone/else.git"), null);
    assert.equal(commonsRepoRefusal("/tmp/local-mirror"), null);
  } finally {
    if (prev === undefined) delete process.env.BASTRA_ALLOW_REMOTE_COMMONS;
    else process.env.BASTRA_ALLOW_REMOTE_COMMONS = prev;
  }
});

// #787 (owner decision 2026-10-02): every on/off switch reads the same words,
// so `true`/`on`/`yes` opt in like `1` — this test pinned "only the literal 1"
// before. What it guards stays: an off word, a typo or an empty value never
// opens the target (env-switches-787.test.ts pins the on words).
test("only an on word opts in — an off word, a typo or an empty value does not", () => {
  const prev = process.env.BASTRA_ALLOW_REMOTE_COMMONS;
  try {
    for (const value of ["0", "false", "no", "tru", "2", "enabled", ""]) {
      process.env.BASTRA_ALLOW_REMOTE_COMMONS = value;
      assert.ok(commonsRepoRefusal("https://evil.example/x/y.git"), `"${value}" must not count as opt-in`);
    }
  } finally {
    if (prev === undefined) delete process.env.BASTRA_ALLOW_REMOTE_COMMONS;
    else process.env.BASTRA_ALLOW_REMOTE_COMMONS = prev;
  }
});

test("commonsRepoSlug derives owner/repo for `gh pr create --repo` from every accepted form", () => {
  assert.equal(commonsRepoSlug("https://github.com/n0mad-ai/bastra-commons.git"), "n0mad-ai/bastra-commons");
  assert.equal(commonsRepoSlug("https://github.com/n0mad-ai/bastra-commons"), "n0mad-ai/bastra-commons");
  assert.equal(commonsRepoSlug("git@github.com:n0mad-ai/bastra-commons.git"), "n0mad-ai/bastra-commons");
  assert.equal(commonsRepoSlug("ssh://git@github.com/n0mad-ai/bastra-commons.git"), "n0mad-ai/bastra-commons");
  // The old inline `.replace(/^https:\/\/github\.com\//, "")` silently produced
  // a garbage --repo argument for the ssh forms; null is the honest answer.
  assert.equal(commonsRepoSlug("/tmp/local-mirror"), null);
});
