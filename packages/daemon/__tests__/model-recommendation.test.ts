/**
 * The model-recommendation notice for existing users (model-recommendation.ts):
 * when there is something to say, the one note of the answer, the texts, and
 * the places that speak — `bastra models`, the question `bastra update` ends
 * with, the catch-up question after a command, the CLI hint and the
 * SessionStart block.
 *
 * The shipped state is "no recommendation", so every case that needs one
 * injects REC. No Ollama here: the switch itself is injected (its own files,
 * model-switch-safe.test.ts and model-decision-binding.test.ts, cover it
 * against a fake server).
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/model-recommendation.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { MODEL_RECOMMENDATION, recommendTextModel, type ModelRecommendation } from "../src/cli/hardware.js";
import { cmdModels, maybeAskModelCatchUp, modelNoticeAfterCommand, type ModelsDeps } from "../src/cli/models-cmd.js";
import { askOn } from "../src/cli/prompt.js";
import { askModelRecommendation } from "../src/cli/update.js";
import { maybeEmitModelHint } from "../src/cli/update-hint.js";
import {
  DISMISS_STILL_OPEN,
  DISMISS_WARNING,
  MODEL_COMPARISON_URL,
  REMIND_AFTER_MS,
  currentModelOffer,
  formatModelNotice,
  formatModelSessionBlock,
  pendingModelNotice,
  recordModelAnswer,
  type ModelOffer,
} from "../src/model-recommendation.js";
import { runSessionLane } from "../src/session-lane.js";
import { readSettings, resolveGenerationModel, setEmbeddingProvider, setGenerationModel, setUpdateMode } from "../src/settings.js";

const IMPROVES = "Sharper search keywords and a stricter draft check.";
const REC: ModelRecommendation = {
  id: "test-rec-1",
  models: {
    baseline: { model: "new:4b", sizeGB: 3.3, improves: IMPROVES },
    enhanced: { model: "new:4b", sizeGB: 3.3, improves: IMPROVES },
    high: { model: "new:12b", sizeGB: 8.1, improves: "More accurate, at about three times the answer time." },
  },
};
const NOW = Date.parse("2026-10-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const WARN = "this notice will not come back for this recommendation, and you may be giving up better recall quality";
const OPEN = "'bastra models' keeps showing the recommendation and you can still switch later";

/** A settings file of an existing Ollama user, and the env this feature reads, cleared. */
async function existingUser(fn: (path: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-model-rec-"));
  const path = join(dir, "cli-settings.json");
  const keys = ["BASTRA_UPDATE_CHECK", "BASTRA_EXPAND_MODEL", "BASTRA_RERANK_MODEL", "BASTRA_EMBEDDING_PROVIDER"];
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  try {
    await setEmbeddingProvider("ollama", path);
    await fn(path, dir);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** What a command wrote, per stream. The test-env preload drops stdout strings. */
async function captured(fn: () => Promise<unknown>): Promise<{ out: string; err: string; result: unknown }> {
  const real = { out: process.stdout.write, err: process.stderr.write };
  let out = "";
  let err = "";
  process.stdout.write = ((c: unknown) => { if (typeof c === "string") { out += c; return true; } return real.out.call(process.stdout, c as Uint8Array); }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { err += String(c); return true; }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { out, err, result };
  } finally {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
  }
}

const opts = (path: string, extra: Partial<ModelsDeps> = {}) => ({ recommendation: REC, ramGB: 16, settingsPath: path, now: NOW, ...extra });
const answerOf = async (path: string) => (await readSettings(path)).modelRecommendation?.answer;

// ── the shipped state ────────────────────────────────────────────────────────

test("shipped: no recommendation is active — nothing is offered and nothing is said", async () => {
  assert.equal(MODEL_RECOMMENDATION, null);
  await existingUser(async (path, dir) => {
    assert.equal(await currentModelOffer({ ramGB: 16, settingsPath: path }), null);
    assert.equal(await pendingModelNotice({ ramGB: 32, settingsPath: path }), null);
    const hint = await captured(() => maybeEmitModelHint({ ramGB: 16, settingsPath: path, shownPath: join(dir, "shown.txt") }));
    assert.equal(hint.result, false);
    assert.equal(hint.err, "");
    const status = await captured(() => cmdModels({ sub: "status", settingsPath: path }));
    assert.doesNotMatch(status.out, /recommends a different/);
    const neverAsk = async () => { throw new Error("must not ask"); };
    const ask = await captured(() => cmdModels({ sub: "ask", settingsPath: path, deps: { interactive: true, ask: neverAsk } }));
    assert.equal(ask.out, "", "`bastra update` ends without a question");
    const after = await captured(() =>
      modelNoticeAfterCommand({ command: "status", json: false, showHelp: false, showVersion: false }, { settingsPath: path, interactive: true, ask: neverAsk, shownPath: join(dir, "shown.txt") }),
    );
    assert.equal(after.result, "none", "no catch-up question after a command either");
    assert.equal(after.out + after.err, "");
  });
});

test("shipped: tev1:4b is what new installs are offered — an existing install keeps running what it has", async () => {
  await existingUser(async (path) => {
    // No stored choice: the daemon still resolves the runtime default, not the
    // new suggestion — so nothing points at a model that was never pulled.
    assert.equal(await resolveGenerationModel(path), "gemma3:4b");
    assert.equal(await pendingModelNotice({ ramGB: 16, settingsPath: path }), null);
    assert.equal(await currentModelOffer({ ramGB: 16, settingsPath: path }), null);
    // `bastra models` is the one place that shows the new suggestion, and it
    // only shows: nothing is written.
    const before = await readFile(path, "utf8");
    const { out } = await captured(() => cmdModels({ sub: "status", settingsPath: path, deps: { ramGB: 16 } }));
    const lines = out.split("\n");
    assert.equal(lines[0], "generation model: gemma3:4b (default)");
    assert.equal(lines[2], "recommended: tev1:4b  [baseline]");
    assert.equal(lines[lines.length - 2], "to switch: bastra models set tev1:4b");
    assert.equal(await readFile(path, "utf8"), before);
    // A stored choice is untouched as well.
    await setGenerationModel("gemma3:4b", path);
    assert.equal(await resolveGenerationModel(path), "gemma3:4b");
  });
});

// ── when there is something to say ───────────────────────────────────────────

test("offer: the recommended model of this machine's tier, against the model in effect", async () => {
  await existingUser(async (path) => {
    assert.deepEqual(await pendingModelNotice(opts(path)), {
      id: "test-rec-1",
      model: "new:4b",
      sizeGB: 3.3,
      improves: IMPROVES,
      current: "gemma3:4b",
      envOverride: null,
    });
    const high = await pendingModelNotice(opts(path, { ramGB: 32 }));
    assert.equal(high?.model, "new:12b");
    assert.equal(high?.improves, "More accurate, at about three times the answer time.", "the sentence belongs to the tier's model");
  });
});

test("no offer below the 16 GB tier — that machine runs no text model", async () => {
  await existingUser(async (path) => {
    assert.equal(await currentModelOffer(opts(path, { ramGB: 8 })), null);
    assert.equal(await pendingModelNotice(opts(path, { ramGB: 8 })), null);
  });
});

test("no offer when the model in effect already is the recommended one", async () => {
  await existingUser(async (path) => {
    await setGenerationModel("new:4b", path);
    assert.equal(await currentModelOffer(opts(path)), null);
    // …for this tier: the same stored model on a 32 GB machine is not its pick.
    assert.equal((await currentModelOffer(opts(path, { ramGB: 32 })))?.model, "new:12b");
  });
});

test("a deliberately chosen model gets the same notice as the default", async () => {
  await existingUser(async (path) => {
    await setGenerationModel("my-own:7b", path);
    const offer = await pendingModelNotice(opts(path));
    assert.equal(offer?.model, "new:4b");
    assert.equal(offer?.current, "my-own:7b");
  });
});

test("a model pinned by env gets the notice too, and it names the variable that wins", async () => {
  await existingUser(async (path) => {
    process.env.BASTRA_RERANK_MODEL = "pinned:9b";
    const offer = await pendingModelNotice(opts(path));
    assert.equal(offer?.current, "pinned:9b");
    assert.equal(offer?.envOverride, "BASTRA_RERANK_MODEL");
    process.env.BASTRA_EXPAND_MODEL = "expand:9b";
    assert.equal((await pendingModelNotice(opts(path)))?.envOverride, "BASTRA_EXPAND_MODEL");
    // Pinned to the recommended model: it is in effect, so there is nothing to say.
    process.env.BASTRA_EXPAND_MODEL = "new:4b";
    assert.equal(await pendingModelNotice(opts(path)), null);
  });
});

test("opt-out: BASTRA_UPDATE_CHECK=off and update.mode off silence the notice, not `bastra models`", async () => {
  await existingUser(async (path) => {
    process.env.BASTRA_UPDATE_CHECK = "off";
    assert.equal(await pendingModelNotice(opts(path)), null);
    assert.equal((await currentModelOffer(opts(path)))?.model, "new:4b");
    delete process.env.BASTRA_UPDATE_CHECK;
    await setUpdateMode("off", path);
    assert.equal(await pendingModelNotice(opts(path)), null);
    await setUpdateMode("auto", path);
    assert.equal((await pendingModelNotice(opts(path)))?.model, "new:4b", "auto mode is told, never switched");
    assert.equal((await readSettings(path)).generation, undefined);
  });
});

test("the notice goes to installs that use a text model: Ollama embeddings, or a model the user set up", async () => {
  await existingUser(async (path) => {
    // Neither: nothing in the daemon runs the text model, and nobody chose one.
    await setEmbeddingProvider("none", path);
    assert.equal(await pendingModelNotice(opts(path)), null);
    assert.equal((await currentModelOffer(opts(path)))?.model, "new:4b", "`bastra models` still shows it");
    // A stored text model without Ollama embeddings: `bastra bridges harvest`
    // reranks with it whatever the embedding provider is.
    await setGenerationModel("my-own:7b", path);
    assert.equal((await pendingModelNotice(opts(path)))?.current, "my-own:7b");
  });
  await existingUser(async (path) => {
    await setEmbeddingProvider("none", path);
    process.env.BASTRA_RERANK_MODEL = "pinned:9b";
    assert.equal((await pendingModelNotice(opts(path)))?.envOverride, "BASTRA_RERANK_MODEL");
  });
});

// ── the one note of the answer ───────────────────────────────────────────────

test("later: silent for 7 days, then asked again", async () => {
  await existingUser(async (path) => {
    await recordModelAnswer(REC.id, "later", path, NOW);
    assert.equal(REMIND_AFTER_MS, 7 * DAY);
    assert.equal(await pendingModelNotice(opts(path, { now: NOW + 7 * DAY - 1 })), null);
    assert.equal((await pendingModelNotice(opts(path, { now: NOW + 7 * DAY })))?.model, "new:4b");
    // A note from the future (clock set back) or with an unreadable time does
    // not silence the reminder for good.
    assert.equal((await pendingModelNotice(opts(path, { now: NOW - DAY })))?.model, "new:4b");
    await writeFile(path, JSON.stringify({ embedding: { provider: "ollama" }, modelRecommendation: { id: REC.id, answer: "later", at: "bad-time" } }));
    assert.equal((await pendingModelNotice(opts(path)))?.model, "new:4b");
  });
});

test("dismissed: never again for this id — a new id asks again", async () => {
  await existingUser(async (path) => {
    await recordModelAnswer(REC.id, "dismissed", path, NOW);
    assert.equal(await pendingModelNotice(opts(path, { now: NOW + 400 * DAY })), null);
    assert.equal((await currentModelOffer(opts(path)))?.model, "new:4b", "dismissing does not hide it from `bastra models`");
    const next = { ...REC, id: "test-rec-2" };
    assert.equal((await pendingModelNotice(opts(path, { recommendation: next })))?.id, "test-rec-2");
  });
});

test("switched: not asked again even while an env variable keeps the old model in effect", async () => {
  await existingUser(async (path) => {
    process.env.BASTRA_EXPAND_MODEL = "pinned:9b";
    await recordModelAnswer(REC.id, "switched", path, NOW, "new:4b");
    assert.equal((await readSettings(path)).generation?.model, "new:4b", "model and answer arrive in one write");
    assert.equal(await pendingModelNotice(opts(path, { now: NOW + 30 * DAY })), null);
  });
});

test("asked is not an answer: every other place keeps asking", async () => {
  await existingUser(async (path) => {
    await recordModelAnswer(REC.id, "asked", path, NOW);
    assert.equal((await pendingModelNotice(opts(path)))?.model, "new:4b");
  });
});

test("the note lives in cli-settings.json and survives other settings writes", async () => {
  await existingUser(async (path) => {
    await recordModelAnswer(REC.id, "later", path, NOW);
    await setGenerationModel("my-own:7b", path);
    assert.deepEqual((await readSettings(path)).modelRecommendation, { id: REC.id, answer: "later", at: "2026-10-09T12:00:00.000Z" });
    assert.match(await readFile(path, "utf8"), /"modelRecommendation"/);
    // An answer this build does not know is no answer: the user is asked.
    await writeFile(path, JSON.stringify({ embedding: { provider: "ollama" }, modelRecommendation: { id: REC.id, answer: "maybe", at: "x" } }));
    assert.equal((await readSettings(path)).modelRecommendation, undefined);
    assert.equal((await pendingModelNotice(opts(path)))?.model, "new:4b");
  });
});

// ── the texts ────────────────────────────────────────────────────────────────

const OFFER: ModelOffer = { id: REC.id, model: "new:4b", sizeGB: 3.3, improves: IMPROVES, current: "gemma3:4b", envOverride: null };
const NOTICE =
  `bastra-recall recommends a different local text model for this machine: new:4b (you run gemma3:4b).\n` +
  `What gets better: Sharper search keywords and a stricter draft check.\n` +
  `Download: about 3.3 GB. Comparison: ${MODEL_COMPARISON_URL}\n` +
  `Decide with:\n` +
  `  bastra models switch test-rec-1 new:4b   switch now\n` +
  `  bastra models later test-rec-1   keep the current model, ask again in 7 days\n` +
  `  bastra models dismiss test-rec-1   stop asking — ${WARN}; ${OPEN}`;

test("SessionStart block: facts, ask first, the three bound commands — and no order to switch", () => {
  const block = formatModelSessionBlock(OFFER);
  assert.equal(
    block,
    `\n<bastra-model-recommendation>\n` +
      `bastra-recall recommends a different local text model for this machine: new:4b (you run gemma3:4b).\n` +
      `What gets better: Sharper search keywords and a stricter draft check.\n` +
      `Download: about 3.3 GB. Comparison: ${MODEL_COMPARISON_URL}\n` +
      `Tell the user about this recommendation, including the download size, and ASK whether they want to switch. ` +
      `Never switch on your own: run none of the commands below before the user has answered explicitly, ` +
      `and run them exactly as written — they name this recommendation, and bastra refuses them if it has changed.\n` +
      `- The user says yes → run \`bastra models switch test-rec-1 new:4b\`. It downloads new:4b, checks it with a short test call ` +
      `and only then changes the setting; if anything fails, nothing changes. The old model stays installed ` +
      `(switch back: \`bastra models set gemma3:4b\`).\n` +
      `- The user says later → run \`bastra models later test-rec-1\` (asks again in 7 days).\n` +
      `- The user says no / stop asking → FIRST tell them what that means: ${WARN}; ${OPEN}. ` +
      `Only when they confirm after hearing that, run \`bastra models dismiss test-rec-1\` (a future, new recommendation asks again).\n` +
      `</bastra-model-recommendation>`,
  );
  // The warning comes before the command it guards, in the same instruction.
  assert.ok(block.indexOf(DISMISS_WARNING) < block.indexOf("bastra models dismiss"));
  assert.match(MODEL_COMPARISON_URL, /docs\/local-model-comparison\.md$/);
});

test("the terminal notice: facts and the three bound commands, one per line", () => {
  assert.equal(formatModelNotice(OFFER), NOTICE);
});

test("with an env pin, both texts say that the variable wins and what to do about it", () => {
  const pinned: ModelOffer = { ...OFFER, current: "pinned:9b", envOverride: "BASTRA_EXPAND_MODEL" };
  const note =
    "BASTRA_EXPAND_MODEL=pinned:9b is set in the environment and overrides the saved choice: " +
    "the switch only takes effect once that variable is removed and the daemon restarted.";
  assert.ok(formatModelSessionBlock(pinned).includes(`Also tell the user: ${note}\n</bastra-model-recommendation>`));
  assert.ok(formatModelNotice(pinned).includes(`\nNote: ${note}\n`));
});

test("wherever `dismiss` is offered, the warning and what stays possible stand next to it", () => {
  assert.equal(DISMISS_WARNING, WARN);
  assert.equal(DISMISS_STILL_OPEN, OPEN);
  // `bastra models`, the CLI hint and `bastra update` without a terminal all print this text.
  for (const text of [formatModelNotice(OFFER), formatModelSessionBlock(OFFER)]) {
    assert.ok(text.includes(DISMISS_WARNING));
    assert.ok(text.includes(DISMISS_STILL_OPEN));
  }
});

// ── the CLI hint ─────────────────────────────────────────────────────────────

test("CLI hint: one dim notice on stderr, at most once per day", async () => {
  await existingUser(async (path, dir) => {
    const hintOpts = { ...opts(path), shownPath: join(dir, "model-hint-shown.txt") };
    const first = await captured(() => maybeEmitModelHint(hintOpts));
    assert.equal(first.result, true);
    assert.equal(first.out, "", "stdout stays clean for pipes");
    assert.equal(first.err, `\n\x1b[2mℹ ${NOTICE.split("\n").join("\n  ")}\x1b[0m\n`);
    const second = await captured(() => maybeEmitModelHint(hintOpts));
    assert.equal(second.result, false);
    assert.equal(second.err, "");
  });
});

test("CLI hint: silent when opted out or already answered — and that spends no day marker", async () => {
  await existingUser(async (path, dir) => {
    const hintOpts = { ...opts(path), shownPath: join(dir, "model-hint-shown.txt") };
    process.env.BASTRA_UPDATE_CHECK = "off";
    assert.equal((await captured(() => maybeEmitModelHint(hintOpts))).result, false);
    delete process.env.BASTRA_UPDATE_CHECK;
    await recordModelAnswer(REC.id, "dismissed", path, NOW);
    assert.equal((await captured(() => maybeEmitModelHint(hintOpts))).result, false);
    await recordModelAnswer(REC.id, "later", path, NOW - 8 * DAY);
    assert.equal((await captured(() => maybeEmitModelHint(hintOpts))).result, true, "the reminder is due and was not throttled away");
  });
});

// ── bastra models ────────────────────────────────────────────────────────────

/** The switch, injected: records what it was asked and, like the real one,
 *  stores model and answer together when it succeeds. */
function fakeEnable(result: { activated: boolean; message: string }) {
  const calls: unknown[][] = [];
  const enable = (async (model: string, o: { recommendationId?: string }, path: string) => {
    calls.push([model, o, path]);
    if (result.activated && o.recommendationId) await recordModelAnswer(o.recommendationId, "switched", path, NOW, model);
    return { status: result.activated ? "activated" : "error", ...result };
  }) as unknown as NonNullable<ModelsDeps["enable"]>;
  return { calls, enable };
}

const run = (path: string, argv: string[], extra: Partial<ModelsDeps> = {}) =>
  captured(() => cmdModels({ sub: argv[0], positional: ["models", ...argv], settingsPath: path, deps: opts(path, extra) }));

test("bastra models: shows the recommendation at any time, also after `dismiss`", async () => {
  await existingUser(async (path) => {
    await recordModelAnswer(REC.id, "dismissed", path, NOW);
    const { out, result } = await captured(() => cmdModels({ sub: null, settingsPath: path, deps: opts(path) }));
    assert.equal(result, 0);
    assert.match(out, /^generation model: gemma3:4b \(default\)\n/);
    assert.match(out, /recommended: new:4b {2}\[baseline\]/);
    assert.ok(out.endsWith(`\n\n${NOTICE}\n`));
  });
});

test("bastra models later / dismiss: recorded, model untouched, usable without a terminal", async () => {
  await existingUser(async (path) => {
    const later = await run(path, ["later", "test-rec-1"]);
    assert.equal(later.result, 0);
    assert.equal(later.out, "OK — the generation model stays gemma3:4b. You will be asked again in 7 days; until then 'bastra models' shows the recommendation.\n");
    assert.equal(await answerOf(path), "later");

    const dismiss = await run(path, ["dismiss", "test-rec-1"]);
    assert.equal(dismiss.out, `OK — the generation model stays gemma3:4b. From now on ${WARN}.\nStill open to you: ${OPEN}.\n`);
    assert.equal(await answerOf(path), "dismissed");
    assert.equal((await readSettings(path)).generation, undefined);
  });
});

test("bastra models switch: the verified switch, the answer recorded with it, the way back named", async () => {
  await existingUser(async (path) => {
    await setGenerationModel("my-own:7b", path);
    const sw = fakeEnable({ activated: true, message: "text model new:4b ready + saved — restart the daemon to apply" });
    const { out, result } = await run(path, ["switch", "test-rec-1", "new:4b"], { enable: sw.enable });
    assert.equal(result, 0);
    assert.deepEqual(sw.calls, [["new:4b", { dryRun: false, verify: true, recommendationId: "test-rec-1" }, path]]);
    assert.equal(
      out,
      "Switching the generation model to new:4b (about 3.3 GB download if it is not present yet) …\n" +
        "✓ text model new:4b ready + saved — restart the daemon to apply\n" +
        "The previous model my-own:7b is still installed. Switch back any time: bastra models set my-own:7b\n",
    );
    assert.equal(await answerOf(path), "switched");
    assert.equal(await pendingModelNotice(opts(path)), null);
  });
});

test("bastra models switch: a failed switch says why, changes nothing and leaves the question open", async () => {
  await existingUser(async (path) => {
    const sw = fakeEnable({ activated: false, message: "new:4b is downloaded but did not answer a test call (Ollama chat HTTP 500)" });
    const { out, result } = await run(path, ["switch", "test-rec-1", "new:4b"], { enable: sw.enable });
    assert.equal(result, 1);
    assert.ok(out.endsWith(
      "✗ new:4b is downloaded but did not answer a test call (Ollama chat HTTP 500)\n" +
        "Nothing was changed — the generation model stays gemma3:4b.\n",
    ));
    assert.equal((await readSettings(path)).modelRecommendation, undefined);
    assert.equal((await pendingModelNotice(opts(path)))?.model, "new:4b");
  });
});

test("bastra models switch with an env pin: switches the saved choice and says it does not take effect yet", async () => {
  await existingUser(async (path) => {
    process.env.BASTRA_EXPAND_MODEL = "pinned:9b";
    const sw = fakeEnable({ activated: true, message: "saved" });
    const { out } = await run(path, ["switch", "test-rec-1", "new:4b"], { enable: sw.enable });
    assert.match(out, /previous model gemma3:4b is still installed/, "the way back names the stored model, not the pinned one");
    assert.ok(out.endsWith("Note: BASTRA_EXPAND_MODEL=pinned:9b is set in the environment and overrides the saved choice: the switch only takes effect once that variable is removed and the daemon restarted.\n"));
  });
});

test("bastra models switch / later / dismiss: no recommendation for this machine → says so, records nothing", async () => {
  await existingUser(async (path) => {
    for (const sub of ["switch", "later", "dismiss"]) {
      const { out, result } = await run(path, [sub], { ramGB: 8 });
      assert.equal(result, 0);
      assert.equal(out, "Nothing to decide: there is no model recommendation open for this machine.\n");
    }
    assert.equal((await readSettings(path)).modelRecommendation, undefined);
  });
});

// ── the question `bastra update` ends with (`bastra models ask`) ─────────────

const QUESTION = "[s] switch now   [l] later (ask again in 7 days)   [n] never ask again for this recommendation — your choice [s/l/n]: ";

test("bastra update, on a terminal: asks, and each answer does what it says", async () => {
  await existingUser(async (path) => {
    const asked: string[] = [];
    const reply = (text: string | null) => async (q: string) => { asked.push(q); return text; };
    const sw = fakeEnable({ activated: true, message: "saved" });
    const ask = (text: string | null) =>
      captured(() => cmdModels({ sub: "ask", settingsPath: path, deps: opts(path, { interactive: true, ask: reply(text), enable: sw.enable }) }));

    // No answer (Ctrl-C / EOF) is not a choice: only "asked" is noted, and the
    // question stays open everywhere.
    const none = await ask(null);
    assert.ok(none.out.startsWith("\nbastra-recall recommends a different local text model for this machine: new:4b (you run gemma3:4b).\n"));
    assert.deepEqual(asked, [QUESTION]);
    assert.ok(none.out.endsWith(`\nAbout [n]: ${WARN}; ${OPEN}.\n`), "the cost of [n] is on screen before the question is asked");
    assert.equal(none.result, 0);
    assert.equal(await answerOf(path), "asked");
    assert.equal((await pendingModelNotice(opts(path)))?.model, "new:4b");

    // Enter / anything unclear is "later" — never a download.
    await ask("");
    assert.equal(await answerOf(path), "later");
    assert.equal(sw.calls.length, 0);

    // Answered: `bastra update` does not ask a second time.
    const again = await ask("s");
    assert.equal(again.out, "");
    assert.equal(asked.length, 2);

    await recordModelAnswer(REC.id, "later", path, NOW - 8 * DAY);
    await ask("n");
    assert.equal(await answerOf(path), "dismissed");

    await recordModelAnswer(REC.id, "later", path, NOW - 8 * DAY);
    await ask("s");
    assert.deepEqual(sw.calls, [["new:4b", { dryRun: false, verify: true, recommendationId: "test-rec-1" }, path]], "the switch is for the offer that was on screen");
    assert.equal(await answerOf(path), "switched");
  });
});

test("bastra update, without a terminal: only the notice — no question, nothing recorded", async () => {
  await existingUser(async (path) => {
    const { out, result } = await captured(() =>
      cmdModels({
        sub: "ask",
        settingsPath: path,
        deps: opts(path, { interactive: false, ask: async () => { throw new Error("must not prompt"); } }),
      }),
    );
    assert.equal(result, 0);
    assert.equal(out, `\n${NOTICE}\n`);
    assert.equal((await readSettings(path)).modelRecommendation, undefined);
  });
});

test("bastra update: opted out → the closing question is not asked either", async () => {
  await existingUser(async (path) => {
    process.env.BASTRA_UPDATE_CHECK = "off";
    const { out } = await captured(() => cmdModels({ sub: "ask", settingsPath: path, deps: opts(path, { interactive: true, ask: async () => "s" }) }));
    assert.equal(out, "");
  });
});

test("bastra update: the closing question is asked by the installed cli, as `models ask`", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-update-ask-"));
  try {
    // A stand-in for the freshly installed dist/: cli.js next to index.js.
    await writeFile(join(dir, "index.js"), "");
    await writeFile(join(dir, "cli.js"), `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n`);
    await writeFile(join(dir, "package.json"), '{"type":"commonjs"}');
    const r = askModelRecommendation({ node: process.execPath, script: join(dir, "index.js"), version: "9.9.9" }, "pipe");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "argv.json"), "utf8")), ["models", "ask"]);
    assert.equal(r?.status, 7, "the child's exit code is handed back, never thrown — the update's own result stands");
    // No installed runtime, or one without a cli: nothing is started, nothing throws.
    assert.equal(askModelRecommendation(null, "pipe"), null);
    assert.equal(askModelRecommendation({ node: process.execPath, script: join(dir, "missing", "index.js"), version: null }, "pipe"), null);
    // And cmdUpdate ends with it on both of its successful exits.
    const src = await readFile(fileURLToPath(new URL("../src/cli/update.ts", import.meta.url)), "utf8");
    assert.equal(src.split("askModelRecommendation(installed);\n    return 0;").length - 1, 1, "source-checkout exit");
    assert.equal(src.split("askModelRecommendation(installed);\n  return 0;").length - 1, 1, "installer exit");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("bastra update: the real built cli answers `models ask` without a terminal and without waiting", { skip: !existsSync(fileURLToPath(new URL("../dist/cli.js", import.meta.url))) }, () => {
  // What the spawn above starts, for real: the built cli, stdin closed, output
  // piped. With the shipped state it has nothing to say and must return at once.
  const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const r = askModelRecommendation({ node: process.execPath, script: dist, version: null }, "pipe");
  assert.equal(r?.status, 0, String(r?.stderr));
  assert.equal(String(r?.stdout), "");
});

// ── the catch-up question after a command ────────────────────────────────────

const ARGS = { command: "status", json: false, showHelp: false, showVersion: false };

test("catch-up: the first interactive command asks, after the command, exactly once per recommendation", async () => {
  await existingUser(async (path, dir) => {
    const asked: string[] = [];
    const deps = (text: string | null, extra: Partial<ModelsDeps> = {}) =>
      opts(path, { interactive: true, ask: async (q: string) => { asked.push(q); return text; }, shownPath: join(dir, "shown.txt"), ...extra });

    // Ctrl-C / EOF: no answer is recorded, nothing throws, nothing is switched.
    const first = await captured(() => modelNoticeAfterCommand(ARGS, deps(null)));
    assert.equal(first.result, "asked");
    assert.deepEqual(asked, [QUESTION]);
    assert.ok(first.out.includes(`About [n]: ${WARN}; ${OPEN}.`), "the dismiss warning is part of the catch-up question");
    assert.equal(await answerOf(path), "asked");
    assert.equal((await readSettings(path)).generation, undefined);

    // The next command does not ask again; the dim hint takes over (once a day).
    const second = await captured(() => modelNoticeAfterCommand(ARGS, deps("s")));
    assert.equal(second.result, "hinted");
    assert.equal(asked.length, 1);
    assert.match(second.err, /recommends a different local text model/);
    assert.equal((await captured(() => modelNoticeAfterCommand(ARGS, deps("s")))).result, "none");

    // A new recommendation id is a new question.
    const next = await captured(() => modelNoticeAfterCommand(ARGS, deps("", { recommendation: { ...REC, id: "test-rec-2" } })));
    assert.equal(next.result, "asked");
    assert.deepEqual((await readSettings(path)).modelRecommendation?.id, "test-rec-2");
    assert.equal(await answerOf(path), "later", "Enter is later");
  });
});

test("catch-up: each answer does what it says, bound to the offer on screen", async () => {
  for (const [reply, expected] of [["s", "switched"], ["l", "later"], ["", "later"], ["what?", "later"], ["n", "dismissed"]] as const) {
    await existingUser(async (path, dir) => {
      const sw = fakeEnable({ activated: true, message: "saved" });
      const r = await captured(() =>
        modelNoticeAfterCommand(ARGS, opts(path, { interactive: true, ask: async () => reply, enable: sw.enable, shownPath: join(dir, "shown.txt") })),
      );
      assert.equal(r.result, "asked");
      assert.equal(await answerOf(path), expected);
      assert.deepEqual(sw.calls.map((c) => c[0]), expected === "switched" ? ["new:4b"] : []);
      if (expected === "dismissed") assert.ok(r.out.includes(`From now on ${WARN}.`));
    });
  }
});

test("catch-up: a failing switch does not fail the command it follows", async () => {
  await existingUser(async (path, dir) => {
    const sw = fakeEnable({ activated: false, message: "`ollama pull new:4b` failed (exit 1)" });
    const r = await captured(() =>
      modelNoticeAfterCommand(ARGS, opts(path, { interactive: true, ask: async () => "s", enable: sw.enable, shownPath: join(dir, "shown.txt") })),
    );
    assert.equal(r.result, "asked", "an outcome, not an exit code — the command's own code is already set");
    assert.match(r.out, /Nothing was changed — the generation model stays gemma3:4b/);
    assert.equal(await answerOf(path), "asked");
  });
});

test("catch-up: never without a terminal — the dim hint instead", async () => {
  await existingUser(async (path, dir) => {
    const never = async () => { throw new Error("must not ask"); };
    const r = await captured(() => modelNoticeAfterCommand(ARGS, opts(path, { interactive: false, ask: never, shownPath: join(dir, "shown.txt") })));
    assert.equal(r.result, "hinted");
    assert.equal(r.out, "", "nothing on stdout: a pipe gets the command's output only");
    assert.equal((await readSettings(path)).modelRecommendation, undefined);
    assert.equal(await maybeAskModelCatchUp(opts(path, { interactive: false, ask: never })), false);
  });
});

test("catch-up: never after output a script reads, nor after help, version, update, models, completion, uninstall", async () => {
  await existingUser(async (path, dir) => {
    const never = async () => { throw new Error("must not ask"); };
    const deps = () => opts(path, { interactive: true, ask: never, shownPath: join(dir, `shown-${Math.random()}.txt`) });
    // --json and uninstall: no question; the stderr hint is all there is.
    for (const args of [{ ...ARGS, json: true }, { ...ARGS, command: "uninstall" }]) {
      const r = await captured(() => modelNoticeAfterCommand(args, deps()));
      assert.equal(r.result, "hinted");
      assert.equal(r.out, "");
    }
    // Nothing at all, not even the hint.
    const silent = [
      { ...ARGS, showHelp: true },
      { ...ARGS, showVersion: true },
      { ...ARGS, command: null },
      ...["help", "version", "update", "models", "completion", "config", "token"].map((command) => ({ ...ARGS, command })),
    ];
    for (const args of silent) {
      const r = await captured(() => modelNoticeAfterCommand(args, deps()));
      assert.equal(r.result, "none", JSON.stringify(args));
      assert.equal(r.out + r.err, "");
    }
    assert.equal((await readSettings(path)).modelRecommendation, undefined);
  });
});

test("catch-up: not when the updater already asked, and not when the user already answered elsewhere", async () => {
  const never = async () => { throw new Error("must not ask"); };
  // `bastra update` (new updater) asked and got no answer.
  await existingUser(async (path) => {
    await captured(() => cmdModels({ sub: "ask", settingsPath: path, deps: opts(path, { interactive: true, ask: async () => null }) }));
    assert.equal(await maybeAskModelCatchUp(opts(path, { interactive: true, ask: never })), false);
  });
  // Answered in chat or on the CLI — also a "later" that has come due: the hint reminds, the terminal does not ask.
  for (const [answer, at] of [["dismissed", NOW], ["switched", NOW], ["later", NOW], ["later", NOW - 8 * DAY]] as const) {
    await existingUser(async (path) => {
      await recordModelAnswer(REC.id, answer, path, at);
      assert.equal(await maybeAskModelCatchUp(opts(path, { interactive: true, ask: never })), false, `${answer}`);
    });
  }
  // Opted out.
  await existingUser(async (path) => {
    process.env.BASTRA_UPDATE_CHECK = "off";
    assert.equal(await maybeAskModelCatchUp(opts(path, { interactive: true, ask: never })), false);
  });
});

test("the prompt: an answer is trimmed; EOF ends the question with no answer instead of hanging", async () => {
  const answered = new PassThrough();
  const p1 = askOn("? ", answered, new PassThrough());
  answered.write("  s \n");
  assert.equal(await p1, "s");
  const closed = new PassThrough();
  const p2 = askOn("? ", closed, new PassThrough());
  closed.end();
  assert.equal(await p2, null);
});

// ── the installer ────────────────────────────────────────────────────────────

test("installer: a new install is offered the recommended model for its tier directly", () => {
  // The wizard's first option and initial value are recommendTextModel().model.
  assert.equal(recommendTextModel(16, REC).model, "new:4b");
  assert.equal(recommendTextModel(16, REC).sizeGB, 3.3);
  assert.deepEqual(recommendTextModel(24, REC).alt?.model, "gemma4:12b", "the heavier opt-in stays on offer");
  // Without an active recommendation the installer offers the ladder's pick.
  assert.equal(recommendTextModel(16, null).model, "tev1:4b");
  assert.equal(recommendTextModel(32, REC).model, "new:12b");
  assert.equal(recommendTextModel(64, { ...REC, models: { ...REC.models, high: { model: "gemma4:12b", sizeGB: 8.1, improves: "x" } } }).alt, undefined);
  assert.equal(recommendTextModel(8, REC).model, null);
  // A recommendation with nothing for this tier leaves the ladder's pick.
  assert.equal(recommendTextModel(32, { id: "partial", models: { baseline: REC.models.baseline } }).model, "gemma4:12b");
});

// ── SessionStart ─────────────────────────────────────────────────────────────

async function sessionStart(modelNotice?: () => Promise<ModelOffer | null>): Promise<string> {
  const bodies: Record<string, string> = {
    "/hook/session-context": JSON.stringify({
      budget: {},
      aborted: [],
      data: { recalls: [], floors: [], conventions: [], care: { open: 0, queued: 0 }, imports: { open: 0, queued: 0 }, onboarding: false },
    }),
    "/health": JSON.stringify({ ok: true }),
    "/hook/hinted": "{}",
  };
  const server = createServer((req, res) => {
    const body = bodies[(req.url ?? "").split("?")[0]];
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(body ?? "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-model-rec" },
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      undefined,
      modelNotice,
    );
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: unknown } };
    return String(parsed.hookSpecificOutput?.additionalContext ?? "");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("SessionStart: an open recommendation reaches the agent as its own block — at every start, no day throttle", async () => {
  for (let i = 0; i < 2; i++) {
    const context = await sessionStart(async () => OFFER);
    assert.ok(context.includes(formatModelSessionBlock(OFFER).trimStart()));
  }
});

test("SessionStart: with the shipped state (and after an answer) the block is absent", async () => {
  assert.doesNotMatch(await sessionStart(), /bastra-model-recommendation/);
  assert.doesNotMatch(await sessionStart(async () => null), /bastra-model-recommendation/);
});
