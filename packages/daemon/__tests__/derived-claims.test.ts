/**
 * #467 / #609 — a note binds the claims it took from a file.
 *
 * `derived_claims` names a claim, its source inside the vault and the resolver
 * that re-checks it. `load_memory` resolves each one read-only and reports the
 * verdict under `derived.claims`; the note and the source keep their own bytes.
 *
 * What these tests pin: every verdict lands on exactly one case, a single
 * changed byte moves `matches` to `differs` or `gone`, a file outside the vault
 * stays unopened, and a note without claims reads nothing at all.
 *
 * Runner: `tsx --test __tests__/derived-claims.test.ts`
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SearchIndex, Vault } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { loadMemoryHandler, saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { claimSourceIo } from "../src/derived-claims.js";

async function makeDeps(): Promise<{ deps: ToolDeps; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-derived-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    cleanup: async () => {
      search.stop();
      await vault.stop?.();
      mock.restoreAll();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

const COUNT = "count.markdown-numbered-list.v1" as const;
const SOURCE = "sources/failure-modes.md";
const LIST = "# modes\n\n1. first\n2) second\n3. third\n";

const claim = {
  id: "failure-modes.total",
  resolver: COUNT,
  source: SOURCE,
  case_ref: "case://failure-modes/derived-count",
};

const fact = (extra: Record<string, unknown> = {}) => ({
  title: "Failure modes are counted when read",
  type: "project-fact",
  summary: "The number of failure modes is derived from its source list.",
  body: "The count lives in the source list.",
  topic_path: ["bastra"],
  tags: ["claims"],
  scope: "derivedtest",
  recall_when: ["when the failure mode count is needed"],
  ...extra,
});

/** Writes one source file below the vault and returns its absolute path. */
async function plantSource(deps: ToolDeps, rel: string, text: string): Promise<string> {
  const abs = join(deps.vaultPath, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, text, "utf8");
  return abs;
}

/** Saves a note with these claims and returns what `load_memory` reports. */
async function statusesFor(deps: ToolDeps, claims: readonly unknown[]) {
  const saved = await saveMemoryHandler(deps, fact({ derived_claims: claims }));
  const loaded = await loadMemoryHandler(deps, { id: saved.id });
  return { saved, loaded, claims: loaded.derived?.claims ?? [] };
}

test("#467: load derives a numbered-list count and leaves the memory file as it is", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await plantSource(deps, SOURCE, LIST);
    const saved = await saveMemoryHandler(deps, fact({ derived_claims: [claim] }));
    const before = await readFile(deps.vault.get(saved.id)!.filePath, "utf8");

    const loaded = await loadMemoryHandler(deps, { id: saved.id });

    assert.deepEqual(loaded.derived?.claims, [{ ...claim, status: "observed", value: 3 }]);
    assert.deepEqual(loaded.frontmatter.derived_claims, [claim], "lean callers receive the formula");
    assert.equal(await readFile(deps.vault.get(saved.id)!.filePath, "utf8"), before, "the note keeps its own bytes");
  } finally {
    await cleanup();
  }
});

test("#609: the lean load path carries derived.claims", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await plantSource(deps, SOURCE, LIST);
    // Lean is the default an agent gets; a verdict that only `verbosity:
    // "full"` shows would reach nobody.
    const { loaded } = await statusesFor(deps, [{ ...claim, expect: 3 }]);
    assert.equal(loaded.frontmatter.derived_claims?.length, 1, "lean is the default an agent gets");
    assert.equal(loaded.derived?.claims[0]?.status, "matches");
  } finally {
    await cleanup();
  }
});

