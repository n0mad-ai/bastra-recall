/**
 * `bastra onboard` terminal interview (#645): scripted answers that arrive
 * all at once, or input that ends early, must neither drop lines nor crash
 * with ERR_USE_AFTER_CLOSE; `--answers <file>` saves without readline.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/onboard-cmd.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { cmdOnboard, loadAnswersFile, runInterview } from "../src/cli/onboard-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { isOnboardingDone, questionsFor } from "../src/onboarding.js";
import { ONBOARD_REPLAY_MAX_TURNS } from "../src/cli/doctor-replay.js";

function sink(): PassThrough {
  const out = new PassThrough();
  out.resume();
  return out;
}

test("runInterview: every scripted answer piped in one chunk is kept (none dropped before its prompt)", async () => {
  const input = new PassThrough();
  const personal = questionsFor("personal");
  const lines = ["9", "3", ...personal.map((q, i) => (q.optional ? "" : `answer ${i}`))];
  input.end(lines.join("\n") + "\n");
  const result = await runInterview(input, sink());
  assert.ok(result);
  assert.equal(result.persona, "personal");
  const expected: Record<string, string> = {};
  personal.forEach((q, i) => {
    if (!q.optional) expected[q.id] = `answer ${i}`;
  });
  assert.deepEqual(result.answers, expected);
});

test("runInterview: input that ends mid-interview resolves null instead of throwing ERR_USE_AFTER_CLOSE", async () => {
  const input = new PassThrough();
  input.end("1\nAlex\n");
  assert.equal(await runInterview(input, sink()), null);
});

test("runInterview: EOF while a prompt is pending resolves null (no hang)", async () => {
  const input = new PassThrough();
  const pending = runInterview(input, sink());
  setTimeout(() => input.write("2\n"), 5);
  setTimeout(() => input.end(), 20);
  assert.equal(await pending, null);
});

// ─── --answers <file> (#645) ─────────────────────────────────────────────────

test("loadAnswersFile: YAML and JSON give the same persona + answers; numbers become text; unknown ids are reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-answers-"));
  try {
    const yamlPath = join(dir, "answers.yaml");
    await writeFile(
      yamlPath,
      "persona: developer\nanswers:\n  identity: Sam · English · terse\n  conventions_size: 500\n  people: Anna\n",
      "utf8",
    );
    const jsonPath = join(dir, "answers.json");
    await writeFile(
      jsonPath,
      JSON.stringify({ persona: "developer", answers: { identity: "Sam · English · terse", conventions_size: 500, people: "Anna" } }),
      "utf8",
    );
    const expected = {
      persona: "developer",
      answers: { identity: "Sam · English · terse", conventions_size: "500", people: "Anna" },
      ignored: ["people"],
    };
    assert.deepEqual(await loadAnswersFile(yamlPath), expected);
    assert.deepEqual(await loadAnswersFile(jsonPath), expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAnswersFile: a missing persona, bad JSON or a missing file is an error, never a partial save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-answers-"));
  try {
    await writeFile(join(dir, "nopersona.yaml"), "answers:\n  identity: Sam\n", "utf8");
    await writeFile(join(dir, "broken.json"), "{ persona: ", "utf8");
    for (const f of ["nopersona.yaml", "broken.json", "missing.yaml"]) {
      const r = await loadAnswersFile(join(dir, f));
      assert.ok("error" in r, `${f} should be an error`);
    }
    const r = await loadAnswersFile(join(dir, "nopersona.yaml"));
    assert.ok("error" in r);
    assert.match(r.error, /persona required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAnswersFile: nothing usable plus an ignored or dropped entry is an error naming it; a leading BOM is not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-answers-"));
  try {
    // A typo in the only id, values that are not text.
    await writeFile(join(dir, "typo.yaml"), "persona: personal\nanswers:\n  identty: Kim\n", "utf8");
    await writeFile(join(dir, "nontext.yaml"), "persona: personal\nanswers:\n  identity: true\n  world: [a, b]\n", "utf8");
    const typo = await loadAnswersFile(join(dir, "typo.yaml"));
    assert.ok("error" in typo);
    assert.match(typo.error, /no usable answer \(not a personal question: identty\) — known ids: identity/);
    const nontext = await loadAnswersFile(join(dir, "nontext.yaml"));
    assert.ok("error" in nontext);
    assert.match(nontext.error, /no usable answer \(not text: identity, world\) — known ids: identity/);
    // Only the persona, or a blank answer (the interview's Enter), is a valid
    // file like on the map — the contributor's test pinned blank as an error.
    await writeFile(join(dir, "persona.yaml"), "persona: personal\n", "utf8");
    await writeFile(join(dir, "blank.json"), JSON.stringify({ persona: "personal", answers: { identity: "  " } }), "utf8");
    assert.deepEqual(await loadAnswersFile(join(dir, "persona.yaml")), { persona: "personal", answers: {}, ignored: [] });
    assert.deepEqual(await loadAnswersFile(join(dir, "blank.json")), {
      persona: "personal",
      answers: { identity: "  " },
      ignored: [],
    });
    const bom = join(dir, "bom.json");
    await writeFile(bom, "\uFEFF" + JSON.stringify({ persona: "personal", answers: { identity: "Kim" } }), "utf8");
    assert.deepEqual(await loadAnswersFile(bom), { persona: "personal", answers: { identity: "Kim" }, ignored: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Runs `fn` and returns what it wrote to stderr. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test("cmdOnboard --answers: only a mistyped id exits 2, names the id and leaves onboarding open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-answers-"));
  const vault = join(dir, "vault");
  const savedHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  try {
    const file = join(dir, "answers.yaml");
    await writeFile(file, "persona: personal\nanswers:\n  identty: Kim\n", "utf8");
    const stderr = await captureStderr(async () => {
      assert.equal(await cmdOnboard(parseArgs(["onboard", "--vault", vault, "--answers", file])), 2);
    });
    assert.match(stderr, /no usable answer \(not a personal question: identty\)/);
    assert.equal(await isOnboardingDone(vault), false);
  } finally {
    process.env.HOME = savedHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("cmdOnboard --answers: a file with only the persona completes onboarding, as on the map", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-answers-"));
  const vault = join(dir, "vault");
  const savedHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  try {
    const file = join(dir, "answers.yaml");
    await writeFile(file, "persona: developer\n", "utf8");
    assert.equal(await cmdOnboard(parseArgs(["onboard", "--vault", vault, "--answers", file])), 0);
    assert.equal(await isOnboardingDone(vault), true);
  } finally {
    process.env.HOME = savedHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("cmdOnboard --answers: one valid answer plus a mistyped id saves, warns about the id and sets the marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-answers-"));
  const vault = join(dir, "vault");
  const savedHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  try {
    const file = join(dir, "answers.yaml");
    await writeFile(file, "persona: personal\nanswers:\n  identity: Kim\n  wrold: Warsaw\n", "utf8");
    const stderr = await captureStderr(async () => {
      assert.equal(await cmdOnboard(parseArgs(["onboard", "--vault", vault, "--answers", file])), 0);
    });
    assert.match(stderr, /ignored \(not a personal question\): wrold/);
    assert.equal(await isOnboardingDone(vault), true);
  } finally {
    process.env.HOME = savedHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseArgs: onboard --answers <file> and --answers=<file> are accepted", () => {
  assert.equal(parseArgs(["onboard", "--answers", "a.yaml"]).answers, "a.yaml");
  assert.equal(parseArgs(["onboard", "--answers=a.json"]).answers, "a.json");
  assert.deepEqual(parseArgs(["onboard", "--answers", "a.yaml"]).errors, []);
  assert.deepEqual(parseArgs(["onboard", "--answers"]).errors, ["option '--answers' needs a value"]);
});

test("cmdOnboard --answers: saves through the interview's save path without a TTY and sets the marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-answers-"));
  const vault = join(dir, "vault");
  const savedHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  try {
    const file = join(dir, "answers.yaml");
    await writeFile(file, "persona: personal\nanswers:\n  identity: Kim · Polish, informal\n  world: Warsaw · two cats\n", "utf8");
    assert.equal(await cmdOnboard(parseArgs(["onboard", "--vault", vault, "--answers", file])), 0);
    assert.equal(await isOnboardingDone(vault), true);
    const audit = (await readFile(join(vault, ".bastra", "audit-log.ndjson"), "utf8")).trim().split("\n");
    assert.equal(audit.length, 3, "usage profile + identity + world");
    const settings = await readFile(join(dir, "home", ".bastra", "cli-settings.json"), "utf8");
    assert.match(settings, /"pl"/, "the language named in identity lands in cli-settings");
  } finally {
    process.env.HOME = savedHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("cmdOnboard ends with the shadow replay (#702), capped at the latest turns with a hint how to replay them all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-replay-"));
  const vault = join(dir, "vault");
  const home = join(dir, "home");
  // More turns than the cap, inside the default 14-day window.
  const proj = join(home, ".claude", "projects", "-Users-me-proj");
  await mkdir(proj, { recursive: true });
  const total = ONBOARD_REPLAY_MAX_TURNS + 5;
  const now = Date.now();
  const rows = Array.from({ length: total }, (_, i) => JSON.stringify({
    type: "user",
    timestamp: new Date(now - (total - i) * 60_000).toISOString(),
    cwd: "/Users/me/proj",
    message: { role: "user", content: `turn ${i}` },
  }));
  await writeFile(join(proj, "sess-1.jsonl"), rows.join("\n") + "\n", "utf8");
  // A stand-in daemon on its own port — never the user's — that knows the
  // replay mode and answers every turn with an empty lane row.
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/health") {
        res.end(JSON.stringify({ ok: true, version: "test", vault_size: 0 }));
        return;
      }
      const body = JSON.parse(raw) as { payload: { prompt: string; session_id: string } };
      prompts.push(body.payload.prompt);
      res.end(JSON.stringify({
        stdout: "{}",
        telemetry: {
          session_id: body.payload.session_id, origin: "owner", gated: false, status: "no-hits",
          detected_mode: "none", hinted_ids: [], latency_ms_total: 1,
        },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const saved = { home: process.env.HOME, url: process.env.BASTRA_DAEMON_URL, cfg: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let stdout = "";
  const original = process.stdout.write.bind(process.stdout);
  try {
    const file = join(dir, "answers.yaml");
    await writeFile(file, "persona: developer\n", "utf8");
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const code = await cmdOnboard(parseArgs(["onboard", "--vault", vault, "--answers", file]));
    process.stdout.write = original;
    assert.equal(code, 0);
    // The probe is the empty prompt; every other POST is a replayed turn.
    const turns = prompts.filter((p) => p !== "");
    assert.equal(turns.length, ONBOARD_REPLAY_MAX_TURNS, "capped");
    assert.ok(turns.includes(`turn ${total - 1}`) && !turns.includes("turn 0"), "the latest turns are kept");
    assert.match(stdout, new RegExp(`replaying the latest ${ONBOARD_REPLAY_MAX_TURNS} of ${total} user turns`));
    assert.match(stdout, /bastra doctor --replay --days 14/);
    assert.match(stdout, /How recall answers your own prompts on this vault/);
  } finally {
    process.stdout.write = original;
    process.env.HOME = saved.home;
    if (saved.url === undefined) delete process.env.BASTRA_DAEMON_URL;
    else process.env.BASTRA_DAEMON_URL = saved.url;
    if (saved.cfg !== undefined) process.env.CLAUDE_CONFIG_DIR = saved.cfg;
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
