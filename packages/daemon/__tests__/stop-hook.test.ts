import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  evaluateHeuristics,
  detectFrustration,
  detectFeatureCompletion,
  detectArchitectureDecision,
  formatSuggestion,
  parseTranscriptFile,
  normalizeTurns,
  type TranscriptTurn,
} from "../src/stop-lane.js";

function userTurn(content: string): TranscriptTurn {
  return { role: "user", content };
}
function assistantTurn(content: string): TranscriptTurn {
  return { role: "assistant", content };
}

// Five repo-relative source tokens used across feature-completion tests.
const FIVE_SOURCE_FILES =
  "edited packages/daemon/src/stop-hook.ts, packages/daemon/src/hook.ts, " +
  "packages/daemon/src/prompt-hook.ts, packages/daemon/__tests__/stop-hook.test.ts, " +
  "packages/daemon/src/cli/adapters/claude-code.ts";

// Inject a cwd + a fake existence check so feature-completion tests never touch
// the real filesystem.
const ALL_EXIST = { cwd: "/repo", fileExists: () => true };
const NONE_EXIST = { cwd: "/repo", fileExists: () => false };

describe("stop-hook: detectFrustration", () => {
  it("fires on >=4 explicit frustration words across the window", () => {
    const turns: TranscriptTurn[] = [
      userTurn("schon wieder kaputt"),
      assistantTurn("sorry"),
      userTurn("wieder das gleiche!"),
      assistantTurn("fixe ich"),
      userTurn("wieder!"),
      userTurn("wie oft denn noch"),
    ];
    const s = detectFrustration(turns);
    assert.ok(s);
    assert.equal(s!.heuristic, "frustration-density");
  });

  it("does NOT fire on technical CAPS acronyms with 0 frustration words (#48 A)", () => {
    const turns: TranscriptTurn[] = [
      userTurn("schau dir die SKILL.md und die JSON config an"),
      userTurn("der CLAUDE / BASTRA / NEXUS hook nutzt die REST API"),
      userTurn("HTTP HTTPS YAML XML SQL TODO FIXME"),
      userTurn("die TSX und JSX files plus SVG PNG PDF"),
    ];
    assert.equal(detectFrustration(turns), null);
  });

  it("fires on 4x 'wieder' with 0 CAPS (#48 A)", () => {
    const turns: TranscriptTurn[] = [
      userTurn("wieder falsch"),
      userTurn("wieder das gleiche"),
      userTurn("schon wieder"),
      userTurn("und wieder kaputt"),
    ];
    const s = detectFrustration(turns);
    assert.ok(s);
    assert.equal(s!.heuristic, "frustration-density");
  });

  it("counts CAPS words starting with Umlauts (Unicode word-boundary fix)", () => {
    // 2 frust words + 2 Umlaut/ASCII CAPS cues = 4 → fires.
    // With the old `\b[A-ZÄÖÜ]+\b` regex, "ÄRGER" mangles to "RGER" (len 4,
    // single → no cue), yielding only 3 cues and NO suggest. The fix makes it 4.
    const turns: TranscriptTurn[] = [
      userTurn("wieder kaputt"),
      userTurn("schon wieder"),
      userTurn("ÄRGER UNSINN"),
    ];
    const s = detectFrustration(turns);
    assert.ok(s, "should fire: 2 frust words + ÄRGER + UNSINN = 4 cues");
  });

  it("CAPS alone never triggers — needs >=2 real frust words", () => {
    // Many qualifying CAPS cues (>=5 chars) but only ONE frust word.
    const turns: TranscriptTurn[] = [
      userTurn("FALSCH FALSCH KOMPLETT"),
      userTurn("UNGLAUBLICH ABSURD"),
      userTurn("wieder kaputt"),
    ];
    assert.equal(detectFrustration(turns), null);
  });

  it("does not fire below threshold", () => {
    const turns: TranscriptTurn[] = [
      userTurn("normal"),
      userTurn("alles ok"),
      userTurn("klingt gut"),
    ];
    assert.equal(detectFrustration(turns), null);
  });

  it("ignores tool-output that was reclassified to role 'tool'", () => {
    // bash/tool output (Claude-Code stores it as role:"user" with tool_result
    // blocks → normalizeTurns reclassifies it to "tool"). Even crammed with
    // frust words + CAPS it must not count; only the one genuine user turn does.
    const turns: TranscriptTurn[] = [
      { role: "tool", content: "wieder wieder schon wieder ÄRGER UNSINN FALSCH KOMPLETT" },
      { role: "tool", content: "wieder wieder verdammt SCHEISSE" },
      userTurn("warum kommt das wieder"),
    ];
    assert.equal(detectFrustration(turns), null);
  });
});

