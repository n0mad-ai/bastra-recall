/**
 * Tests für trigger-expand.ts (#117) — doc2query write-time trigger expansion.
 * Pure helpers (prompt/parse/hash) ohne Modell; expand()-Lifecycle mit
 * gestubbtem chat + selfTest gegen einen echten Temp-Vault.
 *
 * Runner: tsx --test packages/core/__tests__/trigger-expand.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import type { EmbeddingIndex } from "../src/embeddings.js";
import type { Memory } from "../src/schema.js";
import {
  TriggerExpander,
  buildExpandPrompt,
  isSlugChain,
  parseExpansions,
  sourceHash,
} from "../src/trigger-expand.js";

function memoryMd(id: string): string {
  return `---
id: ${id}
title: ${id} title
type: lesson
summary: summary of ${id}
topic_path: [t]
tags: [t]
scope: t
recall_when: ["original trigger"]
created: 2026-05-01
updated: 2026-05-01
---

body ${id}
`;
}

/** Minimal Memory for the pure-function tests (no vault needed). */
function fakeMemory(over: Partial<Memory["fm"]> = {}): Memory {
  return {
    fm: {
      id: "m",
      title: "NSPanel closes when sheet attaches",
      summary: "resignKey observer must respect attachedSheet",
      recall_when: ["nspanel resignkey", "panel closes"],
      ...over,
    },
    body: "b",
    filePath: "/tmp/m.md",
  } as unknown as Memory;
}

/** EmbeddingIndex stub — expand() only needs onEmbed for start(). */
function stubEmbeddings(): EmbeddingIndex {
  return {
    onEmbed(_l: (id: string) => void) {
      return () => {};
    },
  } as unknown as EmbeddingIndex;
}

async function vaultWith(ids: string[]): Promise<{ dir: string; vault: Vault }> {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-expand-"));
  for (const id of ids) await writeFile(path.join(dir, `${id}.md`), memoryMd(id));
  const vault = new Vault(dir);
  await vault.init();
  return { dir, vault };
}

// ── pure helpers ───────────────────────────────────────────────────

test("buildExpandPrompt carries title/summary/triggers and asks for reworded phrases in the note's language", () => {
  const p = buildExpandPrompt(fakeMemory());
  assert.match(p, /NSPanel closes when sheet attaches/);
  assert.match(p, /resignKey observer must respect attachedSheet/);
  assert.match(p, /nspanel resignkey \| panel closes/);
  assert.match(p, /DIFFERENT words/);
  assert.match(p, /SAME language/);
  assert.doesNotMatch(p, /German and English/);
});

test("parseExpansions strips bullets/numbering and trims", () => {
  const raw = ["- why does my panel vanish", "2. fenster schließt sich", "* warum panel zu", "1) related concept"].join("\n");
  const out = parseExpansions(raw, [], 5);
  assert.deepEqual(out, ["why does my panel vanish", "fenster schließt sich", "warum panel zu", "related concept"]);
});

test("parseExpansions strips wrapping quotes", () => {
  assert.deepEqual(parseExpansions('"quoted phrase"\n`code phrase`', [], 5), ["quoted phrase", "code phrase"]);
});

test("parseExpansions dedupes against existing triggers and itself (case-insensitive)", () => {
  const raw = ["Original Trigger", "fresh one", "fresh one", "FRESH ONE"].join("\n");
  const out = parseExpansions(raw, ["original trigger"], 5);
  assert.deepEqual(out, ["fresh one"]);
});

