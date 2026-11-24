/**
 * #436 (owner decision A, 24.11.2026): the session id of a conversation never
 * lands in the usage log as it was sent. Every writer stores a stable code —
 * an HMAC under a key on this machine — so the same conversation keeps one
 * code and every grouping and join over the log still works, while the code
 * leads back to nothing without the key. The daemon run id stays as it is.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/telemetry-session-code.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Telemetry } from "../src/telemetry.js";
import { telemetrySession } from "../src/telemetry-session.js";
import { callerSessionStore } from "../src/caller-session.js";
import { recordRulebookEvent } from "../src/rulebook-events.js";
import { bastraDataDir } from "../src/platform-paths.js";

const RAW = "6f1c2a9e-0b7d-4c55-9a3e-raw-session";

async function rows(dir: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const name of (await readdir(dir)).filter((n) => n.startsWith("events-")))
    for (const line of (await readFile(join(dir, name), "utf8")).trim().split("\n"))
      out.push(JSON.parse(line) as Record<string, unknown>);
  return out;
}

test("#436: the code is stable, keyed, never the id, and keeps empty values and the replay prefix", async () => {
  const code = telemetrySession(RAW);
  assert.notEqual(code, RAW);
  assert.ok(!code.includes(RAW));
  assert.match(code, /^s1_[0-9a-f]{32}$/);
  assert.equal(telemetrySession(RAW), code, "the same conversation keeps its code");
  assert.notEqual(telemetrySession(`${RAW}x`), code);
  assert.equal(telemetrySession(null), null);
  assert.equal(telemetrySession(undefined), undefined);
  assert.equal(telemetrySession(""), "");
  assert.match(
    telemetrySession(`replay-run-${RAW}`),
    /^replay-s1_[0-9a-f]{32}$/,
    "a replay row still routes to its file"
  );

  // The key lives in the data directory, readable by this account only; with it the code is an HMAC.
  const keyFile = join(bastraDataDir(), "telemetry-session.key");
  const key = Buffer.from((await readFile(keyFile, "utf8")).trim(), "hex");
  assert.equal(key.length, 32);
  if (process.platform !== "win32") assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  assert.equal(code, `s1_${createHmac("sha256", key).update(RAW).digest("hex").slice(0, 32)}`);
});

test("#436: the log carries the code; hook rows and daemon rows of one conversation still join", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telemetry-436-"));
  const previous = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const telemetry = new Telemetry({ logDir: dir });
  if (!telemetry.isEnabled()) return t.skip("telemetry is off in this environment");

  await telemetry.logHookRecall({
    recall_id: "r-hook",
    query: "fixture",
    k: 3,
    hit_count: 0,
    top_score: null,
    hits: [],
    latency_ms: 1,
    session_id: RAW,
  } as unknown as Parameters<Telemetry["logHookRecall"]>[0]);
  await callerSessionStore.run(RAW, () =>
    telemetry.logRecall({
      recall_id: "r-tool",
      query: "fixture",
      k: 3,
      scope: null,
      type: null,
      vault_size: 1,
      hit_count: 0,
      top_score: null,
      hits: [],
      latency_ms: 1,
    } as unknown as Parameters<Telemetry["logRecall"]>[0])
  );
  await telemetry.logLoadMemory({ memory_id: "m1", found: false } as unknown as Parameters<
    Telemetry["logLoadMemory"]
  >[0]);
  await recordRulebookEvent(RAW, { applicable: 0 });

  const text = await rows(dir);
  assert.ok(!JSON.stringify(text).includes(RAW), "the raw id is nowhere in the log");
  const code = telemetrySession(RAW);
  const hook = text.find((r) => r.kind === "hook_recall")!;
  const tool = text.find((r) => r.kind === "recall")!;
  const load = text.find((r) => r.kind === "load_memory")!;
  const rulebook = text.find((r) => r.kind === "rulebook_check")!;
  assert.equal(hook.session_id, code);
  assert.equal(tool.caller_session, code, "joins with the hook row as before");
  assert.equal(rulebook.session_id, code);
  assert.equal(tool.session_id, telemetry.runId(), "the daemon run id stays as it is");
  assert.equal(load.session_id, telemetry.runId());
});
