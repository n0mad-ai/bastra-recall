/**
 * #472/#473 — the four surfaces that grant recall and save authority must not
 * contradict each other.
 *
 * A fresh client can load any subset of: the MCP `initialize` instructions,
 * the skill, the `recall`/`save_memory` tool descriptions, and the session
 * context inject. Each is hand-authored, none was compared against the others,
 * so they could drift into a split-brain about write authority over the user's
 * vault — which is exactly what `origin/fix/bounded-mcp-instructions` (44619f4)
 * did on the MCP entry alone. #473 decided that direction is rejected: the
 * policy is proactive on all four surfaces.
 *
 * The check is semantic-by-keyword, NOT byte equality. The surfaces legitimately
 * differ in length and wording; what they may not do is disagree on
 *   1. when `recall` is expected (proactive vs. only on explicit request),
 *   2. whether live sources outrank recall for current state,
 *   3. whether `save_memory` may fire without a human ask.
 *
 * `BOUNDED_FIXTURE` below is the rejected branch text verbatim. It is here so
 * this test is verified against a real contradiction instead of only against
 * the green status quo: the last two tests prove the classifier reads it as the
 * opposite policy and that parity fails when it is one of the four surfaces.
 *
 * Run: npx tsx --test packages/daemon/__tests__/recall-policy-parity.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_INSTRUCTIONS } from "../src/mcp-instructions.js";
import { MEMORY_TOOL_DEFS } from "../src/tool-defs-memory.js";
import { renderSessionContext } from "../src/session-assembler.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type RecallExpectation = "proactive" | "on-request";
type SaveAuthority = "autonomous" | "human-authorized";

interface Stance {
  /** When the model is told to reach for `recall` at all. */
  recall: RecallExpectation;
  /** Whether reading the live source is declared to come BEFORE recall. */
  liveSourcesOutrankRecall: boolean;
  /** Whether `save_memory` may fire without the user asking for it. */
  save: SaveAuthority;
}

/**
 * Markers, not prose comparison. A surface has to SAY something on axes 1 and 3
 * — silence there is a finding of its own, because a surface that grants tools
 * without stating the policy is how the drift started.
 */
const RECALL_PROACTIVE = [
  /without being asked/i,
  /before acting/i,
  /proactive/i,
  /part of acting, not a separate step/i,
  /before any other lookup tool/i,
  /at session start/i,
];
const RECALL_ON_REQUEST = [
  /not default context/i,
  /only when the user explicitly asks/i,
  /explicitly asks for memory or history/i,
  /at most one recall call per turn/i,
];

const LIVE_SOURCE_FIRST = [
  /live source first/i,
  /read the live source/i,
  /ordinary current-state work/i,
];

const SAVE_AUTONOMOUS = [
  /without being asked/i,
  /do not wait to be asked/i,
  /save without confirmation/i,
  /no permission asked/i,
  /save autonomously/i,
  /save it via `save_memory` immediately/i,
  /fire `save_memory` immediately/i,
];
const SAVE_HUMAN_AUTHORIZED = [
  /never save memory automatically/i,
  /save only when the user explicitly asks/i,
];

const hits = (text: string, markers: RegExp[]): RegExp[] => markers.filter((m) => m.test(text));

function classify(surface: string, text: string): Stance {
  const proactive = hits(text, RECALL_PROACTIVE);
  const onRequest = hits(text, RECALL_ON_REQUEST);
  assert.ok(
    proactive.length > 0 || onRequest.length > 0,
    `${surface}: says nothing about WHEN recall is expected — it grants the tool without stating the policy`,
  );
  assert.ok(
    proactive.length === 0 || onRequest.length === 0,
    `${surface}: states both recall policies at once (proactive: ${proactive}, on-request: ${onRequest})`,
  );

  const autonomous = hits(text, SAVE_AUTONOMOUS);
  const humanOnly = hits(text, SAVE_HUMAN_AUTHORIZED);
  assert.ok(
    autonomous.length > 0 || humanOnly.length > 0,
    `${surface}: says nothing about whether save_memory may fire without a human ask`,
  );
  assert.ok(
    autonomous.length === 0 || humanOnly.length === 0,
    `${surface}: states both save policies at once (autonomous: ${autonomous}, human-authorized: ${humanOnly})`,
  );

  return {
    recall: proactive.length > 0 ? "proactive" : "on-request",
    liveSourcesOutrankRecall: hits(text, LIVE_SOURCE_FIRST).length > 0,
    save: autonomous.length > 0 ? "autonomous" : "human-authorized",
  };
}

