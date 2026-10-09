/**
 * The model-recommendation notice for existing users (model-recommendation.ts):
 * when there is something to say, the one note of the answer, the texts, and
 * the four places that speak — `bastra models`, the question `bastra update`
 * ends with, the CLI hint and the SessionStart block.
 *
 * The shipped state is "no recommendation", so every case that needs one
 * injects REC. No Ollama here: the switch itself is injected (its own file,
 * model-switch-safe.test.ts, covers it against a fake server).
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/model-recommendation.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_RECOMMENDATION, recommendTextModel, type ModelRecommendation } from "../src/cli/hardware.js";
import { cmdModels, type ModelsDeps } from "../src/cli/models-cmd.js";
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
import { readSettings, setEmbeddingProvider, setGenerationModel, setUpdateMode } from "../src/settings.js";

const REC: ModelRecommendation = {
  id: "test-rec-1",
  improves: "Sharper search keywords and a stricter draft check.",
  models: {
    baseline: { model: "new:4b", sizeGB: 3.3 },
    enhanced: { model: "new:4b", sizeGB: 3.3 },
    high: { model: "new:12b", sizeGB: 8.1 },
  },
};
const NOW = Date.parse("2026-10-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

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
    const ask = await captured(() => cmdModels({ sub: "ask", settingsPath: path, deps: { interactive: true, ask: async () => "s" } }));
    assert.equal(ask.out, "", "`bastra update` ends without a question");
  });
});

// ── when there is something to say ───────────────────────────────────────────

test("offer: the recommended model of this machine's tier, against the model in effect", async () => {
  await existingUser(async (path) => {
    assert.deepEqual(await pendingModelNotice(opts(path)), {
      id: "test-rec-1",
      model: "new:4b",
      sizeGB: 3.3,
      improves: REC.improves,
      current: "gemma3:4b",
      envOverride: null,
    });
    assert.equal((await pendingModelNotice(opts(path, { ramGB: 32 })))?.model, "new:12b");
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

test("no notice where the text model never runs (Ollama is not the embedding provider)", async () => {
  await existingUser(async (path) => {
    await setEmbeddingProvider("none", path);
    assert.equal(await pendingModelNotice(opts(path)), null);
    assert.equal((await currentModelOffer(opts(path)))?.model, "new:4b", "`bastra models` still shows it");
  });
});

// ── the one note of the answer ───────────────────────────────────────────────

test("later: silent for 7 days, then asked again", async () => {
  await existingUser(async (path) => {
    await recordModelAnswer(REC.id, "later", path, NOW);
    assert.equal(REMIND_AFTER_MS, 7 * DAY);
    assert.equal(await pendingModelNotice(opts(path, { now: NOW + 7 * DAY - 1 })), null);
    assert.equal((await pendingModelNotice(opts(path, { now: NOW + 7 * DAY })))?.model, "new:4b");
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
    await setGenerationModel("new:4b", path);
    await recordModelAnswer(REC.id, "switched", path, NOW);
    assert.equal(await pendingModelNotice(opts(path, { now: NOW + 30 * DAY })), null);
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

const OFFER: ModelOffer = { id: REC.id, model: "new:4b", sizeGB: 3.3, improves: REC.improves, current: "gemma3:4b", envOverride: null };

test("SessionStart block: facts, ask first, the three commands — and no order to switch", () => {
  assert.equal(
    formatModelSessionBlock(OFFER),
    `\n<bastra-model-recommendation>\n` +
      `bastra-recall recommends a different local text model for this machine: new:4b (you run gemma3:4b).\n` +
      `What gets better: Sharper search keywords and a stricter draft check.\n` +
      `Download: about 3.3 GB. Comparison: ${MODEL_COMPARISON_URL}\n` +
      `Tell the user about this recommendation, including the download size, and ASK whether they want to switch. ` +
      `Never switch on your own: run none of the commands below before the user has answered explicitly.\n` +
      `- The user says yes → run \`bastra models switch\`. It downloads new:4b, checks it with a short test call ` +
      `and only then changes the setting; if anything fails, nothing changes. The old model stays installed ` +
      `(switch back: \`bastra models set gemma3:4b\`).\n` +
      `- The user says later → run \`bastra models later\` (asks again in 7 days).\n` +
      `- The user says no / stop asking → FIRST tell them what that means: this notice will not come back for this recommendation, and you may be giving up better recall quality; 'bastra models' keeps showing the recommendation and 'bastra models switch' works any time. ` +
      `Only when they confirm after hearing that, run \`bastra models dismiss\` (a future, new recommendation asks again).\n` +
      `</bastra-model-recommendation>`,
  );
  // The warning comes before the command it guards, in the same instruction.
  const block = formatModelSessionBlock(OFFER);
  assert.ok(block.indexOf(DISMISS_WARNING) < block.indexOf("bastra models dismiss"));
  assert.match(MODEL_COMPARISON_URL, /docs\/local-model-comparison\.md$/);
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
  assert.equal(DISMISS_WARNING, "this notice will not come back for this recommendation, and you may be giving up better recall quality");
  assert.equal(DISMISS_STILL_OPEN, "'bastra models' keeps showing the recommendation and 'bastra models switch' works any time");
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
    assert.equal(
      first.err,
      `\n\x1b[2mℹ bastra-recall recommends a different local text model for this machine: new:4b (you run gemma3:4b).\n` +
        `  What gets better: Sharper search keywords and a stricter draft check.\n` +
        `  Download: about 3.3 GB. Comparison: ${MODEL_COMPARISON_URL}\n` +
        `  Decide with:\n` +
        `    bastra models switch    switch now\n` +
        `    bastra models later     keep the current model, ask again in 7 days\n` +
        `    bastra models dismiss   stop asking — this notice will not come back for this recommendation, and you may be giving up better recall quality; 'bastra models' keeps showing the recommendation and 'bastra models switch' works any time\x1b[0m\n`,
    );
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

/** The switch, injected: records what it was asked and answers as told. */
function fakeEnable(result: { activated: boolean; message: string }) {
  const calls: unknown[][] = [];
  const enable = (async (...args: unknown[]) => {
    calls.push(args);
    return { status: result.activated ? "activated" : "error", ...result };
  }) as unknown as NonNullable<ModelsDeps["enable"]>;
  return { calls, enable };
}

