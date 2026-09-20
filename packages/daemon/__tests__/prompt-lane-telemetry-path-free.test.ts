import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runPromptLane } from "../src/prompt-lane.js";
import { runWriteLane } from "../src/write-lane.js";
import { graphDirOf, GRAPH_FILE_NAME } from "../src/code-graph/reader.js";
import { writeManifest, type CodeGraphManifest } from "../src/code-graph/manifest.js";
import { codeGraphCache } from "../src/code-graph/dependents-block.js";

/**
 * #606 regression pin, one level below `code-graph-impact-intent.test.ts`.
 *
 * That file pins the IN-MEMORY `PromptImpactNote` (`"listed" in out.note ===
 * false`), never the telemetry LINE the prompt lane actually appends to disk.
 * Before 167ff0a, `runPromptLane`'s own `writeTelemetry()` call carried
 * `code_listed: impact.listed` — absolute candidate file paths — straight into
 * the `prompt_hook_call` row, even though `PromptImpactNote` itself never
 * exposed a `listed` field to begin with; the leak was `prompt-lane.ts`
 * reaching past that missing field into telemetry on its own. A fix that
 * reintroduces `code_listed` there would pass the note-level pin untouched and
 * leak again. This file runs the real lane end to end (`runPromptLane`,
 * `runWriteLane`) against a small on-disk graph fixture and reads the JSONL
 * rows both of them append.
 *
 * Two rows exist per delivered block, not one: `prompt-lane.ts`'s own
 * `prompt_hook_call` row (carries `code_basis` / `code_block_tokens_est`,
 * never a path) and the `code_tool_call` row `code-delivered-telemetry.ts`
 * appends for both lanes (carries `surface: "delivered"` / `delivered_lane`,
 * also never a path — `logDeliveredBlock` was never given `listed` either).
 * The write lane's OWN `hook_call` row is the asymmetric case: it already
 * logs `file_path` on every call, so `code_listed`'s absolute paths add
 * nothing a reader of that row does not already have, and #606 depends on
 * them for the "listed, then edited" join — that is checked at the end, not
 * as a leak.
 */

function node(id: string, label: string, file: string, line = 1) {
  return {
    id,
    label,
    file_type: "code",
    source_file: file,
    source_location: `L${line}`,
    community: 0,
    _origin: "ast",
  };
}

function edge(source: string, target: string, relation: string) {
  return { source, target, relation, confidence: "EXTRACTED", confidence_score: 0.85, _origin: "ast" };
}

const SAVE = "packages/core/src/save.ts";

/** Same fixture as `code-graph-impact-intent.test.ts`; line numbers match the
 *  real source below so a diff-based (write-lane) selection resolves too. */
const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "5483f5697434bd20071d1b225a72e04db97a93e4",
  nodes: [
    node("save_savememory", "saveMemory()", SAVE, 4),
    node("save_validate", "validateMemory()", SAVE, 12),
    node("audit_auditsave", "auditSave()", "packages/core/src/audit-save.ts", 69),
    node("checks_run", "runChecks()", "packages/core/src/checks.ts", 8),
  ],
  links: [
    edge("audit_auditsave", "save_savememory", "calls"),
    edge("checks_run", "save_validate", "calls"),
  ],
  hyperedges: [],
};

const SAVE_SOURCE = [
  "// header",
  "import { z } from 'zod';",
  "",
  "export function saveMemory(input) {",
  "  return input;",
  "}",
  "",
  "const TOP_LEVEL = 1;",
  "",
  "// a comment between them",
  "",
  "export function validateMemory(input) {",
  "  return TOP_LEVEL;",
  "}",
  "",
].join("\n");

/** An Edit that rewrites the body of `saveMemory` and nothing else. */
const EDIT_SAVE = {
  old_string: "  return input;",
  new_string: "  return { ...input, saved: true };",
};

const MANIFEST: CodeGraphManifest = {
  graphifyVersion: "0.9.63",
  builtAt: new Date().toISOString(),
  commit: null,
  repoRoot: "",
  command: "graphify extract --code-only",
  fileState: { count: 4, newestMtimeMs: 0 },
  lastError: null,
  dirty: false,
};

