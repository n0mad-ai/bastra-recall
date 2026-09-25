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

test("#443: an unrecognised env value is ignored with a warning — the settings value stands", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-gate-typo-"));
  const errors = t.mock.method(console, "error", () => {});
  try {
    const off = join(dir, "off.json");
    const on = join(dir, "on.json");
    await writeFile(off, JSON.stringify({ evidenceGate: { enabled: false } }), "utf8");
    await writeFile(on, JSON.stringify({ evidenceGate: { enabled: true } }), "utf8");
    // Ein Tippfehler schaltet ein ausgeschaltetes Gate nicht mehr ein …
    for (const typo of ["flase", "disabled", "ture"]) {
      assert.equal(await withEnv(typo, () => getEvidenceGateEnabled(off)), false, `env ${typo}`);
    }
    // … und ist auch kein Aus.
    assert.equal(await withEnv("flase", () => getEvidenceGateEnabled(on)), true);
    assert.equal(errors.mock.callCount(), 4);
    assert.match(String(errors.mock.calls[0].arguments[0]), /BASTRA_EVIDENCE_GATE="flase".*ignored/);
    // Whitespace und Großschreibung um eine erkannte Schreibweise zählen.
    assert.equal(await withEnv(" OFF ", () => getEvidenceGateEnabled(on)), false);
    assert.equal(await withEnv("Yes\n", () => getEvidenceGateEnabled(off)), true);
    assert.equal(errors.mock.callCount(), 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
