/**
 * Tests for src/settings.ts — the OSS CLI settings store (update mode).
 *
 * node:test via tsx, no extra deps. All reads/writes go to a temp file via the
 * injectable `path` parameter, so this never touches the real ~/.bastra.
 *
 * Run: npx tsx --test packages/daemon/__tests__/settings.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  DEFAULT_UPDATE_MODE,
  effectiveUpdateMode,
  getUpdateMode,
  readSettings,
  setUpdateMode,
  setEmbeddingProvider,
  getEmbeddingProvider,
  setOllamaAutostart,
  getOllamaAutostart,
  getDocsMode,
  setDocsMode,
  getDocsLanguage,
  setDocsLanguage,
  getSharedRecallEnabled,
  setSharedRecallEnabled,
  getSharedRecallLanguage,
  setSharedRecallLanguage,
  clearSharedRecallLanguage,
  getPrimaryLanguage,
  setPrimaryLanguage,
  getExperimentConfig,
  type CliSettings,
} from "../src/settings.js";

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-settings-"));
  try {
    return await fn(join(dir, "cli-settings.json"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Runs fn with BASTRA_UPDATE_CHECK set to `val` (or deleted if null), then restores. */
async function withEnv(val: string | null, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.BASTRA_UPDATE_CHECK;
  if (val === null) delete process.env.BASTRA_UPDATE_CHECK;
  else process.env.BASTRA_UPDATE_CHECK = val;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_UPDATE_CHECK;
    else process.env.BASTRA_UPDATE_CHECK = prev;
  }
}

test("readSettings: missing file → default mode, never throws", async () => {
  await withTempFile(async (path) => {
    const s = await readSettings(path);
    assert.equal(s.update.mode, DEFAULT_UPDATE_MODE);
    assert.equal(DEFAULT_UPDATE_MODE, "notify");
  });
});

test("setUpdateMode → getUpdateMode round-trips every valid mode", async () => {
  await withTempFile(async (path) => {
    for (const mode of ["auto", "off", "notify"] as const) {
      await setUpdateMode(mode, path);
      assert.equal(await getUpdateMode(path), mode);
    }
  });
});

test("readSettings: corrupt JSON → default mode (no throw)", async () => {
  await withTempFile(async (path) => {
    await writeFile(path, "{ not valid json", "utf8");
    assert.equal((await readSettings(path)).update.mode, DEFAULT_UPDATE_MODE);
  });
});

test("readSettings: unknown stored mode → falls back to default", async () => {
  await withTempFile(async (path) => {
    await writeFile(path, JSON.stringify({ update: { mode: "bogus" } }), "utf8");
    assert.equal((await readSettings(path)).update.mode, DEFAULT_UPDATE_MODE);
  });
});

test("effectiveUpdateMode: env kill-switch forces 'off' over stored 'auto'", async () => {
  await withTempFile(async (path) => {
    await setUpdateMode("auto", path);
    await withEnv("off", async () => {
      assert.equal(await effectiveUpdateMode(path), "off");
    });
    for (const falsy of ["0", "false", "no"]) {
      await withEnv(falsy, async () => {
        assert.equal(await effectiveUpdateMode(path), "off");
      });
    }
  });
});

test("effectiveUpdateMode: no env → stored mode wins", async () => {
  await withTempFile(async (path) => {
    await setUpdateMode("auto", path);
    await withEnv(null, async () => {
      assert.equal(await effectiveUpdateMode(path), "auto");
    });
  });
});

test("setUpdateMode preserves the file as valid JSON object", async () => {
  await withTempFile(async (path) => {
    await setUpdateMode("auto", path);
    const s = await readSettings(path);
    assert.equal(s.update.mode, "auto");
  });
});

// ── #79: embedding.provider + ollama.autostart ──────────────────────────────

test("embedding.provider + ollama.autostart round-trip", async () => {
  await withTempFile(async (path) => {
    await setEmbeddingProvider("ollama", path);
    assert.equal(await getEmbeddingProvider(path), "ollama");
    await setOllamaAutostart(false, path);
    assert.equal(await getOllamaAutostart(path), false);
    // embedding survives the later autostart write (no clobber)
    assert.equal(await getEmbeddingProvider(path), "ollama");
  });
});

test("getEmbeddingProvider: undefined when unset (not a synthesized 'none')", async () => {
  await withTempFile(async (path) => {
    assert.equal(await getEmbeddingProvider(path), undefined);
  });
});

