/**
 * Tests for the UserPromptSubmit lane (Issue #33; daemon-side since #343).
 *
 * Strategy: unit-test the pure helpers (detectRetrieval, extractPrompt,
 * formatHintBlock) directly, then run the full pipeline via `runPromptLane`
 * in-process against a mock HTTP server. The mock serves the same
 * /hook/recall + /hook/reflex + /hook/hinted endpoints as in the CLI era —
 * the lane still reaches them over loopback, so the request assertions kept
 * their meaning across the migration. The thin CLI's own stdin→stdout
 * behaviour is covered separately in prompt-hook.test.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectAssertion,
  detectRetrieval,
  effectiveScoreFloor,
  extractPrompt,
  formatHintBlock,
  formatReflexBlock,
  isTrivialPrompt,
  runPromptLane,
  MUST_LOAD_SCORE,
  type PromptReflexHit,
  type RecallHit,
} from "../src/prompt-lane.ts";
import { decideBackoff, type SourceBackoff } from "../src/session-state.ts";

// ─── Pure unit tests ─────────────────────────────────────────────────────

test("detectRetrieval — DE triggers match", () => {
  const cases = [
    "such mal meinen Strafzettel",
    "Suche nach Rechnungen von 2024",
    "finde alle PDFs zum Mietvertrag",
    "wo ist meine Steuererklärung?",
    "wo sind die Notizen vom Meeting?",
    "wann war der letzte Arzttermin?",
    "wann hatte ich Urlaub im Juli?",
    "wieviel habe ich für Strom bezahlt?",
    "wie viel Miete im März?",
    "was habe ich zum Architekt gesagt?",
    "Was hab ich gestern gemacht?",
    "was war der Stand bei der Steuer?",
  ];
  for (const c of cases) {
    assert.equal(detectRetrieval(c), true, `expected retrieval match for: ${c}`);
  }
});

test("detectRetrieval — EN triggers match", () => {
  const cases = [
    "find the parking ticket pdf",
    "search invoices from last quarter",
    "where is the lease agreement?",
    "where are the meeting notes?",
    "when was the last vet visit?",
    "when did I sign the contract?",
    "how much did I spend on rent?",
    "what did I tell the architect?",
    "what was the status on the tax filing?",
  ];
  for (const c of cases) {
    assert.equal(detectRetrieval(c), true, `expected retrieval match for: ${c}`);
  }
});

test("detectRetrieval — non-retrieval prompts skip", () => {
  const cases = [
    "bitte schreib mir einen Hook",
    "implement a UserPromptSubmit handler",
    "lass uns über das design reden",
    "refactor the daemon",
    "thanks!",
    "",
    "   ",
    "ok",
    "go ahead",
    "machen wir das so",
  ];
  for (const c of cases) {
    assert.equal(detectRetrieval(c), false, `expected NO retrieval match for: ${c}`);
  }
});

// ─── assertion lane (#252) ───────────────────────────────────────────────────

test("detectAssertion — outbound writing requests match", () => {
  const cases = [
    "draft a reply to zzallirog's field report",
    "write the release notes for v0.9",
    "schreib mir bitte die Release Notes",
    "verfasse einen Kommentar zu #257",
    "antworte auf den Discord-Thread",
    "compose an announcement for the blog",
    "entwirf die PR description",
    "beantworte die Mail",
  ];
  for (const c of cases) {
    assert.equal(detectAssertion(c), true, `expected assertion match for: ${c}`);
  }
});

test("detectAssertion — project-state questions match", () => {
  const cases = [
    "what's the state of our recall@pool measurement?",
    "how good are the eval numbers right now",
    "wie ist der Stand beim v0.9 Milestone",
    "wie viele Tests haben wir",
  ];
  for (const c of cases) {
    assert.equal(detectAssertion(c), true, `expected assertion match for: ${c}`);
  }
});

test("detectAssertion — a bare composing verb is not a trigger", () => {
  // The lane that fires on every declarative prompt is the noise #252 warns
  // about: two signals required, never the verb alone.
  const cases = [
    "write a helper that parses the frontmatter",
    "schreib die Funktion neu",
    "draft the migration in typescript",
    "fix the failing test",
    "was hältst du davon",
    "refactor curator.ts",
    "",
  ];
  for (const c of cases) {
    assert.equal(detectAssertion(c), false, `expected NO assertion match for: ${c}`);
  }
});

test("detectAssertion — retrieval wins the classification", () => {
  // "how much …" is both; the hook checks retrieval first, so the lookup
  // instruction is what the agent sees.
  const prompt = "how much did the release cost";
  assert.equal(detectRetrieval(prompt), true);
});

test("effectiveScoreFloor — assertion recalls at the retrieval floor, not the generic one", () => {
  assert.equal(effectiveScoreFloor("assertion"), effectiveScoreFloor("retrieval"));
  assert.notEqual(effectiveScoreFloor("assertion"), effectiveScoreFloor("generic"));
});

test("formatHintBlock — assertion mode forbids asserting from memory and names the alternative", () => {
  const hits: RecallHit[] = [
    { id: "pool-measurement", title: "P", type: "project-fact", scope: "p", summary: "96 of 103", score: 120 },
  ];
  const block = formatHintBlock(hits, "bastra-recall", "assertion");
  assert.match(block, /makes a CLAIM/);
  assert.match(block, /Do NOT assert numbers/);
  assert.match(block, /do not know instead of guessing/);
  assert.match(block, /pool-measurement/);
  assert.doesNotMatch(block, /LOOKUP \/ retrieval query/);
});

test("extractPrompt — prefers payload.prompt", () => {
  assert.equal(extractPrompt({ prompt: "hello", user_message: "ignored" }), "hello");
});

test("extractPrompt — falls back to user_message", () => {
  assert.equal(extractPrompt({ user_message: "fallback" }), "fallback");
});

test("extractPrompt — empty/missing returns null", () => {
  assert.equal(extractPrompt({}), null);
  assert.equal(extractPrompt({ prompt: "" }), null);
  assert.equal(extractPrompt({ prompt: "   " }), null);
});

test("formatHintBlock — retrieval mode includes lookup instruction", () => {
  const hits: RecallHit[] = [
    {
      id: "test-memory",
      title: "Test",
      type: "lesson",
      scope: "user",
      summary: "Summary of the lesson",
      score: 120,
    },
  ];
  const block = formatHintBlock(hits, "myproject", "retrieval");
  assert.match(block, /<recall-hints surface="claude-code" trigger="prompt-lookup"/);
  assert.match(block, /project="myproject"/);
  assert.match(block, /LOOKUP \/ retrieval query/);
  assert.match(block, /bastra-recall:recall.*BEFORE conversation_search/i);
  assert.match(block, /test-memory/);
  assert.match(block, /<\/recall-hints>/);
});

test("formatHintBlock — separates strong vs OPTIONAL by score", () => {
  const hits: RecallHit[] = [
    { id: "high", title: "H", type: "lesson", scope: "user", summary: "high", score: 150 },
    { id: "mid", title: "M", type: "lesson", scope: "user", summary: "mid", score: 70 },
  ];
  const block = formatHintBlock(hits, null, "retrieval");
  // #302: the headline states arm agreement now, not strength — the score is a
  // rank sum and never carried the claim "Strong matches" made. The split this
  // test guards is unchanged; only its anchor moved off the retired wording.
  const strongIdx = block.indexOf("Both search paths agreed");
  const optionalIdx = block.indexOf("OPTIONAL");
  assert.ok(strongIdx >= 0, "required-band section missing");
  assert.ok(optionalIdx > strongIdx, "OPTIONAL must come after the required-band section");
  assert.ok(!block.includes("Strong matches"), "#302: strength is not what the score measures");
  assert.ok(block.indexOf("high") < block.indexOf("mid"));
  // Hints must read as non-coercive (no "REQUIRED"/"not allowed" wording).
  assert.ok(!block.includes("REQUIRED"), "must not use coercive REQUIRED wording");
  assert.ok(!block.includes("not allowed"), "must not use coercive 'not allowed' wording");
});

test("formatReflexBlock — reflex frame with matched trigger phrase (#217)", () => {
  const hits: PromptReflexHit[] = [
    {
      id: "reflex-css-lesson",
      title: "CSS-Spezifität",
      type: "lesson",
      scope: "all-projects",
      summary: "Inline style schlägt Tailwind-Hover immer.",
      matched_phrase: "tailwind grid",
    },
  ];
  const block = formatReflexBlock(hits, "myproject");
  assert.match(block, /<recall-hints surface="claude-code" trigger="reflex"/);
  assert.match(block, /project="myproject"/);
  assert.match(block, /reflex-css-lesson \(lesson, trigger "tailwind grid"\)/);
  assert.match(block, /load_memory\(id\) before answering/);
  assert.match(block, /<\/recall-hints>/);
  // Hints must read as non-coercive, wie formatHintBlock.
  assert.ok(!block.includes("REQUIRED"));
});

// ─── Integration test via mock daemon ────────────────────────────────────

function startMockDaemon(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      ok({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * #343: the pipeline these tests exercise is `runPromptLane`, in-process. The
 * mock daemon stays IDENTICAL to the CLI era — the lane still reaches recall,
 * reflex and hinted over loopback HTTP, so every request assertion below keeps
 * meaning what it meant. env vars are applied around the call and restored,
 * mirroring what the spawned CLI inherited before.
 */
