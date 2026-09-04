/**
 * #422 — der Evidenzentscheid ist per Default SCHARF, der Env-Schalter bleibt
 * das Sofort-Aus, die Settings-Datei das dauerhafte.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/evidence-gate-default.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_GATE_DEFAULT, getEvidenceGateEnabled } from "../src/settings.js";

async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BASTRA_EVIDENCE_GATE;
  if (value === undefined) delete process.env.BASTRA_EVIDENCE_GATE;
  else process.env.BASTRA_EVIDENCE_GATE = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_EVIDENCE_GATE;
    else process.env.BASTRA_EVIDENCE_GATE = prev;
  }
}

test("#422: without settings and without env the gate is ON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-gate-default-"));
  try {
    assert.equal(EVIDENCE_GATE_DEFAULT, true);
    assert.equal(await withEnv(undefined, () => getEvidenceGateEnabled(join(dir, "missing.json"))), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#422: BASTRA_EVIDENCE_GATE=0 is the instant off-switch and beats the settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-gate-env-"));
  try {
    const p = join(dir, "settings.json");
    await writeFile(p, JSON.stringify({ evidenceGate: { enabled: true } }), "utf8");
    for (const off of ["0", "false", "off", "no"]) {
      assert.equal(await withEnv(off, () => getEvidenceGateEnabled(p)), false, `env ${off}`);
    }
    assert.equal(await withEnv("1", () => getEvidenceGateEnabled(p)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#422: evidenceGate.enabled: false in the settings switches it off durably", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-gate-settings-"));
  try {
    const p = join(dir, "settings.json");
    await writeFile(p, JSON.stringify({ evidenceGate: { enabled: false } }), "utf8");
    assert.equal(await withEnv(undefined, () => getEvidenceGateEnabled(p)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