test("#609: every verdict is reached, and each case lands on exactly one of them", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await plantSource(deps, SOURCE, LIST);
    await plantSource(deps, "ops/deploy.md", "timeout: 30s\nretries: 2\nnote: retries: 2\n");
    const digest = createHash("sha256").update(LIST).digest("hex");

    const { claims } = await statusesFor(deps, [
      { id: "count-agrees", resolver: COUNT, source: SOURCE, expect: 3 },
      { id: "count-moved-on", resolver: COUNT, source: SOURCE, expect: 27 },
      { id: "count-alone", resolver: COUNT, source: SOURCE },
      { id: "quote-once", resolver: "quote.v1", source: "ops/deploy.md", exact: "timeout: 30s" },
      { id: "quote-out", resolver: "quote.v1", source: "ops/deploy.md", exact: "timeout: 45s" },
      { id: "quote-twice", resolver: "quote.v1", source: "ops/deploy.md", exact: "retries: 2" },
      { id: "digest-agrees", resolver: "sha256.v1", source: SOURCE, expect: digest },
      { id: "digest-moved-on", resolver: "sha256.v1", source: SOURCE, expect: "00".repeat(32) },
      { id: "no-such-source", resolver: COUNT, source: "sources/absent.md", expect: 1 },
    ]);

    assert.deepEqual(Object.fromEntries(claims.map((c) => [c.id, c.status])), {
      "count-agrees": "matches",
      "count-moved-on": "differs",
      "count-alone": "observed",
      "quote-once": "matches",
      "quote-out": "gone",
      "quote-twice": "ambiguous",
      "digest-agrees": "matches",
      "digest-moved-on": "differs",
      "no-such-source": "unverifiable",
    });
    // One `status` per claim is what makes the verdicts exclusive: a case that
    // reached two of them would need two fields.
    for (const c of claims) assert.equal(typeof c.status, "string");
  } finally {
    await cleanup();
  }
});

test("#609: one changed byte in the source turns a count claim from matches into differs", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await plantSource(deps, SOURCE, LIST);
    const declared = { ...claim, expect: 3 };
    const saved = await saveMemoryHandler(deps, fact({ derived_claims: [declared] }));
    assert.equal((await loadMemoryHandler(deps, { id: saved.id })).derived?.claims[0]?.status, "matches");

    // "3." becomes "3-": one byte, and the third line stops being a list item.
    await plantSource(deps, SOURCE, LIST.replace("3. third", "3- third"));

    const after = (await loadMemoryHandler(deps, { id: saved.id })).derived?.claims[0];
    assert.equal(after?.status, "differs");
    assert.equal(after?.value, 2);
    assert.equal(after?.expect, 3, "the reader sees both halves side by side");
  } finally {
    await cleanup();
  }
});

test("#609: one changed byte in the source turns a quote claim from matches into gone", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await plantSource(deps, "ops/deploy.md", "timeout: 30s\n");
    const quote = { id: "timeout", resolver: "quote.v1", source: "ops/deploy.md", exact: "timeout: 30s" };
    const saved = await saveMemoryHandler(deps, fact({ derived_claims: [quote] }));
    assert.equal((await loadMemoryHandler(deps, { id: saved.id })).derived?.claims[0]?.status, "matches");

    await plantSource(deps, "ops/deploy.md", "timeout: 90s\n");

    const after = (await loadMemoryHandler(deps, { id: saved.id })).derived?.claims[0];
    assert.equal(after?.status, "gone");
    assert.equal(after?.value, 0);
  } finally {
    await cleanup();
  }
});

test("#609: a canary outside the vault stays unopened", async () => {
  // The whole boundary argument. A vault-relative source may still walk out
  // through a symlink, so the check follows the link first and reports what it
  // finds instead of reading it.
  const { deps, cleanup } = await makeDeps();
  const canary = join(tmpdir(), `bastra-derived-canary-${process.pid}.md`);
  const canaryText = "1. secret-shaped line\n2. another one\n";
  try {
    await mkdir(join(deps.vaultPath, "sources"), { recursive: true });
    await writeFile(canary, canaryText, "utf8");
    await symlink(canary, join(deps.vaultPath, SOURCE));
    const reads = mock.method(claimSourceIo, "readFile");

    const { claims } = await statusesFor(deps, [claim]);

    assert.deepEqual(claims, [{ ...claim, status: "unverifiable", reason: "outside_vault" }]);
    assert.deepEqual(
      reads.mock.calls.map((c) => String(c.arguments[0])),
      [],
      "the canary stays unopened",
    );
    assert.equal(await readFile(canary, "utf8"), canaryText);
  } finally {
    await rm(canary, { force: true });
    await cleanup();
  }
});