describe("stop-hook: #476 the lane fires for non-German users too", () => {
  it("fires on English frustration words", () => {
    const turns: TranscriptTurn[] = [
      userTurn("this is broken again"),
      assistantTurn("sorry"),
      userTurn("again the same thing"),
      userTurn("how often do we have to do this"),
      userTurn("damn, again"),
    ];
    const s = detectFrustration(turns);
    assert.ok(s, "English frustration must fire");
    assert.equal(s!.heuristic, "frustration-density");
  });

  it("fires on Russian frustration words", () => {
    const turns: TranscriptTurn[] = [
      userTurn("снова не работает"),
      assistantTurn("извини"),
      userTurn("опять то же самое"),
      userTurn("сколько раз можно"),
      userTurn("опять сломалось"),
    ];
    const s = detectFrustration(turns);
    assert.ok(s, "Russian frustration must fire");
    assert.equal(s!.heuristic, "frustration-density");
  });

  it("counts Cyrillic CAPS as a cue — the Latin-only regex never could", () => {
    const turns: TranscriptTurn[] = [
      userTurn("опять ОШИБКА"),
      userTurn("снова ПРОБЛЕМА"),
    ];
    // 2 frustration words + 2 qualifying CAPS tokens = 4 cues, threshold met
    // only if the CAPS tokens are recognised at all.
    assert.ok(detectFrustration(turns), "Cyrillic CAPS must count as cues");
  });

  it("fires on English and Russian decision cues", () => {
    assert.ok(detectArchitectureDecision([userTurn("ok then, let's go with Drizzle")]));
    assert.ok(detectArchitectureDecision([userTurn("we'll go with MapKit")]));
    assert.ok(detectArchitectureDecision([userTurn("decided: we keep the daemon")]));
    assert.ok(detectArchitectureDecision([userTurn("решено, берём Drizzle")]));
    assert.ok(detectArchitectureDecision([userTurn("остановимся на этом варианте")]));
  });

  it("still does not fire on neutral chatter in any language", () => {
    assert.equal(detectArchitectureDecision([userTurn("let us look at it tomorrow")]), null);
    assert.equal(detectArchitectureDecision([userTurn("посмотрим завтра")]), null);
    assert.equal(detectFrustration([userTurn("run the tests"), userTurn("запусти тесты")]), null);
  });

  it("does not match a cue inside a longer word", () => {
    // "again" inside "against", "wieder" inside "wiederholen" — the Unicode
    // lookarounds replace \b, which could not do this for Cyrillic at all.
    assert.equal(
      detectFrustration([
        userTurn("weighing this against that"),
        userTurn("weighing this against that"),
        userTurn("weighing this against that"),
        userTurn("weighing this against that"),
      ]),
      null,
    );
  });
});