test("getOllamaAutostart: defaults to true when unset", async () => {
  await withTempFile(async (path) => {
    assert.equal(await getOllamaAutostart(path), true);
  });
});

test("writes preserve sibling keys (update + embedding + ollama)", async () => {
  await withTempFile(async (path) => {
    await setUpdateMode("auto", path);
    await setEmbeddingProvider("ollama", path);
    await setOllamaAutostart(false, path);
    const s = await readSettings(path);
    assert.equal(s.update.mode, "auto");
    assert.equal(s.embedding?.provider, "ollama");
    assert.equal(s.ollama?.autostart, false);
  });
});

test("readSettings: malformed embedding.provider → undefined, update.mode preserved", async () => {
  await withTempFile(async (path) => {
    await writeFile(path, JSON.stringify({ update: { mode: "auto" }, embedding: { provider: "llama" } }), "utf8");
    const s = await readSettings(path);
    assert.equal(s.update.mode, "auto");
    assert.equal(s.embedding, undefined);
  });
});

test("concurrent writes leave valid JSON (atomic tmp+rename, random suffix)", async () => {
  await withTempFile(async (path) => {
    await Promise.all([
      setEmbeddingProvider("ollama", path),
      setUpdateMode("auto", path),
      setOllamaAutostart(true, path),
    ]);
    const raw = await readFile(path, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "file must never be a torn/garbage write");
  });
});

test("docs: defaults are off/en, set-roundtrip preserves other settings", async () => {
  await withTempFile(async (path) => {
    assert.equal(await getDocsMode(path), "off");
    assert.equal(await getDocsLanguage(path), "en");

    await setUpdateMode("auto", path);
    await setDocsMode("suggest", path);
    await setDocsLanguage("DE", path);

    assert.equal(await getDocsMode(path), "suggest");
    assert.equal(await getDocsLanguage(path), "de", "language is normalized to lowercase");
    const s = await readSettings(path);
    assert.equal(s.update.mode, "auto", "docs writes must not clobber update.mode");
  });
});

test("docs: setting one key keeps the other (merge, not replace)", async () => {
  await withTempFile(async (path) => {
    await setDocsLanguage("de", path);
    await setDocsMode("auto", path);
    assert.equal(await getDocsLanguage(path), "de");
    assert.equal(await getDocsMode(path), "auto");
  });
});

test("readSettings: invalid docs.mode/docs.language → dropped to defaults", async () => {
  await withTempFile(async (path) => {
    await writeFile(
      path,
      JSON.stringify({ update: { mode: "auto" }, docs: { mode: "loud", language: "deutsch!" } }),
      "utf8",
    );
    const s = await readSettings(path);
    assert.equal(s.docs, undefined);
    assert.equal(await getDocsMode(path), "off");
    assert.equal(await getDocsLanguage(path), "en");
  });
});

test("sharedRecall: default off, no language override", async () => {
  await withTempFile(async (path) => {
    assert.equal(await getSharedRecallEnabled(path), false, "opt-in: default off");
    assert.equal(await getSharedRecallLanguage(path), undefined, "default = auto-detect");
  });
});

test("sharedRecall: enable persists and is independent of language override", async () => {
  await withTempFile(async (path) => {
    await setSharedRecallEnabled(true, path);
    assert.equal(await getSharedRecallEnabled(path), true);
    await setSharedRecallLanguage("de", path);
    assert.equal(await getSharedRecallLanguage(path), "de");
    // setting language must not clobber the enabled flag
    assert.equal(await getSharedRecallEnabled(path), true);
    // disabling keeps the language override around but reports disabled
    await setSharedRecallEnabled(false, path);
    assert.equal(await getSharedRecallEnabled(path), false);
    assert.equal(await getSharedRecallLanguage(path), "de");
  });
});

test("sharedRecall: language is lowercased and invalid values are dropped", async () => {
  await withTempFile(async (path) => {
    await setSharedRecallLanguage("DE", path);
    assert.equal(await getSharedRecallLanguage(path), "de");
    await writeFile(
      path,
      JSON.stringify({ update: { mode: "auto" }, sharedRecall: { enabled: true, language: "klingon!" } }),
      "utf8",
    );
    assert.equal(await getSharedRecallEnabled(path), true, "valid enabled kept");
    assert.equal(await getSharedRecallLanguage(path), undefined, "invalid language dropped");
  });
});

