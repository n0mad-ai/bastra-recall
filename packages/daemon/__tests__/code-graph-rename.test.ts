import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unresolvedEntries } from "../src/code-graph/applies-to.js";
import { isGitRepo } from "../src/code-graph/git-paths.js";
import {
  commitBefore,
  formatOffers,
  parseNameStatus,
  renameOffers,
  renamesSince,
  resolvePath,
} from "../src/code-graph/rename-evidence.js";

const run = promisify(execFile);

/** Deterministic, identity-free commits: no global config, no signing. */
async function git(repo: string, args: string[], at?: string): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(at === undefined ? {} : { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return stdout;
}

/** Distinct, ascending commit dates: `commitBefore` resolves by timestamp, and
 *  four commits in the same second would make that lookup ambiguous. */
async function commit(repo: string, message: string, at: string): Promise<string> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], at);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

/** Long enough that git's rename detection has something to score. */
function body(name: string): string {
  return Array.from({ length: 40 }, (_, i) => `export const ${name}_${i} = ${i};`).join("\n") + "\n";
}

let repo: string;
let base = "";
let afterMove = "";

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "rename-evidence-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await mkdir(join(repo, "src"), { recursive: true });

  // Commit 1: two files that will each be treated differently afterwards.
  await writeFile(join(repo, "src/moved.ts"), body("moved"), "utf8");
  await writeFile(join(repo, "src/dropped.ts"), body("dropped"), "utf8");
  base = await commit(repo, "base", "2026-01-01T10:00:00+00:00");

  // Commit 2: a real move, recorded as one event.
  await git(repo, ["mv", "src/moved.ts", "src/renamed.ts"]);
  afterMove = await commit(repo, "git mv", "2026-01-01T10:01:00+00:00");

  // Commit 3: the file is deleted, alone.
  await unlink(join(repo, "src/dropped.ts"));
  await commit(repo, "delete", "2026-01-01T10:02:00+00:00");

  // Commit 4: a near-identical file appears, in a SEPARATE commit.
  await writeFile(join(repo, "src/lookalike.ts"), body("dropped"), "utf8");
  await commit(repo, "add lookalike", "2026-01-01T10:03:00+00:00");
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("git rename evidence", () => {
  it("reports a git mv as a rename with the new path", async () => {
    const lookup = await renamesSince(repo, base);
    assert.equal(lookup.available, true);
    if (!lookup.available) return;
    const moved = lookup.renames.find((r) => r.from === "src/moved.ts");
    assert.ok(moved, "the git mv is in the evidence");
    assert.equal(moved.to, "src/renamed.ts");
    assert.equal(moved.commit, afterMove);
  });

  it("does NOT report a delete and a similar add in separate commits", async () => {
    const lookup = await renamesSince(repo, base);
    assert.equal(lookup.available, true);
    if (!lookup.available) return;
    assert.equal(
      lookup.renames.some((r) => r.from === "src/dropped.ts"),
      false,
      "a delete in one commit and an add in the next is two facts, not a rename",
    );
  });

  it("proves the point: the range diff alone WOULD call it a rename", async () => {
    // This is what a `git diff base..HEAD -M` pairs up across commits, and the
    // reason the walk goes commit by commit. If git ever stopped pairing them,
    // this assertion fails and the per-commit walk is no longer load-bearing.
    const out = await git(repo, ["diff", "--name-status", "-M", `${base}..HEAD`]);
    const ranged = parseNameStatus(out, "range");
    assert.ok(
      ranged.some((r) => r.from === "src/dropped.ts" && r.to === "src/lookalike.ts"),
      "the range diff pairs the delete with the later add",
    );
  });

  it("offers the new path for a stale entry, and offers nothing else", async () => {
    const memories = [
      { id: "m-moved", affects_files: ["src/moved.ts#moved_0"] },
      { id: "m-dropped", affects_files: ["src/dropped.ts"] },
    ];
    const exists = (f: string) => f === "src/renamed.ts" || f === "src/lookalike.ts";
    const unresolved = unresolvedEntries(memories, { exists });
    assert.equal(unresolved.length, 2);

    const offers = renameOffers(unresolved, await renamesSince(repo, base));
    assert.equal(offers.length, 1);
    assert.equal(offers[0]?.memoryId, "m-moved");
    assert.equal(offers[0]?.to, "src/renamed.ts");
    assert.equal(offers[0]?.suggestedEntry, "src/renamed.ts#moved_0");
    assert.match(formatOffers(offers)[0] ?? "", /offered, not applied/);

    // The deleted file stays unresolved — that is the honest state.
    assert.equal(
      unresolved.some((u) => u.file === "src/dropped.ts" && u.reason === "file-missing"),
      true,
    );
  });

  it("anchors the range on the memory's last update date", async () => {
    const iso = (await git(repo, ["show", "-s", "--format=%cI", base])).trim();
    assert.equal(await commitBefore(repo, iso), base);
    const lookup = await renamesSince(repo, await commitBefore(repo, iso));
    assert.equal(lookup.available, true);
  });

  it("refuses a range git does not know", async () => {
    const lookup = await renamesSince(repo, "0000000000000000000000000000000000000000");
    assert.deepEqual(lookup, { available: false, reason: "bad-range" });
  });
});

describe("outside a git repository", () => {
  let plain: string;

  before(async () => {
    plain = await mkdtemp(join(tmpdir(), "rename-nogit-"));
  });

  after(async () => {
    await rm(plain, { recursive: true, force: true });
  });

  it("claims no rename and leaves the entry unresolved", async () => {
    assert.equal(await isGitRepo(plain), false);
    const lookup = await renamesSince(plain, null);
    assert.deepEqual(lookup, { available: false, reason: "not-a-repo" });
    const unresolved = unresolvedEntries([{ id: "m", affects_files: ["src/gone.ts"] }], {
      exists: () => false,
    });
    assert.deepEqual(renameOffers(unresolved, lookup), []);
    assert.equal(unresolved[0]?.reason, "file-missing");
  });
});

describe("chaining and refusals", () => {
  const chain = [
    { from: "a.ts", to: "b.ts", similarity: 100, commit: "c1" },
    { from: "b.ts", to: "c.ts", similarity: 98, commit: "c2" },
  ];

  it("follows a path that moved twice", () => {
    assert.deepEqual(resolvePath("a.ts", chain), { to: "c.ts", similarity: 98, commit: "c2" });
  });

  it("returns null for a path git never moved", () => {
    assert.equal(resolvePath("z.ts", chain), null);
  });

  it("refuses a rename cycle", () => {
    const cycle = [...chain, { from: "c.ts", to: "a.ts", similarity: 100, commit: "c3" }];
    assert.equal(resolvePath("a.ts", cycle), null);
  });

  it("reads only R lines out of --name-status", () => {
    const out = "A\tnew.ts\nD\told.ts\nM\tsame.ts\nR095\tfrom.ts\tto.ts\n";
    assert.deepEqual(parseNameStatus(out, "c1"), [
      { from: "from.ts", to: "to.ts", similarity: 95, commit: "c1" },
    ]);
  });

  it("never offers for a malformed or symbol-only mismatch", () => {
    const lookup = { available: true as const, renames: chain };
    const offers = renameOffers(
      [
        { memoryId: "m1", entry: "/abs", file: "", symbol: null, reason: "not-repo-relative" as const },
        { memoryId: "m2", entry: "a.ts#x", file: "a.ts", symbol: "x", reason: "symbol-missing" as const },
      ],
      lookup,
    );
    assert.deepEqual(offers, []);
  });
});
