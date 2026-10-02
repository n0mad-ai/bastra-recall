/**
 * #765: `detectRetrieval` (prompt lane, #33) reads its leads from per-language
 * lexicon data (de/en/ru, `retrieval-lead.txt`) instead of two DE/EN regex
 * literals — checked with the false positives the #765 review measured on
 * prefix stems, with Turkish (unlisted: the neutral path, and a lexicon file
 * that adds it), and through the lane, where the label decides the floor.
 *
 * Own file because prompt-lane.test.ts is past the size ceiling (its DE/EN
 * trigger lists stay there and run against the same data); the helpers are
 * the minimal copies of prompt-assertion-707.test.ts.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/prompt-retrieval-765.test.ts
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runPromptLane } from "../src/prompt-lane.js";
import { MUST_LOAD_SCORE, detectRetrieval } from "../src/prompt-classify.js";
import { DEFAULT_RETRIEVAL_LEAD_CUES_BY_LANGUAGE, decisionCues } from "../src/lexicon.js";

async function withLexiconDir(files: Record<string, string>, run: () => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-765-lex-"));
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

test("#765 retrieval: a prompt that only starts like a lookup is not one", async () => {
  await withLexiconDir({}, () => {
    const cases = [
      // The three the review measured on the prefix stems of #765.
      "когда мы закончим, удали ветку",
      "сколько будет 2+2",
      "найдёшь время?",
      // Same shape: a future or a present, a longer word behind the lead.
      "когда мы закончим миграцию, обнови README",
      "когда будет готово, напиши",
      "сколько строк в этом файле",
      "найдётся ли способ проще",
      "постгрес упал",
      "Suchmaschine für die Doku bauen",
      "findest du das gut so?",
      "findings from the audit go into the report",
      "searchable index for the docs, please",
    ];
    for (const c of cases) assert.equal(detectRetrieval(c), false, `expected NO retrieval match for: ${c}`);
  });
});

test("#765 retrieval: lookups in Russian, German and English are recognised", async () => {
  await withLexiconDir({}, () => {
    const cases = [
      "найди заметку про деплой",
      "Найдите договор аренды",
      "найти счёт за сервер",
      "поищи письмо от архитектора",
      "где лежит конфиг nginx",
      "где находятся заметки со встречи",
      "когда был последний деплой",
      "когда мы обновляли сертификаты",
      "когда я подписал договор",
      "когда мы созванивались с подрядчиком",
      "сколько стоил сервер",
      "сколько мы заплатили за домен",
      "сколько я потратила на аренду",
      "что мы решили по деплою",
      "что я говорила архитектору",
      "что было на встрече в июле",
      "such mal meinen Strafzettel",
      "Suche nach Rechnungen von 2024",
      "finde alle PDFs zum Mietvertrag",
      "wo sind die Notizen vom Meeting?",
      "wann hatte ich Urlaub im Juli?",
      "wie viel Miete im März?",
      "wie viele Rechnungen kamen 2024?",
      "Was hab ich gestern gemacht?",
      "was haben wir zum Deploy entschieden?",
      "was war der Stand bei der Steuer?",
      "find the parking ticket pdf",
      "search invoices from last quarter",
      "where are the meeting notes?",
      "when did I sign the contract?",
      "how much did I spend on rent?",
      "what was the status on the tax filing?",
    ];
    for (const c of cases) assert.equal(detectRetrieval(c), true, `expected retrieval match for: ${c}`);
  });
});

const TURKISH = "nerede nginx yapılandırması";

test("#765 retrieval: an unlisted language is not classified by guess, and a lexicon file adds it", async () => {
  await withLexiconDir({}, () => assert.equal(detectRetrieval(TURKISH), false));
  await withLexiconDir({ "retrieval-lead.txt": "nerede\n" }, () => {
    assert.equal(detectRetrieval(TURKISH), true);
    assert.equal(detectRetrieval("neredeyse bitti"), false, "a file cue is bounded like a shipped one");
  });
});

test("#765 retrieval: every shipped lead fits the cue grammar a file entry has to meet", async () => {
  // A suffix makes each one a NEW cue, so it is validated instead of deduped.
  const variants = Object.values(DEFAULT_RETRIEVAL_LEAD_CUES_BY_LANGUAGE).flat().map((c) => `${c}zz`);
  await withLexiconDir({ "decision.txt": variants.join("\n") }, () => {
    const cues = decisionCues();
    for (const v of variants) assert.ok(cues.includes(v), `default-shaped cue rejected: ${v}`);
  });
});

// ─── what the label decides, through the lane ────────────────────────

/** A daemon whose recall answers with one hit at `score`. */
async function recallMock(score: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/hook/reflex") return void res.end('{"hits":[],"recall_id":null}');
      if (req.url === "/hook/hinted") return void res.end('{"ok":true}');
      const hit = { id: "deploy-note", title: "T", type: "project-fact", scope: "p", summary: "s", score };
      res.end(JSON.stringify({ vault_size: 10, latency_ms: 1, recall_id: "r", hits: [hit] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** Runs the lane on `prompt`; returns its output and the `prompt_hook_call` row. */
async function runLane(prompt: string, score: number): Promise<{ stdout: string; row: Record<string, unknown> }> {
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-765-state-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-765-log-"));
  const lexiconDir = await mkdtemp(join(tmpdir(), "bastra-765-lex-"));
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
    const payload = { hook_event_name: "UserPromptSubmit", session_id: "s765", prompt, cwd: process.cwd() };
    const stdout = await runPromptLane(payload as Parameters<typeof runPromptLane>[0], null, daemon.url);
    const rows: Record<string, unknown>[] = [];
    for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-"))) {
      for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) if (l.trim()) rows.push(JSON.parse(l) as Record<string, unknown>);
    }
    const row = rows.find((r) => r.kind === "prompt_hook_call");
    assert.ok(row, "the lane wrote its row");
    return { stdout, row };
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await daemon.close();
    for (const d of [stateDir, logDir, lexiconDir]) await rm(d, { recursive: true, force: true });
  }
}

test("#765 retrieval: a Russian lookup recalls at the retrieval floor", async () => {
  const { stdout, row } = await runLane("где лежит конфиг nginx", MUST_LOAD_SCORE - 30);
  assert.equal(row.detected_mode, "retrieval");
  assert.match(stdout, /deploy-note/, "a hit under the must-load score is delivered in retrieval mode");
  assert.match(stdout, /LOOKUP/, "the block is worded as the answer to a lookup");
});

test("#765 retrieval: an instruction that opens with a question word keeps the must-load floor", async () => {
  for (const prompt of ["когда мы закончим, удали ветку", "сколько будет 2+2"]) {
    const { stdout, row } = await runLane(prompt, MUST_LOAD_SCORE - 30);
    assert.equal(row.detected_mode, "generic", prompt);
    assert.equal(stdout.trim(), "{}", `below the must-load score nothing is injected for: ${prompt}`);
  }
});
