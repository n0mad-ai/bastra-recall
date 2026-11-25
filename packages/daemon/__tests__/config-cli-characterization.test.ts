/**
 * #1510: `bastra config get|set` pinned byte for byte before its branch chain is
 * restructured: exit code, stdout, stderr and the stored settings per case.
 *
 * Each case runs against its own temp HOME; the home path is replaced by <HOME>,
 * the per-run test port by <PORT>.
 * The expected results live in fixtures/config-cli-golden.json. To record them
 * again after a deliberate output change: BASTRA_GOLDEN_WRITE=1 and run this file.
 *
 * Not covered here: `set assistant.name` (it starts the address setup; see the
 * address tests).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdConfig } from "../src/cli/config-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { readSettingsFixture } from "./fixtures/settings-db.js";

interface Case {
  name: string;
  env?: Record<string, string>;
  runs: string[][];
}

const bool = (key: string, env?: string): Case[] => [
  {
    name: `${key} on/off/invalid/missing`,
    runs: [
      ["set", key, "on"],
      ["get", key],
      ["set", key, "false"],
      ["set", key, "maybe"],
      ["set", key],
    ],
  },
  ...(env
    ? [
        {
          name: `${key} with env override`,
          env: { [env]: "1" },
          runs: [
            ["set", key, "yes"],
            ["get", key],
          ],
        },
      ]
    : []),
];

const CASES: Case[] = [
  { name: "usage and unknown key", runs: [["frobnicate"], ["get", "no.such.key"], ["set"]] },
  {
    name: "update.mode",
    runs: [
      ["get", "update.mode"],
      ["set", "update.mode", "auto"],
      ["set", "update.mode", "off"],
      ["set", "update.mode", "bogus"],
      ["get", "update.mode"],
    ],
  },
  {
    name: "embedding.provider",
    runs: [
      ["get", "embedding.provider"],
      ["set", "embedding.provider", "ollama"],
      ["set", "embedding.provider", "none"],
      ["set", "embedding.provider", "bogus"],
      ["get", "embedding.provider"],
    ],
  },
  {
    name: "embedding.provider with env",
    env: { BASTRA_EMBEDDING_PROVIDER: "openai" },
    runs: [
      ["set", "embedding.provider", "ollama"],
      ["set", "embedding.provider", "openai"],
      ["get", "embedding.provider"],
    ],
  },
  ...bool("ollama.autostart"),
  {
    name: "docs.mode",
    runs: [
      ["get", "docs.mode"],
      ["set", "docs.mode", "auto"],
      ["set", "docs.mode", "suggest"],
      ["set", "docs.mode", "off"],
      ["set", "docs.mode", "bogus"],
    ],
  },
  {
    name: "docs.language",
    runs: [
      ["get", "docs.language"],
      ["set", "docs.language", "PT-BR"],
      ["set", "docs.language", "not a tag"],
      ["get", "docs.language"],
    ],
  },
  ...bool("ui.enabled"),
  ...bool("archive.enabled", "BASTRA_RM_ARCHIVES"),
  ...bool("reflex.enabled", "BASTRA_REFLEX"),
  ...bool("battery.saver", "BASTRA_BATTERY_SAVER"),
  ...bool("promptImpact.enabled", "BASTRA_PROMPT_IMPACT"),
  ...bool("coverageMap.enabled", "BASTRA_COVERAGE_MAP"),
  {
    name: "archive.retain",
    runs: [
      ["get", "archive.retain"],
      ["set", "archive.retain", "junk=1,in-git=2.5,user=3"],
      ["set", "archive.retain", "bogus"],
      ["get", "archive.retain"],
    ],
  },
  { name: "archive.retain with env", env: { BASTRA_ARCHIVE_RETAIN: "junk=9" }, runs: [["get", "archive.retain"]] },
  {
    name: "archive.cap",
    runs: [
      ["get", "archive.cap"],
      ["set", "archive.cap", "5GB"],
      ["set", "archive.cap", "0"],
      ["get", "archive.cap"],
    ],
  },
  {
    name: "archive.cap with env",
    env: { BASTRA_ARCHIVE_CAP: "1GB" },
    runs: [
      ["set", "archive.cap", "500MB"],
      ["get", "archive.cap"],
    ],
  },
  {
    name: "archive.max-item",
    runs: [
      ["get", "archive.max-item"],
      ["set", "archive.max-item", "2GB"],
      ["get", "archive.max-item"],
      ["set", "archive.max-item", "off"],
      ["set", "archive.max-item", "none"],
      ["set", "archive.max-item", "bogus"],
    ],
  },
  {
    name: "archive.max-item with env",
    env: { BASTRA_ARCHIVE_MAX_ITEM: "1GB" },
    runs: [
      ["set", "archive.max-item", "2GB"],
      ["get", "archive.max-item"],
    ],
  },
  {
    name: "size.guide",
    runs: [
      ["get", "size.guide"],
      ["set", "size.guide", "300.4"],
      ["set", "size.guide", "50"],
      ["set", "size.guide", "x"],
      ["get", "size.guide"],
    ],
  },
  { name: "size.guide with env", env: { BASTRA_SIZE_GUIDE: "800" }, runs: [["get", "size.guide"]] },
  {
    name: "language.primary",
    runs: [
      ["get", "language.primary"],
      ["set", "language.primary", " DE "],
      ["set", "language.primary", "deu"],
      ["get", "language.primary"],
    ],
  },
  {
    name: "assistant.name get and empty set",
    runs: [
      ["get", "assistant.name"],
      ["set", "assistant.name"],
      ["set", "assistant.name", ""],
    ],
  },
  {
    name: "registry keys",
    runs: [
      ["get", "tasks.enabled"],
      ["set", "tasks.enabled", "on"],
      ["set", "tasks.enabled", "maybe"],
      ["get", "tasks.enabled"],
      ["set", "reflex.maxPerTurn", "3"],
      ["get", "reflex.maxPerTurn"],
      ["set", "size.exemptPaths", '["a/**"]'],
      ["set", "size.exemptPaths", "[broken"],
      ["get", "size.exemptPaths"],
      ["set", "soul.text"],
      ["get", "api.token"],
      ["set", "api.token", "secret-value"],
      ["get", "api.token"],
    ],
  },
  { name: "registry key with env", env: { BASTRA_TASKS: "1" }, runs: [["get", "tasks.enabled"]] },
  {
    name: "daemon.env",
    runs: [
      ["set", "daemon.env", '{"BASTRA_LOG_RETENTION_DAYS":"60"}'],
      ["set", "daemon.env", "{broken"],
      ["get", "daemon.env"],
    ],
  },
  // Remaining registry keys (#1510): where the CLI refuses a key, the refusal is the golden value.
  ...bool("commons.enabled"),
  ...bool("sharedRecall.enabled"),
  ...bool("sharedRecall.live"),
  ...bool("evidenceGate.enabled", "BASTRA_EVIDENCE_GATE"),
  ...bool("ui.backdropBlur"),
  ...bool("tasks.notifications"),
  ...bool("redaction.enabled"),
  ...bool("telemetry.enabled", "BASTRA_TELEMETRY"),
  {
    name: "cors.origins",
    runs: [
      ["get", "cors.origins"],
      ["set", "cors.origins", '["http://localhost:3000/"]'],
      ["set", "cors.origins", '["not a url"]'],
      ["get", "cors.origins"],
    ],
  },
  { name: "cors.origins with env", env: { BASTRA_CORS_ORIGIN: "http://a.example" }, runs: [["get", "cors.origins"]] },
  {
    name: "sharedRecall.language",
    runs: [
      ["get", "sharedRecall.language"],
      ["set", "sharedRecall.language", " DE "],
      ["set", "sharedRecall.language", "xx-not-supported"],
      ["get", "sharedRecall.language"],
    ],
  },
  {
    name: "experiment keys",
    runs: [
      ["get", "experiment.name"],
      ["set", "experiment.name", "exp-1"],
      ["set", "experiment.arms", '["a","b"]'],
      ["set", "experiment.registration", "reg-1"],
      ["set", "experiment.registration_version", "2"],
      ["set", "experiment.registration_version", "x"],
      ["get", "experiment.arms"],
    ],
  },
  {
    name: "generation.model",
    runs: [
      ["get", "generation.model"],
      ["set", "generation.model", " llama3:8b "],
      ["set", "generation.model", "  "],
      ["get", "generation.model"],
    ],
  },
  { name: "generation.model with env", env: { BASTRA_EXPAND_MODEL: "qwen3:4b" }, runs: [["get", "generation.model"]] },
  {
    name: "modelRecommendation keys",
    runs: [
      ["get", "modelRecommendation.id"],
      ["set", "modelRecommendation.answer", "later"],
      ["get", "modelRecommendation.answer"],
    ],
  },
  {
    name: "ui.backdrop keys",
    runs: [
      ["get", "ui.backdrop"],
      ["set", "ui.backdrop", "aurora"],
      ["set", "ui.backdrop", "nope"],
      ["get", "ui.backdropDim"],
      ["set", "ui.backdropDim", "65"],
      ["set", "ui.backdropDim", "52"],
      ["get", "ui.backdrop"],
    ],
  },
  {
    name: "assistant.displayName",
    runs: [
      ["get", "assistant.displayName"],
      ["set", "assistant.displayName", "Ruby"],
    ],
  },
  {
    name: "soul.direction",
    runs: [
      ["get", "soul.direction"],
      ["set", "soul.direction", "warm"],
      ["set", "soul.direction", "bogus"],
      ["get", "soul.direction"],
    ],
  },
  {
    name: "size.critical",
    runs: [
      ["get", "size.critical"],
      ["set", "size.critical", "900"],
      ["set", "size.critical", "x"],
      ["get", "size.critical"],
    ],
  },
  { name: "size.critical with env", env: { BASTRA_SIZE_CRITICAL: "1200" }, runs: [["get", "size.critical"]] },
  {
    name: "code.repos",
    runs: [
      ["get", "code.repos"],
      ["set", "code.repos", '["/tmp/repo"]'],
      ["set", "code.repos", "[]"],
      ["get", "code.repos"],
    ],
  },
  {
    name: "tasks.chatActiveMinutes",
    runs: [
      ["get", "tasks.chatActiveMinutes"],
      ["set", "tasks.chatActiveMinutes", "45"],
      ["set", "tasks.chatActiveMinutes", "0"],
      ["get", "tasks.chatActiveMinutes"],
    ],
  },
  {
    name: "tasks.reportUndo",
    runs: [
      ["get", "tasks.reportUndo"],
      ["set", "tasks.reportUndo", " 2H "],
      ["set", "tasks.reportUndo", "bogus"],
      ["get", "tasks.reportUndo"],
    ],
  },
  {
    name: "tasks.chatConsent",
    runs: [
      ["get", "tasks.chatConsent"],
      ["set", "tasks.chatConsent", "accepted"],
    ],
  },
  {
    name: "env-backed keys",
    runs: [
      ["get", "logs.retention"],
      ["set", "logs.retention", "120"],
      ["set", "logs.retention", "abc"],
      ["set", "logs.retention"],
      ["get", "logs.retention"],
      ["set", "hint.suppress", "on"],
      ["set", "hint.suppress", "maybe"],
      ["set", "ollama.url", "http://localhost:11434"],
    ],
  },
];

interface Result {
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
}

async function runCase(c: Case): Promise<{ results: Result[]; stored: unknown }> {
  const home = await mkdtemp(join(tmpdir(), "bastra-config-golden-"));
  const savedEnv = { ...process.env };
  process.env.HOME = home;
  for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
  const write = { out: process.stdout.write, err: process.stderr.write };
  const results: Result[] = [];
  try {
    for (const argv of c.runs) {
      let stdout = "",
        stderr = "";
      process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
      process.stderr.write = ((s: string) => ((stderr += s), true)) as typeof process.stderr.write;
      let code: number;
      try {
        code = await cmdConfig(parseArgs(["config", ...argv]));
      } finally {
        process.stdout.write = write.out;
        process.stderr.write = write.err;
      }
      const port = process.env.BASTRA_HTTP_PORT;
      const clean = (s: string) => {
        const out = s.split(home).join("<HOME>");
        return port ? out.split(`:${port}/`).join(":<PORT>/") : out;
      };
      results.push({ argv, code, stdout: clean(stdout), stderr: clean(stderr) });
    }
    let stored: unknown = null;
    try {
      stored = JSON.parse(await readSettingsFixture(join(home, ".bastra", "cli-settings.json")));
    } catch {
      /* nothing stored */
    }
    return { results, stored };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    await rm(home, { recursive: true, force: true });
  }
}

const golden = new URL("./fixtures/config-cli-golden.json", import.meta.url);

test("#1510: bastra config get/set output and stored settings are unchanged per case", async () => {
  const actual: Record<string, unknown> = {};
  for (const c of CASES) actual[c.name] = await runCase(c);
  if (process.env.BASTRA_GOLDEN_WRITE === "1") {
    await writeFile(golden, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  const expected = JSON.parse(await readFile(golden, "utf8"));
  for (const c of CASES) assert.deepEqual(actual[c.name], expected[c.name], c.name);
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
});