async function runHook(
  payload: object,
  env: Record<string, string>,
  /** #371: the wired reflex pool the route injects in production. Omitted =
   *  the pre-#371 lane, which recalls on every non-trivial prompt. */
  reflexPool?: () => string[],
): Promise<{ stdout: string }> {
  const applied: Record<string, string | undefined> = {};
  const withDefaults: Record<string, string> = { BASTRA_TELEMETRY: "off", ...env };
  for (const [k, v] of Object.entries(withDefaults)) {
    applied[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const baseUrl = withDefaults.BASTRA_HTTP_URL ?? "http://127.0.0.1:1";
    const stdout = await runPromptLane(
      payload as Parameters<typeof runPromptLane>[0],
      null,
      baseUrl,
      undefined,
      reflexPool,
    );
    return { stdout };
  } finally {
    for (const [k, v] of Object.entries(applied)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("integration — retrieval prompt yields recall-hints block", async () => {
  let received: { url: string | undefined; body: unknown } | null = null;
  const daemon = await startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      // The hook now also fires a /hook/hinted usage ping (#154) and the
      // reflex probe (#217) — only the recall request is what this test
      // asserts on; the reflex lane answers empty here.
      if (req.url === "/hook/recall") received = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/hook/reflex") {
        res.end('{"hits":[],"recall_id":null}');
        return;
      }
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "parkticket-2025",
              title: "Strafzettel März 2025",
              type: "project-fact",
              scope: "personal",
              summary: "Parkverstoß Berlin Mitte, 35€, bezahlt 2025-03-12.",
              score: 142,
            },
          ],
          vault_size: 100,
          latency_ms: 12,
          recall_id: "test-recall",
        }),
      );
    });
  });

  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "such mal meinen Strafzettel",
        cwd: process.cwd(),
      },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string; hookEventName?: string };
    };
    assert.ok(parsed.hookSpecificOutput, "hook should emit hookSpecificOutput");
    assert.equal(parsed.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /parkticket-2025/);
    assert.match(ctx, /trigger="prompt-lookup"/);
    assert.match(ctx, /BEFORE conversation_search/);

    assert.ok(received, "mock daemon should have received request");
    const r = received as { url: string | undefined; body: { query: string; k: number } };
    assert.equal(r.url, "/hook/recall");
    assert.equal(r.body.query, "such mal meinen Strafzettel");
    assert.equal(r.body.k, 5);
  } finally {
    await daemon.close();
  }
});