test("sharedRecall: a regex-valid but UNSUPPORTED hand-edited language (fr) is dropped on read", async () => {
  await withTempFile(async (path) => {
    // "fr" passes the loose docs-language regex but is not a supported pool language.
    // The file-read validator must agree with the boot gate and drop it.
    await writeFile(
      path,
      JSON.stringify({ update: { mode: "notify" }, sharedRecall: { enabled: true, language: "fr" } }),
      "utf8",
    );
    assert.equal(await getSharedRecallEnabled(path), true);
    assert.equal(await getSharedRecallLanguage(path), undefined, "unsupported language must not persist into the daemon");
  });
});

test("sharedRecall: non-boolean enabled is ignored", async () => {
  await withTempFile(async (path) => {
    await writeFile(path, JSON.stringify({ update: { mode: "notify" }, sharedRecall: { enabled: "yes" } }), "utf8");
    assert.equal(await getSharedRecallEnabled(path), false);
  });
});

test("sharedRecall: clearSharedRecallLanguage actually removes the override (not just rewrites enabled)", async () => {
  await withTempFile(async (path) => {
    await setSharedRecallEnabled(true, path);
    await setSharedRecallLanguage("de", path);
    assert.equal(await getSharedRecallLanguage(path), "de");
    // The bug: setSharedRecallEnabled spreads the block and preserves language.
    // clearSharedRecallLanguage must drop the key while keeping enabled.
    await clearSharedRecallLanguage(path);
    assert.equal(await getSharedRecallLanguage(path), undefined, "language override must be gone → auto-detect");
    assert.equal(await getSharedRecallEnabled(path), true, "enabled flag must survive the clear");
  });
});

test("reflex (#217): valid block persists, invalid maxPerTurn dropped", async () => {
  await withTempFile(async (path) => {
    await writeFile(
      path,
      JSON.stringify({ update: { mode: "notify" }, reflex: { enabled: false, maxPerTurn: 3 } }),
      "utf8",
    );
    const s = await readSettings(path);
    assert.deepEqual(s.reflex, { enabled: false, maxPerTurn: 3 });

    await writeFile(
      path,
      JSON.stringify({ update: { mode: "notify" }, reflex: { enabled: true, maxPerTurn: 99 } }),
      "utf8",
    );
    const invalid = await readSettings(path);
    assert.deepEqual(invalid.reflex, { enabled: true }, "out-of-range maxPerTurn must be dropped");

    await writeFile(path, JSON.stringify({ update: { mode: "notify" } }), "utf8");
    assert.equal((await readSettings(path)).reflex, undefined, "absent block stays absent");
  });
});

// ── #231: language.primary ───────────────────────────────────────────────────

test("language.primary: set/get round-trips, normalized to lowercase, siblings preserved", async () => {
  await withTempFile(async (path) => {
    assert.equal(await getPrimaryLanguage(path), undefined, "unset by default");
    await setUpdateMode("auto", path);
    await setPrimaryLanguage("DE", path);
    assert.equal(await getPrimaryLanguage(path), "de", "normalized to lowercase");
    assert.equal((await readSettings(path)).update.mode, "auto", "language write must not clobber update.mode");
  });
});

test("language.primary: invalid stored code is dropped on read, valid 2-letter survives", async () => {
  await withTempFile(async (path) => {
    await writeFile(path, JSON.stringify({ update: { mode: "notify" }, language: { primary: "english" } }), "utf8");
    assert.equal(await getPrimaryLanguage(path), undefined, "non-2-letter code rejected by the sanitizer");
    assert.equal((await readSettings(path)).update.mode, "notify", "sibling preserved");
    await writeFile(path, JSON.stringify({ language: { primary: "DE" } }), "utf8");
    assert.equal(await getPrimaryLanguage(path), "de", "valid 2-letter code survives, lowercased");
  });
});

// ─── #425: the persisted experiment block must survive a read ─────────────
//
// Gemessen auf a4c0896: eine gültige Settings-Datei mit `experiment`-Block kam
// als {"update":{"mode":"auto"}} zurück, `getExperimentConfig` lieferte `null`,
// also blieb jedes Telemetrie-Ereignis `unassigned`. `experiment` war der
// EINZIGE unterstützte Block, den readSettings verschluckte — der Round-Trip
// unten prüft alle fünfzehn, damit der nächste nicht wieder durchrutscht.

/** Die echte Registrierungsidentität aus packages/eval/registrations/presentation-experiment.json. */
const REGISTERED_EXPERIMENT = {
  name: "presentation-vs-retrieval",
  arms: ["wording_current", "wording_variant"],
  registration: "packages/eval/registrations/presentation-experiment.json",
  registration_version: 1,
};