/** Fails naming the axis and both sides, so a diff is readable without reading four files. */
function assertParity(stances: Record<string, Stance>): void {
  const entries = Object.entries(stances);
  const [refName, ref] = entries[0]!;
  for (const axis of ["recall", "liveSourcesOutrankRecall", "save"] as const) {
    for (const [name, stance] of entries.slice(1)) {
      assert.equal(
        stance[axis],
        ref[axis],
        `recall/save authority contradiction on "${axis}": ${refName} says ${String(ref[axis])}, ` +
          `${name} says ${String(stance[axis])} — a fresh client would be told both`,
      );
    }
  }
}

/** The rejected policy from origin/fix/bounded-mcp-instructions (44619f4), verbatim. */
const BOUNDED_FIXTURE =
  "bastra-recall is the user's persistent local memory, not default context. Call `recall` only when " +
  "the user explicitly asks for memory or history, or a named durable fact is needed but absent from " +
  "both the prompt and its named live source. For a current file, repository, runtime or service, read " +
  "the live source first. Do not search supplied logs, URLs, uploads, generic questions or ordinary " +
  "current-state work. Make at most one Recall call per turn; load only 1-2 directly relevant hits. " +
  "Never save memory automatically: save only when the user explicitly asks.";

const skill = await readFile(join(REPO, "packages", "skill", "SKILL.md"), "utf8");

const toolDescriptions = MEMORY_TOOL_DEFS.filter((d) => d.name === "recall" || d.name === "save_memory")
  .map((d) => d.description)
  .join("\n\n");

/** The inject as a client sees it — the policy lives in the header, not in the recalled lines. */
const sessionInject = renderSessionContext([{ kind: "pinned", lines: ["- some pinned memory"] }], 42);

const SURFACES: Record<string, string> = {
  "MCP entry instructions (mcp-instructions.ts)": SERVER_INSTRUCTIONS,
  "skill (packages/skill/SKILL.md)": skill,
  "tool descriptions (tool-defs-memory.ts)": toolDescriptions,
  "session context inject (session-assembler.ts)": sessionInject,
};

test("#472: all four authority surfaces agree on recall/save policy", () => {
  const stances = Object.fromEntries(
    Object.entries(SURFACES).map(([name, text]) => [name, classify(name, text)]),
  );
  assertParity(stances);
});

test("#473: the agreed policy is the proactive one (Option 1, decided 09.09.2026)", () => {
  for (const [name, text] of Object.entries(SURFACES)) {
    assert.deepEqual(
      classify(name, text),
      { recall: "proactive", liveSourcesOutrankRecall: false, save: "autonomous" },
      `${name} left the decided policy — #473 chose proactive recall and autonomous save on every surface`,
    );
  }
});

test("#473: the rejected bounded text classifies as the opposite policy", () => {
  assert.deepEqual(classify("bounded fixture", BOUNDED_FIXTURE), {
    recall: "on-request",
    liveSourcesOutrankRecall: true,
    save: "human-authorized",
  });
});

test("#472: parity fails loudly when the bounded text is one of the surfaces", () => {
  const stances = Object.fromEntries(
    Object.entries({ ...SURFACES, "MCP entry instructions (mcp-instructions.ts)": BOUNDED_FIXTURE }).map(
      ([name, text]) => [name, classify(name, text)],
    ),
  );
  assert.throws(() => assertParity(stances), /contradiction on "recall"/);
});
