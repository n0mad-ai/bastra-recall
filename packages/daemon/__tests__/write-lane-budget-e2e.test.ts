/**
 * #1624 — the pre-tool budget of the Write/Edit lane over the whole hook path:
 * the built thin client (`dist/hook.js`) posts to the REAL `/hook/write` route,
 * the lane runs against a real code graph and calls back for recall, and the
 * answer reaches the client's stdout.
 *
 * pretool-budget.test.ts proves `fitOptional` and the plan lane on their own.
 * This one proves the write lane applies the budget at the delivery boundary:
 * a four-file patch whose code-impact blocks (optional) add up past the
 * budget loses the blocks that do not fit — each one WHOLE, never cut —
 * while the file-size convention and the recall hint (mandatory) arrive
 * untouched. The control run sends a dropped file on its own and shows its
 * block does arrive when there is room, so the drop is the budget's doing,
 * not a block that was never computed.
 *
 * REVERT-CHECK, done once by hand: raise PRE_TOOL_CONTEXT_CHAR_BUDGET in
 * pretool-budget.ts far above the answer → the budget case goes red (all four
 * blocks arrive).
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// HOME first: the enabled-repository setting resolves under it. Set before
// any module that reads it is imported; the lane reads its timeout at load.
const home = await mkdtemp(join(tmpdir(), "bastra-1624-home-"));
const logDir = join(home, "logs");
process.env.HOME = home;
process.env.BASTRA_HOOK_STATE_DIR = join(home, "hook-state");
process.env.BASTRA_LOG_PATH = logDir;
process.env.BASTRA_TELEMETRY = "on";
process.env.BASTRA_DRAFT_HINTS = "0";
process.env.BASTRA_HOOK_TIMEOUT_MS = "5000";
// A small guide so a short fixture file carries the size convention.
process.env.BASTRA_SIZE_GUIDE = "100";

const { PRE_TOOL_CONTEXT_CHAR_BUDGET } = await import("../src/pretool-budget.js");
const { dispatchLocalRoutes } = await import("../src/http-local-routes.js");
const { setRepoEnabled } = await import("../src/code-graph/enabled-repos.js");
const { codeGraphCache } = await import("../src/code-graph/dependents-block.js");
const { graphDirOf, GRAPH_FILE_NAME } = await import("../src/code-graph/reader.js");
type LocalRouteCtx = import("../src/http-local-routes.js").LocalRouteCtx;

const HOOK = fileURLToPath(new URL("../dist/hook.js", import.meta.url));

const MODULES = [1, 2, 3, 4];
const CALLERS = ["auditTrail", "reportBuilder", "notifyQueue", "exportArchive", "syncReplica", "backupWriter"];

const node = (id: string, label: string, file: string) => ({
  id,
  label,
  file_type: "code",
  source_file: file,
  source_location: "L1",
  community: 0,
  _origin: "ast",
});
const edge = (source: string, target: string) => ({
  source,
  target,
  relation: "calls",
  confidence: "EXTRACTED",
  confidence_score: 0.9,
  _origin: "ast",
});

const saveLine = (m: number) => `export function persistenceContractSave${m}(input: string): string {`;
// The first module has enough code lines for the size note at a guide of 100.
const moduleSource = (m: number) =>
  `${saveLine(m)}\n  return input.trim();\n}\n` +
  (m === 1 ? Array.from({ length: 120 }, (_, i) => `export const filler${i} = ${i};`).join("\n") + "\n" : "");
const callerFile = (m: number, c: string) => `src/callers${m}/${c}ConsumerOfPersistence.ts`;

let recallHits: unknown[] = [];
let server: Server;
let baseUrl = "";

before(async () => {
  const ctx = { toolDeps: {} } as unknown as LocalRouteCtx;
  server = createServer((req, res) => {
    // The real route for the lane; the loopback calls the lane makes on its
    // own (recall, usage) get a fixed answer.
    if (req.url === "/hook/write" && dispatchLocalRoutes(req, res, req.method ?? "GET", req.url, Date.now(), ctx))
      return;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        req.url === "/hook/recall"
          ? JSON.stringify({ hits: recallHits, vault_size: 10, latency_ms: 1, recall_id: "r1624", project_known: true })
          : "{}"
      );
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
  await rm(home, { recursive: true, force: true });
});

async function freshRepo(name: string): Promise<string> {
  const repo = join(home, "repos", name);
  const files: Array<[string, string]> = [["package.json", JSON.stringify({ name })]];
  for (const m of MODULES) {
    files.push([`src/mod${m}.ts`, moduleSource(m)]);
    for (const c of CALLERS)
      files.push([
        callerFile(m, c),
        `import { persistenceContractSave${m} } from "../mod${m}.js";\nexport function ${c}() { persistenceContractSave${m}(""); }\n`,
      ]);
  }
  for (const [path, body] of files) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), body, "utf8");
  }
  const past = new Date(Date.now() - 3_600_000);
  for (const [path] of files) await utimes(join(repo, path), past, past);
  const graph = {
    directed: true,
    multigraph: false,
    graph: {},
    built_at_commit: "0000000000000000000000000000000000000000",
    nodes: MODULES.flatMap((m) => [
      node(`save${m}`, `persistenceContractSave${m}()`, `src/mod${m}.ts`),
      ...CALLERS.map((c) => node(`${c}${m}`, `${c}()`, callerFile(m, c))),
    ]),
    links: MODULES.flatMap((m) => CALLERS.map((c) => edge(`${c}${m}`, `save${m}`))),
    hyperedges: [],
  };
  await mkdir(graphDirOf(repo), { recursive: true });
  await writeFile(join(graphDirOf(repo), GRAPH_FILE_NAME), JSON.stringify(graph), "utf8");
  await setRepoEnabled(repo, true);
  await codeGraphCache().ensureLoaded(repo);
  assert.notEqual(codeGraphCache().get(repo), null, "fixture graph did not load");
  return repo;
}

/** A Codex apply_patch that renames the saved function in each module. */
const patch = (repo: string, modules: readonly number[]) =>
  [
    "*** Begin Patch",
    ...modules.flatMap((m) => [
      `*** Update File: ${join(repo, `src/mod${m}.ts`)}`,
      "@@",
      `-${saveLine(m)}`,
      `+${saveLine(m).replace("persistenceContractSave", "renamedSave")}`,
    ]),
    "*** End Patch",
  ].join("\n");