test("#609: a note without derived_claims reads no source at all", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await plantSource(deps, SOURCE, LIST);
    const reads = mock.method(claimSourceIo, "readFile");

    const saved = await saveMemoryHandler(deps, fact());
    const loaded = await loadMemoryHandler(deps, { id: saved.id });

    assert.equal(loaded.derived, undefined, "absent means absent — no empty scaffolding");
    assert.equal(reads.mock.callCount(), 0, "a note that declares nothing costs one undefined check");
  } finally {
    await cleanup();
  }
});

test("#609: after a load the note and its source are byte-identical", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const sourcePath = await plantSource(deps, SOURCE, LIST);
    const saved = await saveMemoryHandler(deps, fact({ derived_claims: [{ ...claim, expect: 27 }] }));
    const noteBefore = await readFile(deps.vault.get(saved.id)!.filePath, "utf8");

    // A `differs` verdict is where an eager implementation would be tempted to
    // write the new number back into one of the two files.
    const loaded = await loadMemoryHandler(deps, { id: saved.id });

    assert.equal(loaded.derived?.claims[0]?.status, "differs");
    assert.equal(await readFile(deps.vault.get(saved.id)!.filePath, "utf8"), noteBefore);
    assert.equal(await readFile(sourcePath, "utf8"), LIST);
  } finally {
    await cleanup();
  }
});

test("#467: a vault-relative symlink that leads outside the vault is reported unverifiable", async () => {
  const { deps, cleanup } = await makeDeps();
  const outside = join(tmpdir(), `bastra-derived-outside-${process.pid}.md`);
  try {
    await mkdir(join(deps.vaultPath, "sources"), { recursive: true });
    await writeFile(outside, "1. secret-shaped line\n", "utf8");
    await symlink(outside, join(deps.vaultPath, SOURCE));

    const { claims } = await statusesFor(deps, [claim]);

    assert.deepEqual(claims, [{ ...claim, status: "unverifiable", reason: "outside_vault" }]);
  } finally {
    await rm(outside, { force: true });
    await cleanup();
  }
});

test("#609: a directory, an oversized file and a missing one are each unverifiable", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await mkdir(join(deps.vaultPath, "sources/as-a-folder"), { recursive: true });
    await plantSource(deps, "sources/huge.md", "1. line\n".repeat(130_000));

    const { claims } = await statusesFor(deps, [
      { id: "a-folder", resolver: COUNT, source: "sources/as-a-folder", expect: 1 },
      { id: "over-a-megabyte", resolver: COUNT, source: "sources/huge.md", expect: 130000 },
      { id: "absent", resolver: COUNT, source: "sources/absent.md", expect: 1 },
    ]);

    assert.deepEqual(
      claims.map((c) => [c.id, c.status, c.reason]),
      [
        ["a-folder", "unverifiable", "not_a_file"],
        ["over-a-megabyte", "unverifiable", "too_large"],
        ["absent", "unverifiable", "unavailable"],
      ],
    );
  } finally {
    await cleanup();
  }
});

test("#467: a traversal source is refused at save, before any resolver runs", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await assert.rejects(
      () => saveMemoryHandler(deps, fact({ derived_claims: [{ ...claim, source: "../outside.md" }] })),
      /source must be a vault-relative path/,
    );
  } finally {
    await cleanup();
  }
});

test("#609: quote.v1 asks for the string it should look for", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await assert.rejects(
      () =>
        saveMemoryHandler(
          deps,
          fact({ derived_claims: [{ id: "timeout", resolver: "quote.v1", source: "ops/deploy.md" }] }),
        ),
      /quote\.v1 needs `exact`/,
    );
  } finally {
    await cleanup();
  }
});
