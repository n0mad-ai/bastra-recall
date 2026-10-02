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
      // #756: a bare "wieder!" is no cue any more — the construction is.
      userTurn("immer wieder!"),
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

describe('stop-hook: #756 the plain word for "again" is not a frustration cue', () => {
  // The session that surfaced it: a router that keeps asking for its
  // password, and a user who is back home and reports that it works.
  const ROUTER: TranscriptTurn[] = [
    userTurn("fragt immer wieder nach dem passwort"),
    assistantTurn("Prüf bitte die gespeicherten Netzwerke."),
    userTurn("ich bin jetzt wieder zu hause"),
    assistantTurn("Gut, dann teste die Verbindung."),
    userTurn("jetzt geht es wieder"),
  ];

  it('the three router sentences do not fire — only "immer wieder" counts', () => {
    assert.equal(detectFrustration(ROUTER), null);
    // Said twice, as in the real session: 2 cues, still below the threshold.
    assert.equal(detectFrustration([userTurn("fragt immer wieder nach dem passwort"), ...ROUTER]), null);
  });

  it('neutral "again" sentences never reach the threshold, in any shipped language', () => {
    for (const neutral of [
      ["ich bin jetzt wieder zu hause", "jetzt geht es wieder", "das wlan ist wieder da", "starte ihn wieder", "wieder online"],
      ["I'm back home again", "it works again now", "run it again", "try again please", "again, thanks"],
      ["я снова дома", "теперь снова работает", "запусти снова", "опять работает", "попробуй опять"],
    ]) {
      assert.equal(detectFrustration(neutral.map(userTurn)), null, neutral[0]);
    }
  });

  it("the constructions still count, one cue per span", () => {
    const fired = (lines: string[]) => detectFrustration(lines.map(userTurn));
    assert.ok(fired(["schon wieder", "immer wieder das", "geht wieder nicht", "wieder kaputt"]));
    assert.ok(fired(["not again", "yet again", "it is broken again", "again and again"]));
    assert.ok(fired(["опять не работает", "снова не то", "опять то же самое", "снова сломалось"]));
    // "schon wieder nicht" is ONE cue ("schon wieder"), not two.
    assert.match(fired(["schon wieder nicht", "schon wieder nicht", "verdammt", "verdammt"])!.body, /Detected 4 frustration cues/);
  });

  it("an exemplar the user said twice is listed once", () => {
    const s = detectFrustration(
      ["immer wieder dieser fehler", "immer wieder dieser fehler", "schon wieder", "wieder kaputt"].map(userTurn),
    );
    assert.ok(s);
    const exemplars = /Exemplars: (.*?)\. If/.exec(s!.body)![1].split(" | ");
    assert.deepEqual(exemplars, ["immer wieder dieser fehler", "schon wieder", "wieder kaputt"]);
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
      // #756: bare "опять"/"снова" are no cues; "опять не"/"снова не" are.
      userTurn("опять не работает, ОШИБКА"),
      userTurn("снова не то, ПРОБЛЕМА"),
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
    // "not again" inside "not against", "wieder" inside "wiederholen" — the
    // Unicode lookarounds replace \b, which could not do this for Cyrillic at
    // all. (#756: the cue is the construction "not again", not a bare "again".)
    assert.equal(
      detectFrustration([
        userTurn("this is not against the rules"),
        userTurn("this is not against the rules"),
        userTurn("this is not against the rules"),
        userTurn("this is not against the rules"),
      ]),
      null,
    );
  });
});