test("bastra models: shows the recommendation at any time, also after `dismiss`", async () => {
  await existingUser(async (path) => {
    await recordModelAnswer(REC.id, "dismissed", path, NOW);
    const { out, result } = await captured(() => cmdModels({ sub: null, settingsPath: path, deps: opts(path) }));
    assert.equal(result, 0);
    assert.match(out, /^generation model: gemma3:4b \(default\)\n/);
    assert.match(out, /recommended: new:4b {2}\[baseline\]/);
    assert.ok(out.endsWith(`\n\n${formatModelNotice(OFFER)}\n`));
  });
});

test("bastra models later / dismiss: recorded, model untouched, usable without a terminal", async () => {
  await existingUser(async (path) => {
    const later = await captured(() => cmdModels({ sub: "later", settingsPath: path, deps: opts(path) }));
    assert.equal(later.result, 0);
    assert.equal(later.out, "OK — the generation model stays gemma3:4b. You will be asked again in 7 days; 'bastra models switch' works any time.\n");
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "later");

    const dismiss = await captured(() => cmdModels({ sub: "dismiss", settingsPath: path, deps: opts(path) }));
    assert.equal(
      dismiss.out,
      "OK — the generation model stays gemma3:4b. From now on this notice will not come back for this recommendation, and you may be giving up better recall quality.\n" +
        "Still open to you: 'bastra models' keeps showing the recommendation and 'bastra models switch' works any time.\n",
    );
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "dismissed");
    assert.equal((await readSettings(path)).generation, undefined);
  });
});

test("bastra models switch: the verified switch, the answer recorded, the way back named", async () => {
  await existingUser(async (path) => {
    await setGenerationModel("my-own:7b", path);
    const sw = fakeEnable({ activated: true, message: "text model new:4b ready + saved — restart the daemon to apply" });
    const { out, result } = await captured(() => cmdModels({ sub: "switch", settingsPath: path, deps: opts(path, { enable: sw.enable }) }));
    assert.equal(result, 0);
    assert.deepEqual(sw.calls, [["new:4b", { dryRun: false, verify: true }, path]]);
    assert.equal(
      out,
      "Switching the generation model to new:4b (about 3.3 GB download if it is not present yet) …\n" +
        "✓ text model new:4b ready + saved — restart the daemon to apply\n" +
        "The previous model my-own:7b is still installed. Switch back any time: bastra models set my-own:7b\n",
    );
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "switched");
  });
});

test("bastra models switch: a failed switch says why, changes nothing and leaves the question open", async () => {
  await existingUser(async (path) => {
    const sw = fakeEnable({ activated: false, message: "new:4b is downloaded but did not answer a test call (Ollama chat HTTP 500)" });
    const { out, result } = await captured(() => cmdModels({ sub: "switch", settingsPath: path, deps: opts(path, { enable: sw.enable }) }));
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
    const { out } = await captured(() => cmdModels({ sub: "switch", settingsPath: path, deps: opts(path, { enable: sw.enable }) }));
    assert.match(out, /previous model gemma3:4b is still installed/, "the way back names the stored model, not the pinned one");
    assert.ok(out.endsWith("Note: BASTRA_EXPAND_MODEL=pinned:9b is set in the environment and overrides the saved choice: the switch only takes effect once that variable is removed and the daemon restarted.\n"));
  });
});

