/**
 * #607 regression pin: prompt-lane change-impact delivery is OFF by default,
 * and the code-roi measurement harness (which calls `promptImpactNote()`
 * directly, bypassing the lane) is unaffected by that default.
 *
 * `code-graph-impact-intent.test.ts` and `prompt-lane-telemetry-path-free.test.ts`
 * cover the delivery MECHANICS (gate phrasing, dedupe, staleness, telemetry
 * shape) with the feature explicitly turned on. This file covers the OPT-IN
 * ITSELF: that `runPromptLane` stays silent without it, that a stored or
 * env-set opt-in restores exactly the old behaviour, and that
 * `promptImpactNote()` — what `packages/eval/code-roi/v2/delivered-block.mjs`
 * imports and calls directly — never asks the setting at all.
 */
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runPromptLane } from "../src/prompt-lane.js";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { promptImpactNote } from "../src/code-graph/prompt-impact.js";
import { graphDirOf, GRAPH_FILE_NAME } from "../src/code-graph/reader.js";
import { writeManifest, type CodeGraphManifest } from "../src/code-graph/manifest.js";
import { codeGraphCache } from "../src/code-graph/dependents-block.js";
import type { ReadonlySessionState } from "../src/session-state.js";

function node(id: string, label: string, file: string, line = 1) {
  return { id, label, file_type: "code", source_file: file, source_location: `L${line}`, community: 0, _origin: "ast" };
}

function edge(source: string, target: string, relation: string) {
  return { source, target, relation, confidence: "EXTRACTED", confidence_score: 0.85, _origin: "ast" };
}

const SAVE = "packages/core/src/save.ts";
const PROMPT = "Was bricht, wenn ich saveMemory umbenenne?";

const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "5483f5697434bd20071d1b225a72e04db97a93e4",
  nodes: [
    node("save_savememory", "saveMemory()", SAVE, 4),
    node("save_validate", "validateMemory()", SAVE, 12),
    node("audit_auditsave", "auditSave()", "packages/core/src/audit-save.ts", 69),
  ],
  links: [edge("audit_auditsave", "save_savememory", "calls")],
  hyperedges: [],
};

const SAVE_SOURCE = [
  "export function saveMemory(input) {",
  "  return input;",
  "}",
  "",
].join("\n");

const MANIFEST: CodeGraphManifest = {
  graphifyVersion: "0.9.63",
  builtAt: new Date().toISOString(),
  commit: null,
  repoRoot: "",
  command: "graphify extract --code-only",
  fileState: { count: 2, newestMtimeMs: 0 },
  lastError: null,
  dirty: false,
};