describe("stop-hook: #678 languages without a cue list fire on repeated corrections", () => {
  it("fires on a Polish transcript where the user repeats a correction", () => {
    const turns: TranscriptTurn[] = [
      userTurn("nie używaj średników w tym pliku"),
      assistantTurn("ok, poprawione"),
      userTurn("mówiłem, nie używaj średników w tym pliku!"),
      assistantTurn("przepraszam"),
      userTurn("przecież prosiłem: bez średników w tym pliku"),
    ];
    const s = detectFrustration(turns);
    assert.ok(s, "Polish repeated correction must fire");
    assert.equal(s!.heuristic, "frustration-density");
    assert.match(s!.body, /language-neutral/);
  });

  it("fires on a French transcript where the user repeats a correction", () => {
    const turns: TranscriptTurn[] = [
      userTurn("n'utilise pas de points-virgules dans ce fichier"),
      assistantTurn("d'accord"),
      userTurn("je t'ai dit de ne pas utiliser de points-virgules dans ce fichier"),
      assistantTurn("désolé"),
      userTurn("encore une fois : pas de points-virgules dans ce fichier !"),
    ];
    assert.ok(detectFrustration(turns), "French repeated correction must fire");
  });

  it("fires on a Spanish transcript whose emphasis is CAPS instead of '!'", () => {
    const turns: TranscriptTurn[] = [
      userTurn("no borres los comentarios del archivo"),
      userTurn("te dije que no borres los comentarios del archivo"),
      userTurn("NUNCA borres los comentarios del archivo"),
    ];
    assert.ok(detectFrustration(turns), "Spanish repeated correction must fire");
  });

  it("does not fire on similar routine requests without emphasis", () => {
    const turns: TranscriptTurn[] = [
      userTurn("please add a test for the date parser"),
      userTurn("please add a test for the url parser"),
      userTurn("please add a test for the path parser"),
      userTurn("mach weiter mit dem nächsten issue"),
      userTurn("mach weiter mit dem übernächsten issue bitte"),
    ];
    assert.equal(detectFrustration(turns), null);
  });

  it("does not read `!=`, a file name or an identifier in routine requests as emphasis", () => {
    const routine = (mention: string) =>
      ["date", "url", "csv"].map((p) => userTurn(`add a test for the ${p} parser, ${mention}`));
    for (const mention of [
      "assert result != null",
      "use !cmd in the shell example",
      "show !important and ![shot](a.png) as text",
      "keep #!/bin/sh in the example",
      "assert !(a == b) in the test",
      "and update the README section",
      "and list it in src/README.md",
      "and read BASTRA_VAULT_PATH first",
    ]) {
      assert.equal(detectFrustration(routine(mention)), null, mention);
    }
  });

  it("keeps a no-space exclamation mark as emphasis in a repeated Japanese correction", () => {
    const request = "このファイルでセミコロンを使わないで";
    assert.ok(detectFrustration([
      userTurn(request), userTurn(request), userTurn(`${request}!言ったよね`),
    ]));
    assert.ok(detectFrustration([
      userTurn(request), userTurn(request), userTurn(`${request}!...`),
    ]));
  });

  it("does not fire on a single restatement or on short repeated acknowledgements", () => {
    assert.equal(
      detectFrustration([userTurn("nie używaj średników w tym pliku"), userTurn("nie używaj średników w tym pliku!")]),
      null,
    );
    assert.equal(detectFrustration([userTurn("dalej!"), userTurn("dalej!"), userTurn("dalej!"), userTurn("dalej!")]), null);
  });

  it("does not fire on unrelated emphatic requests in one language", () => {
    const turns: TranscriptTurn[] = [
      userTurn("dodaj test dla funkcji parsowania dat!"),
      userTurn("nie używaj średników w tym pliku!"),
      userTurn("zaktualizuj dokumentację instalacji!"),
    ];
    assert.equal(detectFrustration(turns), null);
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

describe("stop-hook: #707 a decision in a language without a cue list fires on an option pick", () => {
  const offer = (q: string) => assistantTurn(`Two ways:\n1. Drizzle\n2. Prisma\n${q}`);

  it("fires when a Turkish user picks an offered option by number", () => {
    const s = detectArchitectureDecision([offer("Hangisi?"), userTurn("2 olsun")]);
    assert.ok(s, "Turkish pick must fire");
    assert.equal(s!.heuristic, "architecture-decision");
    assert.match(s!.body, /language-neutral/);
  });

  it("fires for a Greek pick (Greek question mark) and a Japanese pick (fullwidth ？)", () => {
    assert.ok(detectArchitectureDecision([offer("Ποιο προτιμάς\u037E"), userTurn("το 1")]));
    assert.ok(detectArchitectureDecision([offer("どちらにしますか？"), userTurn("2でお願いします")]));
  });

  it("skips tool turns between the offer and the pick", () => {
    assert.ok(detectArchitectureDecision([offer("Какой?"), { role: "tool", content: "ok" }, userTurn("вариант 1")]));
  });

  it("does not fire on a numbered list without a question, a number that was not offered, or two numbers", () => {
    assert.equal(detectArchitectureDecision([assistantTurn("Steps:\n1. build\n2. test"), userTurn("2 olsun")]), null);
    assert.equal(detectArchitectureDecision([offer("Hangisi?"), userTurn("3 olsun")]), null);
    assert.equal(detectArchitectureDecision([offer("Hangisi?"), userTurn("1 ve 2 birlikte")]), null);
  });

  it("reads the pick in any digit script: fullwidth, Arabic-Indic, Devanagari", () => {
    assert.ok(detectArchitectureDecision([offer("どちらにしますか？"), userTurn("２でお願いします")]));
    assert.ok(detectArchitectureDecision([offer("أيهما تفضل؟"), userTurn("الخيار ٢")]));
    assert.ok(detectArchitectureDecision([offer("कौन सा?"), userTurn("२ ठीक है")]));
    assert.equal(detectArchitectureDecision([offer("どちらにしますか？"), userTurn("３でお願いします")]), null);
  });

  it("reads parenthesised and lettered option lists", () => {
    const paren = assistantTurn("Two ways:\n(1) Drizzle\n(2) Prisma\nHangisi?");
    assert.ok(detectArchitectureDecision([paren, userTurn("2 olsun")]));
    const lettered = assistantTurn("Two ways:\nA) Drizzle\nB) Prisma\nHangisi?");
    assert.ok(detectArchitectureDecision([lettered, userTurn("B")]));
    const cyrillic = assistantTurn("Два пути:\nа) Drizzle\nб) Prisma\nКакой?");
    assert.ok(detectArchitectureDecision([cyrillic, userTurn("б)")]));
    assert.equal(detectArchitectureDecision([lettered, userTurn("C")]), null, "a letter that was not offered");
  });

  // #767 follow-up: numbered headings structure a report, they are not options.
  it("does not read numbered section headings as options", () => {
    const report = assistantTurn("## 1. Befund\nder Cache läuft voll\n## 2. Ursache\nkein Limit\n\nSoll ich das so umsetzen?");
    assert.equal(detectArchitectureDecision([report, userTurn("ja, aber 2 nochmal prüfen")]), null);
    const heading = assistantTurn("### 1. Drizzle\nfast\n### 2. Prisma\nmature\nHangisi?");
    assert.equal(detectArchitectureDecision([heading, userTurn("1 olsun")]), null);
  });

  // #767 follow-up: a letter with a dot is an abbreviation or an initial.
  it("does not read a letter followed by a dot as an option", () => {
    const abbreviations = assistantTurn("Zwei Wege:\nz. B. so\nd. h. anders\nPasst das?");
    assert.equal(detectArchitectureDecision([abbreviations, userTurn("d")]), null);
    const initials = assistantTurn("Two views:\nA. Smith said keep it\nB. Jones said drop it\nWhich one?");
    assert.equal(detectArchitectureDecision([initials, userTurn("a")]), null);
    const dotted = assistantTurn("Two ways:\nA. Drizzle\nB. Prisma\nHangisi?");
    assert.equal(detectArchitectureDecision([dotted, userTurn("B")]), null);
  });

  it("does not fire on a long new request that happens to contain an offered number", () => {
    assert.equal(
      detectArchitectureDecision([offer("Hangisi?"), userTurn("önce 2 dosyadaki testleri düzelt, sonra derleme hatalarına bak ve raporla")]),
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
      userTurn("immer wieder"), // #756: a bare "und wieder" no longer counts
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

  it("a background task's completion notice is not a user turn", () => {
    // Claude Code delivers a finished subagent / background command as role
    // "user" content opening with <task-notification>; the body is the agent's
    // report. Revert-check: drop the <task-notification> prefix from
    // isInjectedSystemContent and the role comes back "user".
    const items = [
      {
        role: "user",
        content:
          "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>We decided to go with X over Y, final call.</summary>\n</task-notification>",
      },
    ];
    const turns = normalizeTurns(items);
    assert.equal(turns[0].role, "system-injected");
  });

  it("#649: teammate, agent and cross-session mail is not a user turn", () => {
    // Shapes from real transcripts (the cross-session one from the SendMessage
    // docs). Revert-check: drop isAgentMail from isInjectedSystemContent and
    // every role comes back "user".
    const decided = "\nWe decided to go with X over Y, final call.\n";
    for (const content of [
      `<teammate-message teammate_id="team-lead" summary="plan">${decided}</teammate-message>`,
      `Another Claude session sent a message:\n<teammate-message teammate_id="worker" color="blue">${decided}</teammate-message>`,
      `<agent-message from="fix-429">${decided}</agent-message>`,
      `Another Claude session sent a message:\n<agent-message from="impl-50">${decided}</agent-message>`,
      `<cross-session-message from="main">${decided}</cross-session-message>`,
    ]) {
      assert.equal(normalizeTurns([{ role: "user", content }])[0].role, "system-injected", content);
    }
    // A user who merely mentions the tag, or the wrapper line alone, stays a user.
    for (const content of [
      "why does <teammate-message> show up here? we decided on X",
      "Another Claude session sent a message: we decided on X",
    ]) {
      assert.equal(normalizeTurns([{ role: "user", content }])[0].role, "user", content);
    }
  });

  it("prefix-injected turns keep their system-injected role (scrub runs after classification)", () => {
    const items = [{ role: "user", content: "<system-reminder>\nwieder wieder wieder wieder\n</system-reminder>" }];
    const turns = normalizeTurns(items);
    assert.equal(turns[0].role, "system-injected");
    assert.ok(!turns[0].content.includes("system-reminder"));
  });
});
