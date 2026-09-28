/**
 * #632 battery mode: power-source detection (mocked `pmset`), the opt-in
 * switch, the monitor that defers background model work, the warm-up gate,
 * /health and the doctor row.
 *
 * Runner: `tsx --test __tests__/power-source.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batterySaverEnabled,
  createPowerMonitor,
  parsePmsetBatt,
  readPowerSource,
  type PowerSource,
} from "../src/power-source.js";
import { createEmbeddingWarmup } from "../src/embedding-warmup.js";
import { buildHealthPayload } from "../src/http-health.js";
import { featureLines, type FeatureState } from "../src/cli/features-note.js";
import { getBatterySaver, setBatterySaver } from "../src/settings.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
const BATT = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; 4:10 remaining present: true\n";

test("pmset output: AC, battery, UPS and garbage", () => {
  assert.equal(parsePmsetBatt(AC), "ac");
  assert.equal(parsePmsetBatt(BATT), "battery");
  assert.equal(parsePmsetBatt("Now drawing from 'UPS Power'\n"), "battery");
  assert.equal(parsePmsetBatt(""), "unknown");
  assert.equal(parsePmsetBatt("pmset: command not found"), "unknown");
});

test("readPowerSource: macOS asks pmset, other platforms are neutral, a failing call is unknown", async () => {
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    return BATT;
  };
  assert.equal(await readPowerSource(exec, "darwin"), "battery");
  assert.deepEqual(calls, ["/usr/bin/pmset -g batt"]);
  assert.equal(await readPowerSource(exec, "linux"), "unknown");
  assert.equal(await readPowerSource(exec, "win32"), "unknown");
  assert.equal(calls.length, 1, "no pmset call off macOS");
  assert.equal(await readPowerSource(async () => { throw new Error("ENOENT"); }, "darwin"), "unknown");
});

test("the switch: default off, file value, env wins both ways", () => {
  assert.equal(batterySaverEnabled(undefined, {}), false);
  assert.equal(batterySaverEnabled(true, {}), true);
  assert.equal(batterySaverEnabled(true, { BASTRA_BATTERY_SAVER: "off" }), false);
  assert.equal(batterySaverEnabled(false, { BASTRA_BATTERY_SAVER: "1" }), true);
  assert.equal(batterySaverEnabled(true, { BASTRA_BATTERY_SAVER: "maybe" }), true, "an unreadable env value falls back to the file");
});

function scripted(seq: PowerSource[]): () => Promise<PowerSource> {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)]!;
}

test("monitor: saving only with the switch on AND on battery", async () => {
  const on = createPowerMonitor({ enabled: true, read: scripted(["battery", "ac", "unknown"]) });
  assert.equal(on.saving(), false, "nothing is deferred before the first reading");
  await on.poll();
  assert.equal(on.saving(), true);
  assert.deepEqual(on.snapshot(), { battery_saver: true, source: "battery", saving: true });
  await on.poll();
  assert.equal(on.saving(), false);
  await on.poll();
  assert.equal(on.saving(), false, "unknown behaves like AC");

  let reads = 0;
  const off = createPowerMonitor({ enabled: false, read: async () => { reads++; return "battery"; } });
  await off.poll();
  assert.equal(off.saving(), false);
  assert.equal(reads, 0, "with the switch off, power is never read");
});

test("monitor: deferred work waits for AC and resumes on the plug-in reading", async () => {
  const m = createPowerMonitor({ enabled: true, read: scripted(["battery", "battery", "ac"]) });
  await m.poll();
  let released = false;
  const waiting = m.waitUntilNotSaving().then(() => { released = true; });
  await m.poll();
  await Promise.resolve();
  assert.equal(released, false, "still on battery");
  await m.poll();
  await waiting;
  assert.equal(released, true);
  // Not saving → no wait at all.
  await m.waitUntilNotSaving();
});

function warmup(deferred: () => boolean) {
  let warms = 0;
  const w = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    providerAvailable: () => true,
    lastOkAt: () => null,
    deferred,
    warm: async () => { warms++; },
  });
  return { w, warms: () => warms };
}

test("warm-ups are skipped for every trigger while saving, and fire again on AC", async () => {
  let saving = true;
  const { w, warms } = warmup(() => saving);
  for (const trigger of ["boot", "turn", "session"] as const) {
    assert.equal(w.ensureWarm(trigger), "skipped-battery", trigger);
  }
  assert.equal(w.onSessionContact(), "unknown");
  assert.equal(warms(), 0);
  saving = false;
  assert.equal(w.ensureWarm("session"), "fired");
  await w.warming();
  assert.equal(warms(), 1);
});

test("/health carries the power block when the daemon wires it", () => {
  const base = {
    vaultSize: () => 1,
    version: "t",
    embedding: { on: false, providerId: null, source: "none" } as never,
    updateState: () => null,
  };
  assert.equal("power" in buildHealthPayload(base), false);
  const p = buildHealthPayload({ ...base, power: () => ({ battery_saver: true, source: "battery", saving: true }) });
  assert.deepEqual(p.power, { battery_saver: true, source: "battery", saving: true });
});

test("doctor: off names the command, on battery says what is deferred", () => {
  const state = {
    clients: [],
    primaryLanguage: "de",
    onboardingDone: true,
    semanticRecall: { state: "on", detail: "ollama" },
    paraphrasing: { state: "n/a" },
    reflex: { enabled: true },
    codeAwareness: { repos: 0, offByEnv: false },
    promptImpact: false,
    docsMode: "off",
    commons: false,
    bridges: false,
    ui: false,
    archive: "off",
    battery: { saver: false },
  } as FeatureState;
  const row = (s: FeatureState) => featureLines(s).find((l) => l.includes("battery saver"))!;
  assert.match(row(state), /· battery saver \(macOS\): off → bastra config set battery\.saver on/);
  state.battery = { saver: true, live: { source: "battery", saving: true } };
  assert.match(row(state), /✓ .*on battery now: paraphrasing waits for AC, no warm-ups/);
  state.battery = { saver: true, live: { source: "ac", saving: false } };
  assert.match(row(state), /✓ .*on \(power source: ac\)/);
});

test("battery.saver round-trips through the settings file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-battery-settings-"));
  try {
    const file = join(dir, "cli-settings.json");
    assert.equal(await getBatterySaver(file), undefined);
    await setBatterySaver(true, file);
    assert.equal(await getBatterySaver(file), true);
    await setBatterySaver(false, file);
    assert.equal(await getBatterySaver(file), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