let root: string;
let home: string;
let repo: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-prompt-impact-gate-"));
  home = join(root, "home");
  repo = join(root, "repo");
  await mkdir(join(home, ".bastra"), { recursive: true });

  const dir = graphDirOf(repo);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, GRAPH_FILE_NAME), JSON.stringify(FIXTURE), "utf8");
  const abs = join(repo, SAVE);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, SAVE_SOURCE, "utf8");
  const built = Date.now();
  const secs = (built - 60_000) / 1000;
  await utimes(abs, secs, secs);
  await writeManifest(dir, { ...MANIFEST, repoRoot: repo, builtAt: new Date(built).toISOString() });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeCliSettings(promptImpact: { enabled: boolean } | undefined): Promise<void> {
  await writeFile(
    join(home, ".bastra", "cli-settings.json"),
    JSON.stringify({ code: { repos: [repo] }, ...(promptImpact ? { promptImpact } : {}) }),
    "utf8",
  );
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runLane(sessionId: string, logDir: string, stateDir: string): Promise<string> {
  return withEnv(
    { HOME: home, BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir, BASTRA_HOOK_STATE_DIR: stateDir },
    async () => {
      await codeGraphCache().ensureLoaded(repo);
      return runPromptLane(
        { hook_event_name: "UserPromptSubmit", prompt: PROMPT, session_id: sessionId, cwd: repo },
        null,
        "http://127.0.0.1:1",
      );
    },
  );
}

async function readTelemetryEvents(dir: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

async function inScratch<T>(fn: (logDir: string, stateDir: string) => Promise<T>): Promise<T> {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-prompt-impact-gate-log-"));
  const stateDir = await mkdtemp(join(tmpdir(), "bastra-prompt-impact-gate-state-"));
  try {
    return await fn(logDir, stateDir);
  } finally {
    await rm(logDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("#607: prompt-lane delivery defaults to off", () => {
  it("no stored opinion, no env — the lane stays silent and logs no delivered row", async () => {
    await writeCliSettings(undefined);
    await inScratch(async (logDir, stateDir) => {
      await withEnv({ BASTRA_PROMPT_IMPACT: undefined }, async () => {
        const stdout = await runLane("gate-default", logDir, stateDir);
        assert.equal(stdout, "{}", "no recall daemon and no impact block → nothing to inject");
      });
      const events = await readTelemetryEvents(logDir);
      const promptEv = events.find((e) => e.kind === "prompt_hook_call");
      assert.ok(promptEv);
      assert.equal(Object.prototype.hasOwnProperty.call(promptEv, "code_block_tokens_est"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(promptEv, "code_basis"), false);
      assert.equal(
        events.find((e) => e.kind === "code_tool_call" && e.surface === "delivered" && e.delivered_lane === "prompt"),
        undefined,
        "no delivered/prompt telemetry row when the opt-in is off",
      );
    });
  });

  it("promptImpact.enabled: false in cli-settings.json — same as unset", async () => {
    await writeCliSettings({ enabled: false });
    await inScratch(async (logDir, stateDir) => {
      await withEnv({ BASTRA_PROMPT_IMPACT: undefined }, async () => {
        const stdout = await runLane("gate-file-off", logDir, stateDir);
        assert.equal(stdout, "{}");
      });
    });
  });

  it("promptImpact.enabled: true in cli-settings.json — delivers exactly as before", async () => {
    await writeCliSettings({ enabled: true });
    await inScratch(async (logDir, stateDir) => {
      const stdout = await withEnv({ BASTRA_PROMPT_IMPACT: undefined }, () =>
        runLane("gate-file-on", logDir, stateDir),
      );
      assert.match(stdout, /code-impact/, "stored opt-in restores delivery");
      const events = await readTelemetryEvents(logDir);
      assert.ok(
        events.find((e) => e.kind === "code_tool_call" && e.surface === "delivered" && e.delivered_lane === "prompt"),
        "delivered/prompt telemetry row must be written once opted in",
      );
    });
  });

  it("BASTRA_PROMPT_IMPACT=on overrides a stored false", async () => {
    await writeCliSettings({ enabled: false });
    await inScratch(async (logDir, stateDir) => {
      const stdout = await withEnv({ BASTRA_PROMPT_IMPACT: "on" }, () =>
        runLane("gate-env-on", logDir, stateDir),
      );
      assert.match(stdout, /code-impact/, "env wins over the file");
    });
  });
});

describe("#607: the code-roi measurement harness path is unaffected by the default", () => {
  it("promptImpactNote() renders a block with the opt-in unset — same call delivered-block.mjs makes", async () => {
    await withEnv({ BASTRA_PROMPT_IMPACT: undefined }, async () => {
      // Same construction as delivered-block.mjs: a fresh CodeGraphCache with
      // no allow-callback, bypassing the `code.repos` enablement too — the
      // harness measures the block AS IT SHIPS, not the opt-ins around it.
      const cache = new CodeGraphCache();
      await cache.ensureLoaded(repo);
      const session: ReadonlySessionState = { shown: {} };
      const out = await promptImpactNote({ prompt: PROMPT, cwd: repo, session, cache });
      assert.ok(out.note, "the harness must still get a block when the lane-level opt-in is off");
      assert.match(out.note.note, /code-impact/);
    });
  });

  it("promptImpactNote() renders even with BASTRA_PROMPT_IMPACT explicitly off", async () => {
    await withEnv({ BASTRA_PROMPT_IMPACT: "off" }, async () => {
      const cache = new CodeGraphCache();
      await cache.ensureLoaded(repo);
      const session: ReadonlySessionState = { shown: {} };
      const out = await promptImpactNote({ prompt: PROMPT, cwd: repo, session, cache });
      assert.ok(out.note, "promptImpactNote() must never read the lane's opt-in setting");
    });
  });
});
