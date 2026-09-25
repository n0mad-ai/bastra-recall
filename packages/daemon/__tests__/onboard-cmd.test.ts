/**
 * `bastra onboard` terminal interview (#645): scripted answers that arrive
 * all at once, or input that ends early, must neither drop lines nor crash
 * with ERR_USE_AFTER_CLOSE; `--answers <file>` saves without readline.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/onboard-cmd.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { cmdOnboard, loadAnswersFile, runInterview } from "../src/cli/onboard-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { isOnboardingDone, questionsFor } from "../src/onboarding.js";

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
