import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdModels, maybeAskModelCatchUp } from "../src/cli/models-cmd.js";
import { maybeEmitModelHint } from "../src/cli/update-hint.js";
import { pendingModelNotice } from "../src/model-recommendation.js";
import { runSessionLane } from "../src/session-lane.js";
import { pathLockFilePath } from "../src/path-lock.js";
import { setEmbeddingProvider, setGenerationModel } from "../src/settings.js";

async function fixture(work: (dir: string, settingsPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "model-rec-review-"));
  const path = join(dir, "settings.json");
  const keys = ["BASTRA_EXPAND_MODEL", "BASTRA_RERANK_MODEL", "BASTRA_UPDATE_CHECK"];
  const saved = keys.map(key => process.env[key]);
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  keys.forEach(key => delete process.env[key]);
  try { await setEmbeddingProvider("ollama", path); await work(dir, path); }
  finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    await rm(dir, { recursive: true, force: true });
  }
}

async function captured<T>(work: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = ((value: unknown) => { out += String(value); return true; }) as typeof stdout;
  process.stderr.write = ((value: unknown) => { err += String(value); return true; }) as typeof stderr;
  try { return { result: await work(), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

test("review K1: a fresh foreign day lock is skipped promptly and silently", () => fixture(async (dir, settingsPath) => {
  const shownPath = join(dir, "shown.txt"), lock = pathLockFilePath(shownPath);
  const original = JSON.stringify({ pid: process.pid + 1000, token: "invented-foreign", ts: Date.now() });
  await writeFile(lock, original);
  const start = performance.now();
  const hint = await captured(() => maybeEmitModelHint({ ramGB: 24, settingsPath, shownPath }));
  assert.ok(performance.now() - start < 200, "must not wait for the five-second lease timeout");
  assert.equal(hint.result, false); assert.equal(hint.out + hint.err, "");
  assert.equal(await readFile(lock, "utf8"), original);

  const offer = await pendingModelNotice({ ramGB: 24, settingsPath });
  assert.ok(offer);
  const bodies: Record<string, object> = {
    "/health": { ok: true },
    "/hook/session-context": { budget: {}, aborted: [], data: { recalls: [], floors: [], conventions: [], care: { open: 0, queued: 0 }, imports: { open: 0, queued: 0 }, onboarding: false } },
    "/hook/hinted": {},
  };
  const server = createServer((req, res) => {
    const body = bodies[(req.url ?? "").split("?")[0]];
    req.resume(); req.on("end", () => { res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? {})); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const session = await runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", cwd: dir, session_id: "invented-locked-hint" },
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      undefined,
      () => pendingModelNotice({ ramGB: 24, settingsPath }),
    );
    assert.match(String(JSON.parse(session).hookSpecificOutput?.additionalContext), /<bastra-model-recommendation>/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const update = await captured(() => cmdModels({ sub: "ask", settingsPath, deps: { ramGB: 24, interactive: false } }));
  assert.match(update.out, /recommends a different/);
  let questions = 0;
  const catchUp = await captured(() => maybeAskModelCatchUp({ ramGB: 24, settingsPath, interactive: true, ask: async () => { questions++; return null; } }));
  assert.equal(catchUp.result, true); assert.equal(questions, 1);
}));

test("review K1: an unwritable hint directory emits no lock diagnostic", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => fixture(async (dir, settingsPath) => {
  const blocked = join(dir, "blocked"); await mkdir(blocked); await chmod(blocked, 0o500);
  try {
    const start = performance.now();
    const hint = await captured(() => maybeEmitModelHint({ ramGB: 24, settingsPath, shownPath: join(blocked, "shown.txt") }));
    assert.ok(performance.now() - start < 200);
    assert.equal(hint.result, false); assert.equal(hint.out + hint.err, "");
  } finally { await chmod(blocked, 0o700); }
}));

test("review K2: listed tag variants are accepted in both hardware directions, from settings and env", () => fixture(async (_dir, settingsPath) => {
  for (const [ramGB, tag] of [[24, "gemma4:12b-it-q4_K_M"], [24, "Gemma4:12B"], [32, "TEV1:4B"], [32, "tev1:4b-fixture"]] as const) {
    await setGenerationModel(tag, settingsPath);
    assert.equal(await pendingModelNotice({ ramGB, settingsPath }), null);
    await setGenerationModel("gemma3:4b", settingsPath);
    process.env.BASTRA_RERANK_MODEL = tag;
    try { assert.equal(await pendingModelNotice({ ramGB, settingsPath }), null); }
    finally { delete process.env.BASTRA_RERANK_MODEL; }
  }
}));

test("review K2: unqualified names, latest and other sizes are not treated as listed models", () => fixture(async (_dir, settingsPath) => {
  for (const ramGB of [24, 32]) for (const tag of ["tev1", "tev1:latest", "gemma4:latest", "tev1:8b", "gemma4:4b", "gemma4:120b"]) {
    await setGenerationModel(tag, settingsPath);
    assert.ok(await pendingModelNotice({ ramGB, settingsPath }), `${ramGB}: ${tag} must remain a distinct choice`);
  }
}));


test("review K4: a stale day lock is reclaimed promptly, then the day stays claimed", () => fixture(async (dir, settingsPath) => {
  const shownPath = join(dir, "shown.txt"), lock = pathLockFilePath(shownPath);
  await writeFile(lock, JSON.stringify({ pid: process.pid + 1000, token: "invented-stale", ts: Date.now() - 60_000 }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const start = performance.now();
  const hint = await captured(() => maybeEmitModelHint({ ramGB: 24, settingsPath, shownPath }));
  assert.ok(performance.now() - start < 200, "stale takeover must not wait");
  assert.equal(hint.result, true);
  assert.match(hint.err, /bastra-recall recommends/);
  assert.doesNotMatch(hint.err, /lock .*busy|cannot create lock/);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
  assert.match((await readFile(shownPath, "utf8")).trim(), /^\d{4}-\d{2}-\d{2}$/);
  const again = await captured(() => maybeEmitModelHint({ ramGB: 24, settingsPath, shownPath }));
  assert.equal(again.result, false); assert.equal(again.out + again.err, "");
}));
