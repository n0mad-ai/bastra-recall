/**
 * #707: `detectAssertion` (prompt lane, #252) is per-language data, not four
 * DE/EN regex literals with ASCII `\b` — checked with Russian (shipped) and
 * Greek (unlisted: the neutral path, and a lexicon file that adds it).
 *
 * Own file because prompt-lane.test.ts is past the size ceiling; the helpers
 * are the minimal copies of its mock daemon and runner.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/prompt-assertion-707.test.ts
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runPromptLane } from "../src/prompt-lane.js";
import { MUST_LOAD_SCORE, detectAssertion } from "../src/prompt-classify.js";

async function withLexiconDir(files: Record<string, string>, run: () => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-707-assert-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, "utf8");
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("#707 assertion: shipped Russian cues classify an outbound request and a project-state question", async () => {
  await withLexiconDir({}, () => {
    for (const prompt of [
      "напиши ответ на комментарий в треде",
      "Подготовь анонс для блога",
      "сколько тестов у нас сейчас",
      "какой статус по метрикам",
    ]) {
      assert.equal(detectAssertion(prompt), true, prompt);
    }
  });
});

test("#707 assertion: two signals in Russian too — a bare verb or a cue inside a longer word is no trigger", async () => {
  await withLexiconDir({}, () => {
    for (const prompt of [
      "напиши функцию разбора заголовка",
      // `тест…` sits inside a longer word: a Unicode letter boundary, where ASCII `\b` sees none.
      "сколько раз протестировать",
    ]) {
      assert.equal(detectAssertion(prompt), false, prompt);
    }
  });
});

test("#707 assertion: an issue reference is an outward artefact in any script", async () => {
  await withLexiconDir({}, () => {
    assert.equal(detectAssertion("сформулируй это для #257"), true);
    assert.equal(detectAssertion("verfasse das für #257"), true);
  });
});

const GREEK = "γράψε μια απάντηση στο σχόλιο";

test("#707 assertion: an unlisted language is not classified by guess, and a lexicon file adds it", async () => {
  await withLexiconDir({}, () => assert.equal(detectAssertion(GREEK), false));
  await withLexiconDir({ "compose-verb.txt": "γράψε\n", "outward-artifact.txt": "σχόλιο\n" }, () =>
    assert.equal(detectAssertion(GREEK), true),
  );
});

// ─── the neutral path, through the lane ──────────────────────────────

/** A daemon whose recall answers with one hit at `score`; counts the recalls. */
async function recallMock(score: number): Promise<{ url: string; recalls: () => number; close: () => Promise<void> }> {
  let recalls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/hook/reflex") return void res.end('{"hits":[],"recall_id":null}');
      if (req.url === "/hook/hinted") return void res.end('{"ok":true}');
      recalls++;
      const hit = { id: "measured-fact", title: "T", type: "project-fact", scope: "p", summary: "s", score };
      res.end(JSON.stringify({ vault_size: 10, latency_ms: 1, recall_id: "r", hits: [hit] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    recalls: () => recalls,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** Runs the lane on `prompt`; returns its output and the `prompt_hook_call` row. */
async function runLane(prompt: string, score: number): Promise<{ stdout: string; recalls: number; row: Record<string, unknown> }> {
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-707-state-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-707-log-"));
  const lexiconDir = await mkdtemp(join(tmpdir(), "bastra-707-lex-"));
  const daemon = await recallMock(score);
  const env: Record<string, string> = {
    BASTRA_HOOK_STATE_DIR: stateDir,
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: logDir,
    BASTRA_LEXICON_DIR: lexiconDir,
  };
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const payload = { hook_event_name: "UserPromptSubmit", session_id: "s707", prompt, cwd: process.cwd() };
    const stdout = await runPromptLane(payload as Parameters<typeof runPromptLane>[0], null, daemon.url);
    const rows: Record<string, unknown>[] = [];
    for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-"))) {
      for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) if (l.trim()) rows.push(JSON.parse(l) as Record<string, unknown>);
    }
    const row = rows.find((r) => r.kind === "prompt_hook_call");
    assert.ok(row, "the lane wrote its row");
    return { stdout, recalls: daemon.recalls(), row };
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await daemon.close();
    for (const d of [stateDir, logDir, lexiconDir]) await rm(d, { recursive: true, force: true });
  }
}

test("#707 assertion: a Russian outbound request recalls at the assertion floor", async () => {
  const below = MUST_LOAD_SCORE - 30;
  const { stdout, recalls, row } = await runLane("напиши ответ на комментарий в треде", below);
  assert.equal(row.detected_mode, "assertion");
  assert.equal(recalls, 1);
  assert.match(stdout, /measured-fact/, "a hit under the must-load score is delivered in assertion mode");
});

test("#707 assertion: an unlisted language takes the neutral path — it still recalls, gated by score", async () => {
  const strong = await runLane(GREEK, MUST_LOAD_SCORE + 40);
  assert.equal(strong.row.detected_mode, "generic");
  assert.equal(strong.recalls, 1, "the prompt is recalled on, not skipped");
  assert.match(strong.stdout, /measured-fact/, "a must-load hit reaches the prompt");
  const weak = await runLane(GREEK, MUST_LOAD_SCORE - 30);
  assert.equal(weak.recalls, 1);
  assert.equal(weak.stdout.trim(), "{}", "below the must-load score nothing is injected on a guess");
});