test("parseExpansions drops empties + over-long lines and caps at max", () => {
  const raw = ["a", "", "   ", "x".repeat(200), "b", "c", "d"].join("\n");
  const out = parseExpansions(raw, [], 3);
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("isSlugChain flags multi-segment / mixed-delimiter glue, keeps real search tokens", () => {
  // slug-chains the model emits despite the prompt — must be dropped
  for (const slug of [
    "panel-close-fix",
    "Bastra-Branding-finalisierung-von-nexus-recall",
    "min-width-zero-effect",
    "api-load-distribution-changes",
    "timestamps-store-utc",
    "some_id_token",
    "path/to/file.md",
  ]) {
    assert.equal(isSlugChain(slug), true, `should flag slug: ${slug}`);
  }
  // real single-token search terms — must be kept (regression: a length filter
  // can't tell these from slugs; an over-eager "any hyphen" filter eats them)
  for (const term of [
    "fenster",
    "z-index",
    "min-width",
    "ci/cd",
    "gpt-4",
    "read-only",
    "doc2query",
  ]) {
    assert.equal(isSlugChain(term), false, `should keep term: ${term}`);
  }
  // idiomatic multi-hyphen terms: a function word in the seam → kept, not a slug
  for (const term of ["left-to-right", "end-to-end", "state-of-the-art"]) {
    assert.equal(isSlugChain(term), false, `should keep idiom: ${term}`);
  }
  // any whitespace → a real query, never a slug
  assert.equal(isSlugChain("why does my panel close by itself"), false);
});

test("parseExpansions drops slug-chains but keeps clean phrases and legit hyphen terms", () => {
  const raw = [
    "why does my panel close by itself", // keep: real phrase
    "panel-close-fix", // drop: slug-chain
    "z-index", // keep: 2-segment term
    "min-width-zero-effect", // drop: slug-chain
    "fenster schließt sich von selbst", // keep: real phrase
  ].join("\n");
  assert.deepEqual(parseExpansions(raw, [], 5), [
    "why does my panel close by itself",
    "z-index",
    "fenster schließt sich von selbst",
  ]);
});

test("sourceHash is stable and changes when recall_when/title/summary change", () => {
  const base = sourceHash(fakeMemory());
  assert.equal(base, sourceHash(fakeMemory()), "same source → same hash");
  assert.notEqual(base, sourceHash(fakeMemory({ recall_when: ["different"] })));
  assert.notEqual(base, sourceHash(fakeMemory({ title: "other" })));
  assert.notEqual(base, sourceHash(fakeMemory({ summary: "other" })));
});

// ── expand() lifecycle ─────────────────────────────────────────────

test("expand writes recall_when_expanded + _src to frontmatter, atomically", async () => {
  const { dir, vault } = await vaultWith(["a"]);
  try {
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => "why does it break\nwarum geht es kaputt",
      backfillOnStart: false,
    });
    const kept = await expander.expand("a");
    assert.deepEqual(kept, ["why does it break", "warum geht es kaputt"]);

    const raw = await readFile(path.join(dir, "a.md"), "utf8");
    assert.match(raw, /recall_when_expanded:/);
    assert.match(raw, /why does it break/);
    assert.match(raw, /recall_when_expanded_src:/);
    assert.match(raw, /body a/, "body preserved");

    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no tmp leftovers");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("selfTest filters out paraphrases that don't retrieve their own memory", async () => {
  const { dir, vault } = await vaultWith(["a"]);
  try {
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => "keep me\ndrop me\nkeep this too",
      selfTest: async (phrase) => phrase.startsWith("keep"),
      backfillOnStart: false,
    });
    const kept = await expander.expand("a");
    assert.deepEqual(kept, ["keep me", "keep this too"]);
    const raw = await readFile(path.join(dir, "a.md"), "utf8");
    assert.doesNotMatch(raw, /drop me/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("expand is a no-op on the second pass — source unchanged breaks the loop", async () => {
  const { dir, vault } = await vaultWith(["a"]);
  try {
    let chatCalls = 0;
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => { chatCalls++; return "phrase one"; },
      backfillOnStart: false,
    });
    await expander.expand("a"); // writes _src
    const second = await expander.expand("a"); // src now matches → skip
    assert.equal(second, null);
    assert.equal(chatCalls, 1, "model not called again when source is unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("writeGate=false suppresses the write (single-writer)", async () => {
  const { dir, vault } = await vaultWith(["a"]);
  try {
    const before = await readFile(path.join(dir, "a.md"), "utf8");
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => "phrase one",
      writeGate: () => false,
      backfillOnStart: false,
    });
    const result = await expander.expand("a");
    assert.equal(result, null);
    assert.equal(await readFile(path.join(dir, "a.md"), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("start: a rejecting expand via onEmbed is swallowed (crash guard, fix A)", async () => {
  // Without the .catch on `void this.expand(id)`, a chat that throws (Ollama
  // timeout/abort) becomes an unhandled rejection — node:test would fail the
  // test, just as it crashed the daemon. The .catch must absorb it.
  const { dir, vault } = await vaultWith(["a"]);
  try {
    let fire: ((id: string) => void) | null = null;
    const emb = { onEmbed(l: (id: string) => void) { fire = l; return () => {}; } } as unknown as EmbeddingIndex;
    const expander = new TriggerExpander(vault, emb, {
      chat: async () => { throw new Error("ollama aborted"); },
      backfillOnStart: false,
    });
    expander.start();
    assert.ok(fire, "onEmbed listener registered");
    fire!("a"); // triggers expand → chat throws → must be swallowed, not unhandled
    await new Promise((r) => setTimeout(r, 20)); // let the rejection settle
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("backfill expands every un-expanded memory, then is idempotent", async () => {
  const { dir, vault } = await vaultWith(["a", "b", "c"]);
  try {
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => "reworded phrase",
      backfillOnStart: false,
    });
    const first = await expander.backfill();
    assert.equal(first, 3, "all three expanded");
    const second = await expander.backfill();
    assert.equal(second, 0, "nothing left to expand (src hashes match)");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("buildExpandPrompt scrubs injected context blocks from source fields (#149)", () => {
  const p = buildExpandPrompt(
    fakeMemory({
      summary:
        'resignKey observer must respect attachedSheet <session-context surface="claude-code">- hint: packages/daemon/src/hook.ts</session-context>',
    }),
  );
  assert.match(p, /resignKey observer must respect attachedSheet/);
  assert.ok(!p.includes("session-context"), "scaffolding tag must not seed paraphrases");
  assert.ok(!p.includes("packages/daemon/src/hook.ts"), "block content must not seed paraphrases");
});

test("empty generation is a failure: nothing written, nothing stamped, backfill retries (#367)", async () => {
  // A thinking model returns its whole reply in `message.thinking` and leaves
  // `content` empty — that reaches expand() as "". Stamping the src hash for it
  // would freeze the failure forever (expand + backfill both skip a matching
  // hash), so the file must stay untouched and stay eligible.
  const { dir, vault } = await vaultWith(["a"]);
  try {
    const before = await readFile(path.join(dir, "a.md"), "utf8");
    let chatCalls = 0;
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => { chatCalls++; return ""; },
      backfillOnStart: false,
    });

    assert.equal(await expander.expand("a"), null, "empty generation reports failure, not []");
    assert.equal(await readFile(path.join(dir, "a.md"), "utf8"), before, "file byte-identical");

    // The stamp is the part that would be unrecoverable — it must be absent.
    assert.doesNotMatch(before, /recall_when_expanded_src/);
    assert.equal(await expander.backfill(), 0, "failed memory is not counted as expanded");
    assert.equal(chatCalls, 2, "backfill retries it — the source hash never blocked it");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("text that parses to nothing is still an answer — stamped, not retried (#367)", async () => {
  // The failure test is the RAW reply, not the parse result. A model that
  // answers with only slug-chains (or only echoes of the existing triggers) did
  // respond; generation is deterministic here, so retrying that memory would
  // regenerate the identical nothing on every sweep. It gets its stamp.
  const { dir, vault } = await vaultWith(["a"]);
  try {
    let chatCalls = 0;
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => { chatCalls++; return "panel-close-fix\nsome_id_token\noriginal trigger"; },
      backfillOnStart: false,
    });
    assert.deepEqual(await expander.expand("a"), [], "empty kept, not null");

    const raw = await readFile(path.join(dir, "a.md"), "utf8");
    assert.match(raw, /recall_when_expanded_src:/, "stamped");
    assert.equal(await expander.backfill(), 0, "nothing left to do");
    assert.equal(chatCalls, 1, "not regenerated — the stamp holds");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("backfill stops after 5 consecutive failed generations (#367)", async () => {
  // Without the breaker a systematically incompatible model burns one LLM call
  // per memory on every daemon start — hours, for a result that was decided at
  // call one.
  const { dir, vault } = await vaultWith(["a", "b", "c", "d", "e", "f", "g", "h"]);
  try {
    let chatCalls = 0;
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => { chatCalls++; return ""; },
      backfillOnStart: false,
    });
    assert.equal(await expander.backfill(), 0);
    assert.equal(chatCalls, 5, "stopped at the 5th failure, 3 memories left untouched");

    // A throwing chat is the same failure shape and must trip the same brake.
    chatCalls = 0;
    const throwing = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => { chatCalls++; throw new Error("ollama aborted"); },
      backfillOnStart: false,
    });
    assert.equal(await throwing.backfill(), 0);
    assert.equal(chatCalls, 5, "throwing chat trips the breaker too");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a successful generation resets the failure counter — the breaker needs them consecutive", async () => {
  const { dir, vault } = await vaultWith(["a", "b", "c", "d", "e", "f", "g", "h"]);
  try {
    let n = 0;
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      // fail, fail, succeed, then fail forever: the run of 5 only starts after
      // the success, so the sweep reaches memory 8 rather than stopping at 5.
      chat: async () => { n++; return n === 3 ? "a real phrase" : ""; },
      backfillOnStart: false,
    });
    assert.equal(await expander.backfill(), 1, "the one success was written");
    assert.equal(n, 8, "all eight visited — no 5 in a row until the end");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("the model DID answer but the self-test dropped everything → still written and stamped", async () => {
  // The pre-#367 behaviour that must survive: this is a real "we tried, source
  // is X" result, and the stamp is what breaks the reindex→embed→expand loop.
  const { dir, vault } = await vaultWith(["a"]);
  try {
    const expander = new TriggerExpander(vault, stubEmbeddings(), {
      chat: async () => "a plausible phrase\nanother one",
      selfTest: async () => false,
      backfillOnStart: false,
    });
    assert.deepEqual(await expander.expand("a"), [], "empty kept, not null");

    const raw = await readFile(path.join(dir, "a.md"), "utf8");
    assert.match(raw, /recall_when_expanded_src:/, "stamped");
    assert.match(raw, /recall_when_expanded: \[\]/, "empty expansion persisted");
    assert.equal(await expander.expand("a"), null, "second pass is a no-op — loop stays broken");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