test("integration — non-retrieval prompt emits empty object", async () => {
  // Seit dem 19.08.-Vorfall ruft auch die "none"-Lane den Recall (semantic
  // reflex) — aber ohne reflex-verdrahtete REQUIRED-Hits bleibt die Ausgabe
  // leer: gewöhnliche Hits injizieren auf Arbeits-Prompts weiterhin nichts.
  let recallCalled = false;
  const daemon = await startMockDaemon((req, res) => {
    if (req.url === "/hook/recall") recallCalled = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    // Ein starker, aber NICHT reflex-verdrahteter Hit — darf nicht durch.
    res.end(
      JSON.stringify({
        hits: [
          { id: "ordinary-fact", title: "T", type: "project-fact", scope: "p", summary: "s", score: 150 },
        ],
        vault_size: 1,
        latency_ms: 1,
        recall_id: "x",
      }),
    );
  });
  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "lass uns das implementieren",
        cwd: process.cwd(),
      },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );
    assert.equal(stdout.trim(), "{}");
    assert.equal(recallCalled, true, "the none lane now recalls — the filter, not the skip, keeps it quiet");
  } finally {
    await daemon.close();
  }
});

test("integration — semantic reflex: a reflex-wired REQUIRED hit injects on a mode-none prompt (19.08. incident)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-semref-state-"));
  const daemon = await startMockDaemon((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    if (req.url === "/hook/hinted") {
      res.end('{"ok":true}');
      return;
    }
    // Der hybride Arm versteht die Flexion, die das Token-AND nie überlebt:
    // die reflex-verdrahtete Konvention kommt mit REQUIRED-Score zurück,
    // daneben ein gleichstarker gewöhnlicher Hit.
    res.end(
      JSON.stringify({
        hits: [
          {
            id: "nachrichtenkonvention",
            title: "Nachrichtenkonvention",
            type: "meta-working",
            scope: "all-projects",
            summary: "Erst die deutsche Fassung, Plain-Text, Ich-Form.",
            // Realwert vom 19.08.: der verworrene Original-Prompt rankte die
            // Konvention auf 84 — sub-REQUIRED, aber sie MUSS durchkommen.
            score: 84,
            recall_mode: "reflex",
          },
          { id: "ordinary-fact", title: "T", type: "project-fact", scope: "p", summary: "s", score: 150 },
        ],
        vault_size: 2,
        latency_ms: 1,
        recall_id: "x",
      }),
    );
  });
  try {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "semref-session",
      prompt: "dann möchte ich dass du mir eine Nachricht entwirfst, kurz und knapp",
      cwd: process.cwd(),
    };
    const env = { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`, BASTRA_HOOK_STATE_DIR: stateDir };
    const { stdout } = await runHook(payload, env);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /nachrichtenkonvention/, "the reflex-wired convention reaches the agent");
    assert.ok(!ctx.includes("ordinary-fact"), "a non-reflex hit stays out of mode-none injection");

    // Kontaminations-Guard (zzalli, 19.08.): dieselbe Session bekommt die
    // Konvention nicht bei jedem Entwurfs-Prompt erneut — Session-Dedup
    // wie in der harten Reflex-Lane, 1× pro 4h-Fenster.
    const second = await runHook(payload, env);
    assert.equal(second.stdout.trim(), "{}", "a re-prompt in the same session does not re-inject");
  } finally {
    await daemon.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("integration — semantic reflex: a wired convention below the top-k cut arrives via reflex_hits (20.08. incident)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-semref-pool-"));
  const daemon = await startMockDaemon((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    if (req.url === "/hook/hinted") {
      res.end('{"ok":true}');
      return;
    }
    // 20.08.: the top-5 were five unrelated hits; the wired convention sat at
    // pool rank 6 (score 61) and the lane never saw it. The route now ships
    // reflex-wired pool members separately.
    res.end(
      JSON.stringify({
        hits: Array.from({ length: 5 }, (_, i) => ({
          id: `unrelated-${i}`, title: "T", type: "project-fact", scope: "p", summary: "s", score: 150 - i,
        })),
        reflex_hits: [
          {
            id: "nachrichtenkonvention",
            title: "Nachrichtenkonvention",
            type: "meta-working",
            scope: "all-projects",
            summary: "Erst die deutsche Fassung, Plain-Text, Ich-Form.",
            score: 61,
            recall_mode: "reflex",
          },
        ],
        vault_size: 6,
        latency_ms: 1,
        recall_id: "x",
      }),
    );
  });
  try {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "semref-pool-session",
      prompt: "antwortentwurf bitte. ich freue mich das komplett zu testen sobald ich die freie zeit finde",
      cwd: process.cwd(),
    };
    const env = { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`, BASTRA_HOOK_STATE_DIR: stateDir };
    const { stdout } = await runHook(payload, env);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /nachrichtenkonvention/, "the wired convention reaches the agent from below the cut");
    assert.ok(!ctx.includes("unrelated-"), "the ordinary top-k stays out of mode-none injection");
  } finally {
    await daemon.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("integration — reflex hit fires without a retrieval signal (#217)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-reflex-state-"));
  let recallCalled = false;
  let hintedIds: string[] | null = null;
  const daemon = await startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url === "/hook/recall") recallCalled = true;
      if (req.url === "/hook/hinted") hintedIds = (JSON.parse(body) as { ids: string[] }).ids;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/hook/reflex") {
        res.end(
          JSON.stringify({
            hits: [
              {
                id: "reflex-css-lesson",
                title: "CSS-Spezifität",
                type: "lesson",
                scope: "all-projects",
                summary: "Inline style schlägt Tailwind-Hover immer.",
                matched_phrase: "tailwind grid",
              },
            ],
            recall_id: "reflex-1",
          }),
        );
        return;
      }
      res.end('{"ok":true}');
    });
  });
  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "lass uns das tailwind grid implementieren",
        cwd: process.cwd(),
        session_id: "reflex-session",
      },
      {
        BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
        BASTRA_HOOK_STATE_DIR: stateDir,
      },
    );
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /trigger="reflex"/);
    assert.match(ctx, /reflex-css-lesson/);
    assert.match(ctx, /trigger "tailwind grid"/);
    // Seit dem 19.08.-Vorfall läuft der Recall auch ohne Retrieval-Signal
    // (semantic reflex) — still bleibt nur die Injektion gewöhnlicher Hits.
    assert.equal(recallCalled, true, "the none lane recalls; its filter does the quieting");
    assert.deepEqual(hintedIds, ["reflex-css-lesson"], "reflex injection counts as surfaced");
  } finally {
    await daemon.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("integration — wrong hook_event_name emits empty object", async () => {
  const daemon = await startMockDaemon((_req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const { stdout } = await runHook(
      { hook_event_name: "PreToolUse", prompt: "such mal meinen Strafzettel" },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );
    assert.equal(stdout.trim(), "{}");
  } finally {
    await daemon.close();
  }
});

// ─── #151: trivial-prompt gate ───────────────────────────────────────────

test("isTrivialPrompt gates bare acks DE+EN (trailing punctuation tolerated)", () => {
  for (const p of ["ok", "OK!", "ja", "Ja.", "danke", "passt", "yes", "thanks", "weiter", "nö", "go"]) {
    assert.equal(isTrivialPrompt(p), true, `should gate: ${p}`);
  }
});

test("isTrivialPrompt gates slash-command invocations, typed and expanded", () => {
  assert.equal(isTrivialPrompt("/fast"), true);
  assert.equal(isTrivialPrompt("/code-review ultra 123"), true);
  assert.equal(isTrivialPrompt("<command-name>/effort</command-name>\nstdout follows"), true);
  assert.equal(isTrivialPrompt("<local-command-caveat>...</local-command-caveat>"), true);
});

test("isTrivialPrompt does NOT gate paths, retrieval queries, or real prose", () => {
  assert.equal(isTrivialPrompt("/Users/n0mad/Projekte/x bitte lesen"), false);
  assert.equal(isTrivialPrompt("find my rental contract"), false);
  assert.equal(isTrivialPrompt("such mal meinen mietvertrag"), false);
  assert.equal(isTrivialPrompt("wo ist die config für den daemon"), false);
  assert.equal(isTrivialPrompt("ok, aber warum schlägt der test fehl?"), false);
});

test("gate wins over retrieval regex on expanded command payloads", () => {
  // An expanded slash-command payload whose body happens to contain a
  // retrieval-shaped phrase must still be gated — the phrase is skill/command
  // scaffolding, not user intent.
  const payload = "<command-name>/deep-research</command-name>\nfind all sources about X";
  assert.equal(isTrivialPrompt(payload), true);
});

// ─── #161: backoff safety — retrieval exemption + generic-mode invariant ──

test("#161 — generic mode floors at MUST_LOAD_SCORE: suppression impossible by construction", () => {
  // Every hit surviving the generic floor sits in the REQUIRED band …
  assert.ok(
    effectiveScoreFloor("generic") >= MUST_LOAD_SCORE,
    "generic floor must be >= MUST_LOAD_SCORE — this is what makes the invariant hold",
  );
  // … so hasRequired is true for any non-empty generic emission, and the
  // shared decideBackoff can never suppress it — whatever the streak says.
  const hotEntries: SourceBackoff[] = [
    { streak: 2, at: Date.now() - 1000, ids: ["x"], skipped: 0 },
    { streak: 50, at: Date.now() - 1000, ids: ["x"], skipped: 0 },
  ];
  for (const e of hotEntries) {
    assert.equal(decideBackoff(e, false, false).suppress, true, "precondition: would suppress");
    assert.equal(decideBackoff(e, false, true).suppress, false, "REQUIRED band bypasses");
  }
});

test("integration — #161: retrieval lookup is NEVER suppressed, even in a hot suppression window", async () => {
  // Pre-seed a prompt-lookup backoff state that would suppress a generic
  // emission (streak far above BACKOFF_MIN_STREAK, window wide open).
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-prompt-backoff-"));
  const sessionId = "prompt-backoff-retrieval-exempt";
  await writeFile(
    join(stateDir, `${sessionId}.json`),
    JSON.stringify({
      shown: {},
      sources: {
        "prompt-lookup": { streak: 6, at: Date.now() - 1000, ids: ["old-hit"], skipped: 0 },
      },
    }),
    "utf8",
  );

  const daemon = await startMockDaemon((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/recall") {
      // Sub-REQUIRED score (70 < MUST_LOAD_SCORE): the emission must survive
      // via the retrieval exemption itself, not via the hasRequired bypass.
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "lease-2024",
              title: "Mietvertrag 2024",
              type: "project-fact",
              scope: "personal",
              summary: "Mietvertrag Hauptstr. 5, unterschrieben 2024-01-15.",
              score: 70,
            },
          ],
          vault_size: 50,
          latency_ms: 5,
          recall_id: "t",
        }),
      );
    } else {
      res.end("{}");
    }
  });

  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "such mal meinen Mietvertrag",
        session_id: sessionId,
        cwd: process.cwd(),
      },
      {
        BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
        BASTRA_HOOK_STATE_DIR: stateDir,
      },
    );
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    assert.ok(parsed.hookSpecificOutput, "retrieval lookup must emit — never suppressed");
    assert.match(parsed.hookSpecificOutput?.additionalContext ?? "", /lease-2024/);
  } finally {
    await daemon.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

/** #356: read every telemetry event a lane wrote into a throwaway log dir. */
async function readTelemetryEvents(dir: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

test("#356 — prompt_hook_call carries the payload session_id and the injected token estimate", async () => {
  // Before the fix every event stamped a fresh randomUUID(), so 69 prompt
  // calls on one day looked like 69 sessions and the context tax (#354)
  // could not be summed per session. hint_tokens_est was missing entirely.
  const daemon = await startMockDaemon((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    if (req.url === "/hook/recall") {
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "parkticket-2025",
              title: "Strafzettel März 2025",
              type: "project-fact",
              scope: "personal",
              summary: "Parkverstoß Berlin Mitte, 35€, bezahlt 2025-03-12.",
              score: 142,
            },
          ],
          vault_size: 100,
          latency_ms: 12,
          recall_id: "test-recall",
        }),
      );
      return;
    }
    res.end("{}");
  });
  const logDir = await mkdtemp(join(tmpdir(), "bastra-prompt-telemetry-"));
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-prompt-state-"));
  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "such mal meinen Strafzettel",
        cwd: process.cwd(),
        session_id: "prompt-sess-356",
      },
      {
        BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
        BASTRA_HOOK_STATE_DIR: stateDir,
        BASTRA_TELEMETRY: "on",
        BASTRA_LOG_PATH: logDir,
      },
    );
    assert.match(stdout, /parkticket-2025/, "the hint must have been injected");

    const ev = (await readTelemetryEvents(logDir)).find((e) => e.kind === "prompt_hook_call");
    assert.ok(ev, "a prompt_hook_call event must be written");
    assert.equal(ev.session_id, "prompt-sess-356", "the event carries the payload's session, not a synthetic one");
    assert.equal(typeof ev.hint_tokens_est, "number");
    assert.ok((ev.hint_tokens_est as number) > 0, "injected block must be counted");
  } finally {
    await daemon.close();
    await rm(logDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ─── #371: mode "none" only pays for a recall that could contribute ─────────
//
// The lane's mode-"none" filter lets exactly one class of memory through: the
// ones the user wired as `recall_mode: reflex`, and only while the session has
// not already shown them inside the 4h window. Since a50f849 (19.08.) the lane
// paid a full-vault hybrid recall to find that out — 210ms p50 on 91% of
// prompts, 83.5% of them injecting nothing.
//
// The four tests below pin BOTH directions. Two fix today's semantics (what
// injects, and what never did) so the gate cannot quietly change them; two
// prove the gate skips only where the result was going to be discarded.

test("#371 — a reflex-wired hit injects in mode none, with the pool gate exactly as without it", async () => {
  // Fixation of the injecting case: the same prompt, the same mock, run once
  // WITHOUT the pool accessor (the pre-#371 lane) and once WITH it. Both must
  // produce the identical block — the gate may not cost an injection.
  const before = await mkdtemp(join(tmpdir(), "bastra-371-before-"));
  const after = await mkdtemp(join(tmpdir(), "bastra-371-after-"));
  let recallCalls = 0;
  const daemon = await startMockDaemon((req, res) => {
    if (req.url === "/hook/recall") recallCalls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    if (req.url === "/hook/hinted") {
      res.end('{"ok":true}');
      return;
    }
    res.end(
      JSON.stringify({
        hits: [
          {
            id: "nachrichtenkonvention",
            title: "Nachrichtenkonvention",
            type: "meta-working",
            scope: "all-projects",
            summary: "Erst die deutsche Fassung, Plain-Text, Ich-Form.",
            score: 84,
            recall_mode: "reflex",
          },
          { id: "ordinary-fact", title: "T", type: "project-fact", scope: "p", summary: "s", score: 150 },
        ],
        vault_size: 2,
        latency_ms: 1,
        recall_id: "x",
      }),
    );
  });
  try {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      prompt: "dann möchte ich dass du mir eine Nachricht entwirfst, kurz und knapp",
      cwd: process.cwd(),
    };
    const url = `http://127.0.0.1:${daemon.port}`;

    const pre = await runHook(
      { ...payload, session_id: "s371-before" },
      { BASTRA_HTTP_URL: url, BASTRA_HOOK_STATE_DIR: before },
    );
    const post = await runHook(
      { ...payload, session_id: "s371-after" },
      { BASTRA_HTTP_URL: url, BASTRA_HOOK_STATE_DIR: after },
      () => ["nachrichtenkonvention"],
    );

    assert.match(pre.stdout, /nachrichtenkonvention/, "pre-#371 lane injects the wired convention");
    assert.equal(post.stdout, pre.stdout, "the gate must not change the injected block by a single byte");
    assert.equal(recallCalls, 2, "an eligible wired memory still buys a real recall");
  } finally {
    await daemon.close();
    await rm(before, { recursive: true, force: true });
    await rm(after, { recursive: true, force: true });
  }
});

test("#371 — a NON-wired hit never injected in mode none, before or after the gate", async () => {
  // The other half of the fixation: the strongest possible ordinary hit (150,
  // REQUIRED band) was already invisible in mode "none" before the gate, and
  // stays invisible with a non-empty pool. Nothing is lost here because
  // nothing was ever passed through.
  const before = await mkdtemp(join(tmpdir(), "bastra-371-nw-before-"));
  const after = await mkdtemp(join(tmpdir(), "bastra-371-nw-after-"));
  let recallCalls = 0;
  const daemon = await startMockDaemon((req, res) => {
    if (req.url === "/hook/recall") recallCalls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    res.end(
      JSON.stringify({
        hits: [
          { id: "ordinary-fact", title: "T", type: "project-fact", scope: "p", summary: "s", score: 150 },
        ],
        reflex_hits: [],
        vault_size: 1,
        latency_ms: 1,
        recall_id: "x",
      }),
    );
  });
  try {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      prompt: "lass uns das implementieren",
      cwd: process.cwd(),
    };
    const url = `http://127.0.0.1:${daemon.port}`;

    const pre = await runHook(
      { ...payload, session_id: "s371-nw-before" },
      { BASTRA_HTTP_URL: url, BASTRA_HOOK_STATE_DIR: before },
    );
    assert.equal(pre.stdout.trim(), "{}", "a non-wired hit never reached the agent in mode none");
    assert.equal(recallCalls, 1, "…and the pre-#371 lane paid a full recall to learn that");

    const post = await runHook(
      { ...payload, session_id: "s371-nw-after" },
      { BASTRA_HTTP_URL: url, BASTRA_HOOK_STATE_DIR: after },
      () => ["nachrichtenkonvention"],
    );
    assert.equal(post.stdout.trim(), "{}", "still nothing — the filter, not the gate, keeps it out");
    assert.equal(recallCalls, 2, "an eligible wired memory means the recall runs, hit or no hit");
  } finally {
    await daemon.close();
    await rm(before, { recursive: true, force: true });
    await rm(after, { recursive: true, force: true });
  }
});