let root: string;
let home: string;
let repo: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-prompt-telemetry-pathfree-"));
  home = join(root, "home");
  repo = join(root, "repo");

  // Production reads the enabled-repo list from `~/.bastra/cli-settings.json`
  // (`settingsFilePath()` has no env override), so an end-to-end run through
  // the shared `codeGraphCache()` singleton needs its own HOME — same trick as
  // #511's docs-mode test (`lane-project-confidence.test.ts`).
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

  await writeFile(
    join(home, ".bastra", "cli-settings.json"),
    JSON.stringify({ code: { repos: [repo] } }),
    "utf8",
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every telemetry event a lane wrote into a throwaway log dir (#356). */
async function readTelemetryEvents(dir: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

describe("prompt lane: delivered change-impact telemetry stays path-free", () => {
  it("the prompt_hook_call and code_tool_call rows carry no path, no code_listed", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "bastra-prompt-telemetry-log-"));
    const stateDir = await mkdtemp(join(tmpdir(), "bastra-prompt-telemetry-state-"));
    try {
      await withEnv(
        {
          HOME: home,
          BASTRA_TELEMETRY: "on",
          BASTRA_LOG_PATH: logDir,
          BASTRA_HOOK_STATE_DIR: stateDir,
          // #607: prompt-lane delivery is off by default — this test exercises
          // the delivery path itself, so it opts in explicitly.
          BASTRA_PROMPT_IMPACT: "on",
        },
        async () => {
          await codeGraphCache().ensureLoaded(repo);
          const stdout = await runPromptLane(
            {
              hook_event_name: "UserPromptSubmit",
              prompt: "Was bricht, wenn ich saveMemory umbenenne?",
              session_id: "prompt-pathfree-session",
              cwd: repo,
            },
            null,
            "http://127.0.0.1:1",
          );
          // Precondition: the block actually went out, or the rows below would
          // be silence and every assertion after this would pass vacuously.
          assert.match(stdout, /code-impact/, "expected a delivered change-impact block");
        },
      );

      const events = await readTelemetryEvents(logDir);

      const promptEv = events.find((e) => e.kind === "prompt_hook_call");
      assert.ok(promptEv, "a prompt_hook_call row must be written");
      assert.equal(typeof promptEv.code_block_tokens_est, "number");
      assert.ok((promptEv.code_block_tokens_est as number) > 0);
      assert.deepEqual(promptEv.code_basis, ["symbols"]);
      assert.equal(
        Object.prototype.hasOwnProperty.call(promptEv, "code_listed"),
        false,
        "167ff0a removed code_listed from the prompt lane's own row — a regression reintroducing it must fail here",
      );
      const promptText = JSON.stringify(promptEv);
      assert.doesNotMatch(promptText, /\/Users\//, "no absolute path in the prompt_hook_call row");
      assert.doesNotMatch(promptText, new RegExp(repo.split("/").pop()!), "the repo's own dir name is not in the row");
      assert.doesNotMatch(promptText, /save\.ts|audit-save/, "no file name from the block leaks into the row");

      const deliveredEv = events.find((e) => e.kind === "code_tool_call" && e.surface === "delivered");
      assert.ok(deliveredEv, "a code_tool_call/delivered row must be written");
      assert.equal(deliveredEv.delivered_lane, "prompt");
      assert.equal(
        Object.prototype.hasOwnProperty.call(deliveredEv, "code_listed"),
        false,
        "logDeliveredBlock never receives `listed` — the delivered row must not carry paths either",
      );
      const deliveredText = JSON.stringify(deliveredEv);
      assert.doesNotMatch(deliveredText, /\/Users\//, "no absolute path in the delivered row");
      assert.doesNotMatch(deliveredText, /save\.ts|audit-save/, "no file name leaks into the delivered row");
    } finally {
      await rm(logDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("write lane: the followed-by-edit join still has its data", () => {
  it("the hook_call row still carries code_listed and code_targets", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "bastra-write-telemetry-log-"));
    const stateDir = await mkdtemp(join(tmpdir(), "bastra-write-telemetry-state-"));
    try {
      await withEnv(
        {
          HOME: home,
          BASTRA_TELEMETRY: "on",
          BASTRA_LOG_PATH: logDir,
          BASTRA_HOOK_STATE_DIR: stateDir,
        },
        async () => {
          await codeGraphCache().ensureLoaded(repo);
          const stdout = await runWriteLane(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Edit",
              session_id: "write-pathfree-session",
              cwd: repo,
              tool_input: { file_path: join(repo, SAVE), ...EDIT_SAVE },
            },
            "http://127.0.0.1:1",
          );
          assert.match(stdout, /code-impact/, "expected a delivered change-impact block");
        },
      );

      const events = await readTelemetryEvents(logDir);
      const writeEv = events.find((e) => e.kind === "hook_call");
      assert.ok(writeEv, "a hook_call row must be written");
      // #606: this is the data the "listed, then edited" join reads — unlike
      // the prompt lane, the write lane's row already carries `file_path` on
      // every call, so these absolute paths are not a new class of leak here.
      assert.ok(Array.isArray(writeEv.code_listed) && (writeEv.code_listed as unknown[]).length > 0);
      assert.ok((writeEv.code_listed as string[]).every((p) => p.startsWith(repo)));
      assert.deepEqual(writeEv.code_targets, [join(repo, SAVE)]);
    } finally {
      await rm(logDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