describe("stop-hook: detectFeatureCompletion", () => {
  it("fires on user 'git commit' + >=5 source tokens existing in repo (#48 B)", () => {
    const turns: TranscriptTurn[] = [
      assistantTurn(FIVE_SOURCE_FILES),
      userTurn("super, ich habe git commit gemacht"),
    ];
    const s = detectFeatureCompletion(turns, ALL_EXIST);
    assert.ok(s);
    assert.equal(s!.heuristic, "feature-completion");
    assert.equal(s!.type, "project-fact");
  });

  it("does NOT fire when 'git commit' is only explained + URL-path tokens (#48 B)", () => {
    // git commit appears only in assistant text; file tokens are home/URL paths.
    const noise = Array.from({ length: 25 }, (_, i) =>
      `Users/n0mad/.claude/skills/bastra-recall/file${i}.md`,
    ).join(" ");
    const turns: TranscriptTurn[] = [
      assistantTurn(
        "the stop-hook explains: a git commit alongside file tokens would suggest. " +
          `Users/n0mad/.claude.json claude.json ${noise}`,
      ),
    ];
    assert.equal(detectFeatureCompletion(turns, ALL_EXIST), null);
  });

  it("does not fire when commit is mentioned but not by the user", () => {
    const turns: TranscriptTurn[] = [
      assistantTurn("running git commit -m 'feat'\n" + FIVE_SOURCE_FILES),
    ];
    assert.equal(detectFeatureCompletion(turns, ALL_EXIST), null);
  });

  it("fires when the AGENT ran git commit as a tool command (#48 B, scope fix 05.09.)", () => {
    const turns: TranscriptTurn[] = [
      userTurn("bitte fertig machen"),
      { role: "assistant", content: FIVE_SOURCE_FILES, commands: ["git add -A && git commit -q -m 'feat: x'"] },
    ];
    const s = detectFeatureCompletion(turns, ALL_EXIST);
    assert.ok(s, "an agent-run commit is a commit");
    assert.equal(s!.heuristic, "feature-completion");
  });

  it("fires on git's own commit line in a tool result (user ran it via ! or a shell)", () => {
    const turns: TranscriptTurn[] = [
      assistantTurn(FIVE_SOURCE_FILES),
      { role: "tool", content: "[main 8a465e8] fix(taxonomy): treat person memories as drift coverage\n 2 files changed, 42 insertions(+)" },
    ];
    assert.ok(detectFeatureCompletion(turns, ALL_EXIST));
  });

  it("does not treat a tool result that merely quotes 'git commit' as a commit", () => {
    const turns: TranscriptTurn[] = [
      assistantTurn(FIVE_SOURCE_FILES),
      { role: "tool", content: "usage: git commit [-a] [-m <msg>]\nnothing to commit, working tree clean" },
    ];
    assert.equal(detectFeatureCompletion(turns, ALL_EXIST), null);
  });

  it("normalizeTurns lifts Claude and old/current Codex shell calls onto the turn", () => {
    const claude = normalizeTurns([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "committing" },
            { type: "tool_use", name: "Bash", input: { command: "git commit -m 'x'", description: "commit" } },
          ],
        },
      },
    ]);
    assert.equal(claude.length, 1);
    assert.equal(claude[0].content, "committing", "tool_use input never leaks into prose");
    assert.deepEqual(claude[0].commands, ["git commit -m 'x'"]);

    const codex = normalizeTurns([
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["git", "commit", "-m", "y"] }) } },
    ]);
    assert.equal(codex.length, 1, "the call attaches to the preceding assistant turn");
    assert.deepEqual(codex[0].commands, ["git commit -m y"]);

    const currentCodex = normalizeTurns([
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: 'const r = await tools.exec_command({ cmd: "git add -A && git commit -m current" });',
        },
      },
    ]);
    assert.equal(currentCodex.length, 1, "the current custom call also attaches to the preceding assistant turn");
    assert.deepEqual(currentCodex[0].commands, ["git add -A && git commit -m current"]);
  });

  it("does not lift git-commit prose from a current Codex custom tool call", () => {
    const turns = normalizeTurns([
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: FIVE_SOURCE_FILES }] } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: 'text("I might run git commit later");',
        },
      },
    ]);
    assert.equal(detectFeatureCompletion(turns, ALL_EXIST), null);
  });

  it("does not fire without enough source tokens", () => {
    const turns: TranscriptTurn[] = [
      userTurn("git commit gemacht"),
      assistantTurn("touched packages/daemon/src/stop-hook.ts and src/hook.ts"),
    ];
    assert.equal(detectFeatureCompletion(turns, ALL_EXIST), null);
  });

  it("does not fire when no token exists in the active repo (cwd-check)", () => {
    const turns: TranscriptTurn[] = [
      assistantTurn(FIVE_SOURCE_FILES),
      userTurn("git commit done"),
    ];
    assert.equal(detectFeatureCompletion(turns, NONE_EXIST), null);
  });
});

describe("stop-hook: detectArchitectureDecision", () => {
  it("fires on 'ok dann'", () => {
    const turns: TranscriptTurn[] = [
      userTurn("ok dann nehmen wir Drizzle"),
    ];
    const s = detectArchitectureDecision(turns);
    assert.ok(s);
    assert.equal(s!.heuristic, "architecture-decision");
    assert.equal(s!.type, "decision");
  });

  it("fires on 'lass uns'", () => {
    assert.ok(detectArchitectureDecision([userTurn("lass uns mit MapKit gehen")]));
  });

  it("does not fire on neutral chatter", () => {
    assert.equal(
      detectArchitectureDecision([userTurn("schauen wir mal weiter")]),
      null,
    );
  });
});

describe("stop-hook: evaluateHeuristics", () => {
  it("returns empty array on neutral transcript", () => {
    const out = evaluateHeuristics([
      userTurn("bitte X"),
      assistantTurn("done"),
    ]);
    assert.deepEqual(out, []);
  });

  it("can fire multiple heuristics at once", () => {
    const turns: TranscriptTurn[] = [
      userTurn("wieder kaputt"),
      userTurn("schon wieder"),
      userTurn("wie oft noch"),
      userTurn("und wieder"),
      assistantTurn(FIVE_SOURCE_FILES),
      userTurn("ok dann nehmen wir das, git commit ist durch"),
    ];
    const out = evaluateHeuristics(turns, ALL_EXIST);
    const kinds = out.map((s) => s.heuristic).sort();
    assert.deepEqual(kinds, [
      "architecture-decision",
      "feature-completion",
      "frustration-density",
    ]);
  });
});