test("#371 — an empty reflex pool skips the recall entirely", async () => {
  // The default state of a vault: `recall_mode: reflex` is an opt-in reachable
  // only through a confirmed curator promotion. Nothing can pass the
  // mode-"none" filter, so the recall is dead work — 210ms p50 on 91% of
  // prompts, for a filter that cannot fire.
  const logDir = await mkdtemp(join(tmpdir(), "bastra-371-empty-log-"));
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-371-empty-state-"));
  let recallCalled = false;
  let reflexCalled = false;
  const daemon = await startMockDaemon((req, res) => {
    if (req.url === "/hook/recall") recallCalled = true;
    if (req.url === "/hook/reflex") reflexCalled = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    // Would have been a REQUIRED wired hit — must never be requested.
    res.end(
      JSON.stringify({
        hits: [
          {
            id: "nachrichtenkonvention",
            title: "Nachrichtenkonvention",
            type: "meta-working",
            scope: "all-projects",
            summary: "s",
            score: 150,
            recall_mode: "reflex",
          },
        ],
        vault_size: 1,
        latency_ms: 1,
        recall_id: "x",
      }),
    );
  });
  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s371-empty",
        prompt: "dann möchte ich dass du mir eine Nachricht entwirfst, kurz und knapp",
        cwd: process.cwd(),
      },
      {
        BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
        BASTRA_HOOK_STATE_DIR: stateDir,
        BASTRA_TELEMETRY: "on",
        BASTRA_LOG_PATH: logDir,
      },
      () => [],
    );
    assert.equal(stdout.trim(), "{}");
    assert.equal(recallCalled, false, "no wired memory exists — the recall must not be paid for");
    assert.equal(reflexCalled, true, "the hard reflex lane is untouched by the gate");

    // The measurement series must survive the fix: same event, same mode, a
    // latency, plus the reason the recall was skipped.
    const ev = (await readTelemetryEvents(logDir)).find((e) => e.kind === "prompt_hook_call");
    assert.ok(ev, "a prompt_hook_call event is still written on a skipped prompt");
    assert.equal(ev.detected_mode, "none", "the mode field is unchanged");
    assert.equal(typeof ev.latency_ms_total, "number");
    assert.equal(ev.recall_skipped, "reflex-pool-empty");
    assert.equal(ev.status, "no-hits", "the status the discarded-result case already carried");
    assert.equal(ev.daemon_reachable, true, "a skipped recall is not an unreachable daemon");
  } finally {
    await daemon.close();
    await rm(logDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("#371 — once every wired memory is session-suppressed, the recall stops running", async () => {
  // The contamination guard of #217 drops a wired memory that was already
  // shown in this session (1× / 4h). Before the gate the lane still ran the
  // full recall on every following prompt of that window and threw the result
  // away at the dedup — measured on the 19.–24.08. log: 47 of 432 mode-"none"
  // prompts (10.9%), 10.3s of blocked turn start.
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-371-supp-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-371-supp-log-"));
  let recallCalls = 0;
  const daemon = await startMockDaemon((req, res) => {
    if (req.url === "/hook/recall") recallCalls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    if (req.url === "/hook/hinted") {
      res.end('{"ok":true}');
      return;
    }
    res.end(
      JSON.stringify({
        hits: [
          {
            id: "nachrichtenkonvention",
            title: "Nachrichtenkonvention",
            type: "meta-working",
            scope: "all-projects",
            summary: "Erst die deutsche Fassung, Plain-Text, Ich-Form.",
            score: 84,
            recall_mode: "reflex",
          },
        ],
        vault_size: 1,
        latency_ms: 1,
        recall_id: "x",
      }),
    );
  });
  try {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "s371-suppressed",
      prompt: "dann möchte ich dass du mir eine Nachricht entwirfst, kurz und knapp",
      cwd: process.cwd(),
    };
    const env = {
      BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
      BASTRA_HOOK_STATE_DIR: stateDir,
      BASTRA_TELEMETRY: "on",
      BASTRA_LOG_PATH: logDir,
    };
    const pool = () => ["nachrichtenkonvention"];

    const first = await runHook(payload, env, pool);
    assert.match(first.stdout, /nachrichtenkonvention/, "the first prompt of the window injects");
    assert.equal(recallCalls, 1);

    const second = await runHook(payload, env, pool);
    assert.equal(second.stdout.trim(), "{}", "the dedup verdict is unchanged: no re-injection");
    assert.equal(recallCalls, 1, "…and it is now reached WITHOUT a recall");

    const ev = (await readTelemetryEvents(logDir))
      .filter((e) => e.kind === "prompt_hook_call")
      .at(-1);
    assert.equal(ev?.recall_skipped, "reflex-all-suppressed");
    assert.equal(ev?.detected_mode, "none");
  } finally {
    await daemon.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

/**
 * P0 (docs/recall-performance-handoff.md §4.6): Fällt der Vector-Arm aus, liefert
 * `recallHybrid` rohe MiniSearch-Scores statt fusionierter. Die sind nach oben
 * offen — im belegten Incident stand 405.584 dort, wo fusioniert höchstens
 * 163,934 möglich sind. Die Lane las den `unfused`-Marker nicht und maß die
 * rohen Werte an MUST_LOAD_SCORE: alles wurde REQUIRED, umging den Backoff und
 * wurde als „beide Suchpfade waren sich einig" angekündigt.
 */
test("formatHintBlock — unfused never claims both search paths agreed", () => {
  const hits: RecallHit[] = [
    { id: "raw-bm25-hit", title: "R", type: "lesson", scope: "p", summary: "s", score: 405584.777 },
  ];
  const block = formatHintBlock(hits, "bastra-recall", "generic", false, true);
  assert.doesNotMatch(block, /both search paths agreed/);
  assert.match(block, /semantic search is off/i);
  assert.match(block, /raw-bm25-hit/, "the hit itself must still be offered");
});

test("formatHintBlock — unfused shows no REQUIRED band and no score number", () => {
  const hits: RecallHit[] = [
    { id: "big", title: "B", type: "lesson", scope: "p", summary: "s", score: 405584.777 },
    { id: "small", title: "S", type: "lesson", scope: "p", summary: "s", score: 61.2 },
  ];
  const block = formatHintBlock(hits, "bastra-recall", "generic", false, true);
  assert.doesNotMatch(block, /REQUIRED/, "an open-ended scale cannot produce a REQUIRED band");
  assert.doesNotMatch(block, /OPTIONAL \(score/, "nor an OPTIONAL band");
  assert.doesNotMatch(block, /405584|405585/, "the raw number invites a comparison it cannot support");
  assert.match(block, /big/);
  assert.match(block, /small/, "below the old floor is meaningless here — the hit stays");
});

test("formatHintBlock — the fused path keeps its bands and its number", () => {
  const hits: RecallHit[] = [
    { id: "fused", title: "F", type: "lesson", scope: "p", summary: "s", score: 152.4 },
  ];
  const block = formatHintBlock(hits, "bastra-recall", "generic", false, false);
  assert.match(block, /both search paths agreed/);
  assert.match(block, /score 152/, "on the fused scale the number is comparable and stays");
});

test("integration — P0: an unfused recall gets no REQUIRED bypass out of the backoff", async () => {
  // Der belegte Incident: Vector-Arm in die Deadline gelaufen, `score` roh bei
  // 405.584. Die alte Lane las das als REQUIRED (>= 100), umging damit den
  // Backoff und behauptete Einigkeit zweier Suchpfade, von denen nur einer lief.
  // Ein heißes Suppression-Fenster ist hier der Prüfstand: Ohne Bypass MUSS die
  // Unterdrückung greifen.
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-prompt-unfused-"));
  const sessionId = "prompt-unfused-no-bypass";
  await writeFile(
    join(stateDir, `${sessionId}.json`),
    JSON.stringify({
      shown: {},
      sources: {
        "prompt-lookup": { streak: 6, at: Date.now() - 1000, ids: ["old-hit"], skipped: 0 },
      },
    }),
    "utf8",
  );

  const daemon = await startMockDaemon((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/recall") {
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "raw-scale-hit",
              title: "Raw",
              type: "lesson",
              scope: "other-project",
              summary: "reached the lane on the unfused scale",
              score: 405584.777,
            },
          ],
          vault_size: 989,
          latency_ms: 400,
          recall_id: "t",
          unfused: true,
          degraded: "vector-arm-timeout",
        }),
      );
    } else {
      res.end("{}");
    }
  });

  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        // Kein Retrieval-Wortlaut: Die Retrieval-Ausnahme darf den Test nicht
        // von hinten retten, geprüft wird allein der fehlende REQUIRED-Bypass.
        prompt: "ich baue hier gerade eine funktion um und schaue mir den code an",
        session_id: sessionId,
        cwd: process.cwd(),
      },
      {
        BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
        BASTRA_HOOK_STATE_DIR: stateDir,
        BASTRA_PROMPT_HINTS: "all",
      },
    );
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.doesNotMatch(ctx, /both search paths agreed/, "only one path ran — do not claim two");
    if (ctx.includes("raw-scale-hit")) {
      assert.doesNotMatch(ctx, /REQUIRED/, "a raw score must not be presented as a REQUIRED band");
      assert.doesNotMatch(ctx, /405584|405585/, "the raw number must not be shown as a comparable score");
    }
  } finally {
    await daemon.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