test("bastra models switch / later / dismiss: nothing open → says so, records nothing", async () => {
  await existingUser(async (path) => {
    await setGenerationModel("new:4b", path);
    for (const sub of ["switch", "later", "dismiss"]) {
      const { out, result } = await captured(() => cmdModels({ sub, settingsPath: path, deps: opts(path) }));
      assert.equal(result, 0);
      assert.equal(out, "Nothing to decide: there is no model recommendation open for this machine.\n");
    }
    assert.equal((await readSettings(path)).modelRecommendation, undefined);
  });
});

// ── the question `bastra update` ends with (`bastra models ask`) ─────────────

const QUESTION = "[s] switch now   [l] later (ask again in 7 days)   [n] never ask again for this recommendation — your choice [s/l/n]: ";

test("bastra update, on a terminal: asks once, and each answer does what it says", async () => {
  await existingUser(async (path) => {
    const asked: string[] = [];
    const reply = (text: string | null) => async (q: string) => { asked.push(q); return text; };
    const sw = fakeEnable({ activated: true, message: "saved" });
    const run = (text: string | null) =>
      captured(() => cmdModels({ sub: "ask", settingsPath: path, deps: opts(path, { interactive: true, ask: reply(text), enable: sw.enable }) }));

    // No answer (Ctrl-C / EOF) is not a choice: nothing recorded, asked again.
    const none = await run(null);
    assert.ok(none.out.startsWith("\nbastra-recall recommends a different local text model for this machine: new:4b (you run gemma3:4b).\n"));
    assert.deepEqual(asked, [QUESTION]);
    assert.ok(
      none.out.endsWith("\nAbout [n]: this notice will not come back for this recommendation, and you may be giving up better recall quality; 'bastra models' keeps showing the recommendation and 'bastra models switch' works any time.\n"),
      "the cost of [n] is on screen before the question is asked",
    );
    assert.equal((await readSettings(path)).modelRecommendation, undefined);

    // Enter / anything unclear is "later" — never a download.
    await run("");
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "later");
    assert.equal(sw.calls.length, 0);

    // Answered: `bastra update` does not ask a second time.
    const again = await run("s");
    assert.equal(again.out, "");
    assert.equal(asked.length, 2);

    await recordModelAnswer(REC.id, "later", path, NOW - 8 * DAY);
    await run("n");
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "dismissed");

    await recordModelAnswer(REC.id, "later", path, NOW - 8 * DAY);
    await run("s");
    assert.equal(sw.calls.length, 1);
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "switched");
  });
});

test("bastra update, without a terminal: only the notice — no question, no answer recorded", async () => {
  await existingUser(async (path) => {
    const { out, result } = await captured(() =>
      cmdModels({
        sub: "ask",
        settingsPath: path,
        deps: opts(path, { interactive: false, ask: async () => { throw new Error("must not prompt"); } }),
      }),
    );
    assert.equal(result, 0);
    assert.equal(out, `\n${formatModelNotice(OFFER)}\n`);
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

// ── the installer ────────────────────────────────────────────────────────────

test("installer: a new install is offered the recommended model for its tier directly", () => {
  // The wizard's first option and initial value are recommendTextModel().model.
  assert.equal(recommendTextModel(16, REC).model, "new:4b");
  assert.equal(recommendTextModel(16, REC).sizeGB, 3.3);
  assert.deepEqual(recommendTextModel(24, REC).alt?.model, "gemma4:12b", "the heavier opt-in stays on offer");
  assert.equal(recommendTextModel(32, REC).model, "new:12b");
  assert.equal(recommendTextModel(64, { ...REC, models: { ...REC.models, high: { model: "gemma4:12b", sizeGB: 8.1 } } }).alt, undefined);
  assert.equal(recommendTextModel(8, REC).model, null);
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

test("SessionStart: an open recommendation reaches the agent as its own block", async () => {
  const context = await sessionStart(async () => OFFER);
  assert.ok(context.includes(formatModelSessionBlock(OFFER).trimStart()));
});

test("SessionStart: with the shipped state (and after an answer) the block is absent", async () => {
  assert.doesNotMatch(await sessionStart(), /bastra-model-recommendation/);
  assert.doesNotMatch(await sessionStart(async () => null), /bastra-model-recommendation/);
});