describe("stop-hook: formatSuggestion", () => {
  it("emits <save-eval> block with title/type/body lines", () => {
    const s = {
      heuristic: "frustration-density" as const,
      title: "x",
      type: "lesson" as const,
      body: "the body",
    };
    const out = formatSuggestion(s);
    assert.match(out, /<save-eval>/);
    assert.match(out, /heuristic: frustration-density/);
    assert.match(out, /title: "x"/);
    assert.match(out, /type: lesson/);
    assert.match(out, /<\/save-eval>/);
  });
});

describe("stop-hook: parseTranscriptFile", () => {
  it("parses JSONL", () => {
    const raw = [
      JSON.stringify({ role: "user", content: "hi" }),
      JSON.stringify({ role: "assistant", content: "ok" }),
    ].join("\n");
    const turns = parseTranscriptFile(raw);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, "user");
  });

  it("parses Claude-Code nested message shape", () => {
    const raw = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hello" },
    });
    const turns = parseTranscriptFile(raw);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].content, "hello");
  });

  it("parses current Codex response_item message records (#15)", () => {
    const raw = [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello from Codex" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello back" }] } }),
    ].join("\n");
    const turns = parseTranscriptFile(raw);
    assert.deepEqual(turns, [
      { role: "user", content: "hello from Codex" },
      { role: "assistant", content: "hello back" },
    ]);
  });

  it("parses array-of-content-blocks", () => {
    const items = [{ role: "user", content: [{ type: "text", text: "hi there" }] }];
    const turns = normalizeTurns(items);
    assert.equal(turns[0].content, "hi there");
  });

  it("reclassifies Claude-Code tool_result (role user) to role 'tool'", () => {
    const items = [
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "bash output: wieder ÄRGER" }] } },
      { type: "user", message: { role: "user", content: "echte frage wieder" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "antwort" }] } },
    ];
    const turns = normalizeTurns(items);
    assert.equal(turns[0].role, "tool");
    assert.equal(turns[1].role, "user");
    assert.equal(turns[2].role, "assistant");
  });

  it("returns empty on garbage input", () => {
    assert.deepEqual(parseTranscriptFile("not json at all"), []);
  });
});

describe("stop-hook: #149 injected-context scrubbing in normalizeTurns", () => {
  const HINT_BLOCK =
    '<recall-hints surface="claude-code" trigger="todo-plan">\n' +
    `- lesson foo: edited ${FIVE_SOURCE_FILES}\n` +
    "</recall-hints>";

  it("strips embedded injected blocks but keeps surrounding prose", () => {
    const items = [{ role: "user", content: `kurze frage\n${HINT_BLOCK}\nund noch text` }];
    const turns = normalizeTurns(items);
    assert.equal(turns[0].role, "user");
    assert.match(turns[0].content, /kurze frage/);
    assert.match(turns[0].content, /und noch text/);
    assert.ok(!turns[0].content.includes("recall-hints"));
    assert.ok(!turns[0].content.includes("stop-hook.ts"), "file tokens inside the block must be gone");
  });

  it("feature-completion does not count file tokens quoted inside injected blocks", () => {
    // Without the scrub this fires: user confirms a commit and an injected
    // hint block carries 5 repo-relative source paths.
    const items = [
      { role: "user", content: "ok, bitte git commit machen" },
      { role: "user", content: HINT_BLOCK },
    ];
    const turns = normalizeTurns(items);
    assert.equal(detectFeatureCompletion(turns, ALL_EXIST), null);
  });

  it("feature-completion still fires when the same files appear as real prose", () => {
    const items = [
      { role: "user", content: "ok, bitte git commit machen" },
      { role: "assistant", content: FIVE_SOURCE_FILES },
    ];
    const turns = normalizeTurns(items);
    assert.ok(detectFeatureCompletion(turns, ALL_EXIST));
  });

  it("prefix-injected turns keep their system-injected role (scrub runs after classification)", () => {
    const items = [{ role: "user", content: "<system-reminder>\nwieder wieder wieder wieder\n</system-reminder>" }];
    const turns = normalizeTurns(items);
    assert.equal(turns[0].role, "system-injected");
    assert.ok(!turns[0].content.includes("system-reminder"));
  });
});