test("#425: a full settings file round-trips without losing a single supported block", async () => {
  await withTempFile(async (path) => {
    const full: CliSettings = {
      update: { mode: "auto" },
      embedding: { provider: "ollama" },
      ollama: { autostart: false },
      api: { token: "tok-123" },
      cors: { origins: ["https://bastra.io"] },
      commons: { enabled: true },
      sharedRecall: { enabled: true, language: "de" },
      evidenceGate: { enabled: false },
      experiment: REGISTERED_EXPERIMENT,
      docs: { mode: "suggest", language: "de" },
      generation: { model: "gemma3:4b" },
      ui: { enabled: true },
      reflex: { enabled: true, maxPerTurn: 3 },
      size: { guide: 500, critical: 800, exemptPaths: ["sandbox/"] },
      language: { primary: "de" },
    };
    await writeFile(path, JSON.stringify(full, null, 2), "utf8");
    assert.deepEqual(await readSettings(path), full, "readSettings dropped a supported block");

    // Und nach einem Setter, der einen ANDEREN Block schreibt, steht noch alles da.
    await setUpdateMode("off", path);
    assert.deepEqual(await readSettings(path), { ...full, update: { mode: "off" } });
  });
});

test("#425: getExperimentConfig returns the persisted arms for the registered experiment", async () => {
  await withTempFile(async (path) => {
    await writeFile(path, JSON.stringify({ experiment: REGISTERED_EXPERIMENT }), "utf8");
    assert.deepEqual(await getExperimentConfig(path), {
      experiment: REGISTERED_EXPERIMENT.name,
      arms: REGISTERED_EXPERIMENT.arms,
    });
  });
});

test("#425: an experiment block without its registration reference is refused, siblings survive", async () => {
  await withTempFile(async (path) => {
    await writeFile(
      path,
      JSON.stringify({ update: { mode: "auto" }, experiment: { name: "floating", arms: ["a", "b"] } }),
      "utf8",
    );
    assert.equal(await getExperimentConfig(path), null, "no registration reference → no arm assignment");
    assert.equal((await readSettings(path)).update.mode, "auto", "sibling preserved");
  });
});

// ─── #534: concurrent mutations must not discard unrelated configuration ───
//
// Gemessen auf a4c0896 (ohne den Fix): gleicher Prozess 20 von 20 Läufen mit
// verlorenem Feld, zwei Prozesse 10 von 10 Runden — und beide Setter meldeten
// jedes Mal Erfolg. Ohne die Serialisierung in settings-lock.ts sind beide
// Tests hier rot.

test("#534: concurrent setters for different fields keep both values (same process)", async () => {
  const rounds = 20;
  for (let i = 0; i < rounds; i++) {
    await withTempFile(async (path) => {
      await Promise.all([setUpdateMode("off", path), setDocsMode("auto", path)]);
      const settings = await readSettings(path);
      assert.equal(settings.update.mode, "off", `round ${i}: update.mode lost`);
      assert.equal(settings.docs?.mode, "auto", `round ${i}: docs.mode lost`);
    });
  }
});

test("#534: concurrent setters for different fields keep both values (separate processes)", async () => {
  const settingsModule = new URL("../src/settings.ts", import.meta.url).href;
  const worker = [
    `import { setUpdateMode, setDocsMode } from ${JSON.stringify(settingsModule)};`,
    `const [which, path, gate] = process.argv.slice(2);`,
    // Busy-wait to a shared start instant so both processes really collide.
    `while (Date.now() < Number(gate)) {}`,
    `if (which === "update") await setUpdateMode("off", path);`,
    `else await setDocsMode("auto", path);`,
  ].join("\n");

  const dir = await mkdtemp(join(tmpdir(), "bastra-settings-xproc-"));
  try {
    const workerPath = join(dir, "worker.mts");
    await writeFile(workerPath, worker, "utf8");
    const run = (which: string, path: string, gate: number) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", workerPath, which, path, String(gate)], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${which} exited ${code}`))));
      });

    const rounds = 5;
    for (let i = 0; i < rounds; i++) {
      const path = join(dir, `round-${i}.json`);
      const gate = Date.now() + 700;
      await Promise.all([run("update", path, gate), run("docs", path, gate)]);
      const settings = await readSettings(path);
      assert.equal(settings.update.mode, "off", `round ${i}: update.mode lost across processes`);
      assert.equal(settings.docs?.mode, "auto", `round ${i}: docs.mode lost across processes`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