/** The built hook, as the host runs it: payload on stdin, answer on stdout. */
async function runHook(repo: string, sessionId: string, modules: readonly number[]): Promise<string> {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, BASTRA_DAEMON_URL: baseUrl },
    timeout: 10_000,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  child.stdin.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      session_id: sessionId,
      cwd: repo,
      bastra_client: "codex",
      tool_input: { command: patch(repo, modules) },
    })
  );
  assert.deepEqual(await once(child, "close"), [0, null]);
  const context = (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;
  assert.ok(context, `the hook answered with context: ${out}`);
  return context;
}

async function hookCallRow(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const rows: Array<Record<string, unknown>> = [];
  for (const f of (await readdir(logDir).catch(() => [] as string[])).filter((n) => n.startsWith("events-")))
    for (const line of (await readFile(join(logDir, f), "utf8")).split("\n"))
      if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
  return rows.find((r) => r.kind === "hook_call" && r.session_id === sessionId);
}

const impactFiles = (context: string) =>
  [...context.matchAll(/<code-impact file="src\/mod(\d)\.ts"/g)].map((m) => +m[1]!);

const hit = {
  id: "persistence-contract-rule",
  title: "Persistence contract rule",
  type: "lesson",
  scope: "all-projects",
  summary: "Renaming a persistence entry point needs every caller updated in the same change.",
  score: 150,
  matched_recall_when: true,
  anchor_strength: "strong",
};

test("#1624: blocks over the pre-tool budget are dropped whole; the mandatory text arrives", async () => {
  recallHits = [hit];
  const sessionId = "e2e-1624-budget";
  const repo = await freshRepo("budget");
  const context = await runHook(repo, sessionId, MODULES);

  // Mandatory: the size convention and the recall hint, each complete.
  assert.match(context, /<file-size-check file="mod1\.ts"[^>]*>[^<]+<\/file-size-check>/);
  assert.match(context, /persistence-contract-rule/);
  assert.ok(context.trimEnd().endsWith("</recall-hints>"), "the hint frame is never cut");

  // Optional: what fits stays, the rest is left out whole.
  const kept = impactFiles(context);
  assert.ok(kept.length >= 1, `at least one block fits: ${context}`);
  assert.ok(kept.length < MODULES.length, `the four blocks do not all fit: ${kept.join(",")}`);
  assert.equal(
    (context.match(/<code-impact /g) ?? []).length,
    (context.match(/<\/code-impact>/g) ?? []).length,
    "no block is cut"
  );
  const dropped = MODULES.filter((m) => !kept.includes(m));
  for (const m of dropped) assert.doesNotMatch(context, new RegExp(`callers${m}/`), `nothing of mod${m}'s block`);
  assert.ok(context.length <= PRE_TOOL_CONTEXT_CHAR_BUDGET, `${context.length} <= ${PRE_TOOL_CONTEXT_CHAR_BUDGET}`);

  const row = await hookCallRow(sessionId);
  assert.equal(row?.budget_dropped_count, dropped.length, "the drop is visible in the hook_call row");

  // Control: the same dropped file on its own, with room left, gets its block.
  const control = await runHook(await freshRepo("control"), "e2e-1624-control", [dropped[0]!]);
  assert.deepEqual(impactFiles(control), [dropped[0]]);
  assert.match(control, new RegExp(`callers${dropped[0]}/`));
});
