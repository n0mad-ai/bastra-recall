/**
 * #235 stage 1 — an optional anchor command that can prove a memory's claim.
 *
 * project-facts assert states of the world ("770 tests pass", "endpoint X
 * exists"), and exactly those age silently into false statements that keep
 * being recalled as true. Calendar staleness and usage windows are both blind
 * to content truth; an anchor is not.
 *
 * Stage 1 is DISPLAY-ONLY, and these tests exist mostly to pin that. The field
 * transports a COMMAND, so the guarantees that matter are the negative ones:
 * nothing executes it, and it is never presented as an instruction from bastra.
 * Stage 2 (verdicts, drift-binding, content-driven staleness) needs its own
 * security round and is not here.
 *
 * Runner: `tsx --test __tests__/verify-anchor.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, loadMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";

async function makeDeps(): Promise<{ deps: ToolDeps; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-anchor-"));
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
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

const fact = (extra: Record<string, unknown> = {}) => ({
  title: "Der Daemon hört auf 6723",
  type: "project-fact",
  summary: "Der HTTP-Server des Daemons lauscht auf 127.0.0.1:6723.",
  body: "Port ist in http.ts festgelegt.",
  topic_path: ["bastra"],
  tags: ["daemon"],
  scope: "ankertest",
  recall_when: ["wenn der Daemon-Port gebraucht wird"],
  ...extra,
});

const ANCHOR = "curl -s localhost:6723/health";

test("#235: the anchor is persisted to the vault file", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, fact({ verify_cmd: ANCHOR }));
    const raw = await readFile(deps.vault.get(res.id)!.filePath, "utf8");
    assert.equal((matter(raw).data as Record<string, unknown>).verify_cmd, ANCHOR);
  } finally {
    await cleanup();
  }
});

test("#235: load_memory surfaces the anchor with a hint", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, fact({ verify_cmd: ANCHOR }));
    const loaded = await loadMemoryHandler(deps, { id: res.id });
    assert.equal(loaded.verify?.cmd, ANCHOR);
    assert.ok(loaded.verify?.hint, "an anchor without guidance is just a string");
  } finally {
    await cleanup();
  }
});

test("#235: the hint says the command comes from the VAULT, not from bastra", async () => {
  // This field transports a command. If the wording reads like an instruction
  // from the tool, an agent has no reason to apply judgement to it — which is
  // exactly the failure mode a command-carrying field must not have.
  const { deps, cleanup } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, fact({ verify_cmd: ANCHOR }));
    const loaded = await loadMemoryHandler(deps, { id: res.id });
    const hint = loaded.verify!.hint.toLowerCase();
    assert.match(hint, /vault/, "the hint must name where the command came from");
    assert.match(hint, /permission/, "and defer to the session's own permission rules");
  } finally {
    await cleanup();
  }
});

test("#467: a summary that states a count gets the count reminder", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const counted = await saveMemoryHandler(
      deps,
      fact({
        title: "Fehlerkatalog",
        summary: "Der Katalog listet 27 recurring failure modes.",
        verify_cmd: "grep -c '^1' catalog.md",
      }),
    );
    const hint = (await loadMemoryHandler(deps, { id: counted.id })).verify!.hint;
    assert.match(hint, /states a count/);
    assert.match(hint, /only checks that one item exists/);
  } finally {
    await cleanup();
  }
});

test("#467: an address in the summary is not a count", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    // The #235 fixture: "127.0.0.1:6723." is an address, not a count.
    const port = await saveMemoryHandler(deps, fact({ verify_cmd: ANCHOR }));
    assert.doesNotMatch((await loadMemoryHandler(deps, { id: port.id })).verify!.hint, /states a count/);
  } finally {
    await cleanup();
  }
});

test("#235: a memory without an anchor carries no verify block at all", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, fact());
    const loaded = await loadMemoryHandler(deps, { id: res.id });
    assert.equal(loaded.verify, undefined, "absent means absent — no empty scaffolding");
  } finally {
    await cleanup();
  }
});

test("#235: a whitespace-only anchor is treated as absent", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, fact({ verify_cmd: "   " }));
    const loaded = await loadMemoryHandler(deps, { id: res.id });
    assert.equal(loaded.verify, undefined);
  } finally {
    await cleanup();
  }
});

test("#235: the anchor survives an ordinary overwrite", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, fact({ verify_cmd: ANCHOR }));
    // Editing the body must not silently drop the anchor — save rebuilds the
    // whole frontmatter, so this is a real regression risk.
    await saveMemoryHandler(deps, fact({ overwrite: true, body: "Anderer Text." }));
    const loaded = await loadMemoryHandler(deps, { id: res.id });
    assert.equal(loaded.verify?.cmd, ANCHOR);
  } finally {
    await cleanup();
  }
});

test("#235: the anchor reaches the lean path — it is useless if only 'full' shows it", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, fact({ verify_cmd: ANCHOR }));
    const lean = await loadMemoryHandler(deps, { id: res.id });
    assert.equal(lean.frontmatter.verify_cmd, ANCHOR, "lean is the default an agent gets");
  } finally {
    await cleanup();
  }
});

test("#235: NOTHING executes the anchor — a destructive one is inert", async () => {
  // The whole safety argument of stage 1. If this ever fails, the daemon has
  // grown an execution path and stage 1's "zero new attack surface" claim is
  // void.
  const { deps, cleanup } = await makeDeps();
  const canary = join(tmpdir(), `bastra-anchor-canary-${process.pid}`);
  try {
    const { writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    await writeFile(canary, "still here", "utf8");

    const res = await saveMemoryHandler(deps, fact({ verify_cmd: `rm -f ${canary}` }));
    await loadMemoryHandler(deps, { id: res.id });

    assert.ok(existsSync(canary), "the anchor must never be executed by the daemon");
  } finally {
    await rm(canary, { force: true });
    await cleanup();
  }
});
