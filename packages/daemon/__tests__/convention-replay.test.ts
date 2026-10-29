/**
 * Opt-in red baseline for #1278/#1302. No production enforcement is implemented here.
 * 1 pending-load/one-shot gate -> #1303; 2 action-time reflex -> #1303/#1304;
 * 3 tool cadence/kernel -> #1305; 4 implicit retrieval -> #1307;
 * 5 active task conventions -> #1305/#1306; 6 persistence fail-open -> #1303;
 * 7 host bootstrap parity/difference -> #1119/#1314.
 *
 * Run from repository root with npm run test:convention-replay --workspace=@bastra-recall/daemon.
 * The normal root glob discovers this file but skips the opt-in assertions.
 * The mock supplies invented retrieval DATA only; hook output comes from real
 * CLI programs and daemon lane functions. Never manufacture a deny or kernel.
 * #1303: the catch-all gate is wired at ADAPTER below — its real CLI runs beside
 * each tool lane's CLI, as Claude Code runs matching PreToolUse hooks in parallel.
 * Test 7 observes actual installer-created host startup instructions separately
 * from hook output. It makes no assertion about an unexecuted model following them.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { Vault, memoryRevision } from "@bastra-recall/core";
import { vaultConventionOf } from "../src/convention-source.js";
import { callerSessionStore } from "../src/caller-session.js";
import { validateArtifactHandler } from "../src/validate-artifact-handler.js";
import { runStopLane } from "../src/stop-lane.js";
import { loadSessionState } from "../src/session-state.js";

const enabled = process.env.CONVENTION_REPLAY === "1";
const options = { skip: !enabled, timeout: 120_000 };
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const SHORT = "Bitte kurz weiterarbeiten";
const CUE = "wie beim letzten Mal";
const ANNOUNCEMENT = "ich arbeite jetzt eine eingegangene Nachricht ab\nBonjour, pourriez-vous confirmer la visite fictive demain ?";
// Four invented memories. No private vault, model, external API or real tool action.
const vault = [
  { id: "fixture-preference", title: "Erfundene Kurzregel", type: "user-preference", scope: "all-projects",
    summary: "Antworte in zwei erfundenen Sätzen.", body: "Antworte in zwei erfundenen Sätzen.", revision: "sha256:fixture-pref-1" },
  { id: "fixture-working", title: "Erfundene Arbeitsregel", type: "meta-working", scope: "all-projects",
    summary: "Prüfe die erfundene Farbliste.", body: "Prüfe die erfundene Farbliste.", revision: "sha256:fixture-work-1" },
  { id: "fixture-message", title: "Erfundene Nachrichtenregel", type: "workflow", scope: "all-projects",
    summary: "Eingegangene Nachricht erst übersetzen; Entwurf vor Kopie prüfen.",
    body: "Erfundene Regel: Translate-only, dann draft-for-review, dann approved-copy. Kopie ohne Zitatpräfix; Zeichenzahl außerhalb des Kopierblocks. Verwende niemals fixture_send_message.",
    revision: "sha256:fixture-message-1", recall_mode: "reflex", write_origin: "user-directed", salience: 0.9,
    recall_when: ["eingegangene Nachricht", "fixture_send_message"],
    validator: { tool: "validate_artifact", channel: "discord-dm", limit: 2000, unit: "utf16" } },
  { id: "fixture-start", title: "Erfundener Startkontext", type: "project-fact", scope: "all-projects",
    summary: "Die erfundene Farbliste hat drei Farben.", body: "Die erfundene Farbliste hat drei Farben.", revision: "sha256:fixture-start-1" },
];
const mustLoadIds = vault.slice(0, 2).map(memory => memory.id);
type Output = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
type RequestRow = { path: string; body: Record<string, unknown> };
const context = (output: Output) => output.hookSpecificOutput?.additionalContext ?? "";
const denied = (output: Output) => output.hookSpecificOutput?.permissionDecision === "deny";

async function fixture(projection = false) {
  assert.ok(process.env.BASTRA_TEST_RUN_ROOT, "replay requires scripts/test-env.mjs isolation guard");
  const dir = await mkdtemp(join(tmpdir(), "bastra-convention-replay-"));
  const cwd = join(dir, "project");
  await mkdir(cwd);
  await mkdir(join(cwd, ".git")); // deterministic project detection, no git commands
  const configHome = join(dir, "config-home");
  await mkdir(configHome);
  const saved: Record<string, string | undefined> = {};
  const set = (key: string, value: string) => {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  };
  const stateDir = join(dir, "state");
  await mkdir(stateDir);
  set("BASTRA_HOOK_STATE_DIR", stateDir);
  set("BASTRA_LOG_PATH", join(dir, "logs"));
  set("BASTRA_TELEMETRY", "off");
  set("BASTRA_HOOK_TIMEOUT_MS", "5000");
  set("BASTRA_PROMPT_HOOK_MODE", "all");
  // Import only in opt-in runs, after isolation variables are set.
  const [{ runSessionLane }, { runPromptLane }, { runWriteLane }, { runBashPreLane }, { runGateLane, actionReflexPool }, { collectRuleKernel }] = await Promise.all([
    import("../src/session-lane.js"), import("../src/prompt-lane.js"),
    import("../src/write-lane.js"), import("../src/bash-pre-lane.js"), import("../src/gate-lane.js"),
    import("../src/rule-kernel.js"),
  ]);
  // Invented files through the real frontmatter loader, not injected session metadata.
  const vaultRoot = join(dir, "vault");
  await mkdir(join(vaultRoot, "memories"), { recursive: true });
  for (const memory of vault) {
    const { body, revision: _revision, ...fm } = memory;
    const raw = matter.stringify(body, {
      ...fm, topic_path: ["fixture"], tags: ["fixture"],
      recall_when: "recall_when" in fm ? fm.recall_when : ["fixture rule"],
      created: "2026-10-29", updated: "2026-10-29",
    });
    memory.revision = memoryRevision(raw);
    await writeFile(join(vaultRoot, "memories", `${memory.id}.md`), raw);
  }
  const loadedVault = new Vault(vaultRoot);
  await loadedVault.init();
  const index = loadedVault.list();
  const gatePool = actionReflexPool(index);
  // #1305 ADAPTER: the daemon's vault index as the kernel source (data only;
  // the real collector and renderer decide). No floors, like /hook/session-context below.
  const kernelVault = { list: () => index, get: (id: string) => index.find(memory => memory.fm.id === id) };
  const requests: RequestRow[] = [];
  const errors: unknown[] = [];
  const promptRows: Array<{ detected_mode: string }> = [];
  const recall = (query: string, cold = false) => ({
    hits: (cold ? vault.slice(3) : /Nachricht|fixture_send_message/.test(query) ? vault.slice(2, 3) : query === SHORT ? vault.slice(0, 2) : [])
      .map(memory => ({ ...memory, score: cold ? 400 : 150, matched_recall_when: true, anchor_strength: "strong" })),
    vault_size: vault.length, recall_id: "fixture-recall", latency_ms: 1,
    score_kind: cold ? "bm25" : "rrf", score_arms: cold ? ["bm25"] : ["bm25", "vector"],
    ...(cold ? { unfused: true, degraded: "embedding-cold" } : {}),
  });
  let base = "";
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const path = request.url ?? "";
      requests.push({ path, body });
      const payload = body.payload ?? {};
      let result: unknown;
      // ADAPTER: these are real production lane outputs, not mocked envelopes.
      switch (path) {
        case "/hook/session": result = await runSessionLane(payload, base, undefined, async () => null); break;
        // #1306 ADAPTER: the daemon route passes revisions read off its vault
        // index (vaultRevisionOf); here the invented memories carry them as data.
        case "/hook/prompt": result = await runPromptLane(payload, null, base, undefined,
          () => [vault[2].id], { onTelemetry: row => promptRows.push(row),
            conventionOf: vaultConventionOf(loadedVault) }); break;
        case "/hook/write": result = await runWriteLane(payload, base, cwd); break;
        case "/hook/bash-pre": result = await runBashPreLane(payload, base); break;
        case "/hook/gate": result = await runGateLane(payload, { reflexPool: () => gatePool,
          kernel: (active, project) => collectRuleKernel(kernelVault, { project, active, floors: async () => [] }) }); break;
        case "/hook/session-context": result = { data: { recalls: [
          { scope: "user-preference", resp: recall("", true) },
          { scope: "all-projects", resp: recall("", true) },
        ], floors: [], conventions: [], care: { open: 0, queued: 0 }, imports: { open: 0, queued: 0 }, onboarding: false } }; break;
        case "/hook/recall": result = recall(String(body.query ?? "")); break;
        case "/hook/reflex": result = { hits: /Nachricht|fixture_send_message/.test(String(body.context ?? ""))
          ? [{ ...vault[2], matched_phrase: String(body.context).includes("fixture_send_message") ? "fixture_send_message" : "eingegangene Nachricht" }]
          : [], recall_id: "fixture-reflex" }; break;
        case "/health": result = { ok: true, update_available: null }; break;
        case "/hook/hinted": result = {}; break;
        default: response.writeHead(404); response.end(JSON.stringify({ error: `unwired replay route: ${path}` })); return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(typeof result === "string" ? result : JSON.stringify(result));
    } catch (error) {
      errors.push(error);
      response.writeHead(500); response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  set("BASTRA_DAEMON_URL", base);
  set("BASTRA_HTTP_URL", base);
  if (projection) {
    // Real installer path and explicit install consent, in its own disposable
    // config home. #1314: withBootstrap is the real consent option.
    // Do not synthesize a bootstrap file to make this test pass.
    // Installer paths resolve relative to dist; use the real built adapter so
    // preflight checks find the same .js hook binaries as an actual install.
    const adapter = new URL("../dist/cli/adapters/codex.js", import.meta.url).href;
    const codexHome = join(configHome, ".codex");
    const binDir = join(configHome, "bin");
    await mkdir(codexHome, { recursive: true });
    await mkdir(binDir);
    // Only the external Codex MCP config command is a transport dependency
    // shim, like codex-doctor-notice.test.ts. The bastra installer, hook
    // registration, skills and future bootstrap writer remain real code.
    await writeFile(join(binDir, "codex"), `#!${process.execPath}\n` +
      `const fs=require('node:fs'),p=require('node:path');\n` +
      `const args=process.argv.slice(2),home=process.env.CODEX_HOME;\n` +
      `const state=p.join(home,'fixture-mcp.json');\n` +
      `if(args[0]==='mcp'&&args[1]==='get'){if(fs.existsSync(state))process.stdout.write(fs.readFileSync(state));else{process.stderr.write('No MCP server named bastra-recall');process.exitCode=1;}}\n` +
      `else if(args[0]==='mcp'&&args[1]==='add'){const cut=args.indexOf('--'),env={};for(let i=3;i<cut;i++)if(args[i]==='--env'){const value=args[++i],at=value.indexOf('=');env[value.slice(0,at)]=value.slice(at+1);}fs.writeFileSync(state,JSON.stringify({name:args[2],transport:{type:'stdio',command:args[cut+1],args:args.slice(cut+2),env}}));fs.writeFileSync(p.join(home,'config.toml'),'# synthetic MCP transport fixture\\n');}\n` +
      `else{process.stderr.write('unexpected external Codex fixture command');process.exitCode=2;}\n`, { mode: 0o700 });
    const source = `const {codexAdapter}=await import(${JSON.stringify(adapter)});` +
      `const result=await codexAdapter.install(${JSON.stringify({ dryRun: false, force: true, withBootstrap: true, useStub: false, vaultPath: cwd })});` +
      `if(result.status==='error')throw new Error(JSON.stringify(result));`;
    const installer = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: repo, env: { ...process.env, HOME: configHome, USERPROFILE: configHome, CODEX_HOME: codexHome,
        PATH: `${binDir}${delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    installer.stderr.on("data", chunk => stderr += chunk);
    installer.stdout.resume();
    const code = await new Promise<number | null>((resolve, reject) => { installer.once("error", reject); installer.once("exit", resolve); });
    if (code !== 0) {
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
      assert.equal(code, 0, `setup: real installer failed inside isolated config home: ${stderr}`);
    }
  }
  const session_id = "replay-fixture-conventions";
  async function hook(program: string, input: object): Promise<Output> {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(repo, "packages/daemon/src", program)], {
      cwd: repo, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
    try {
      const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      child.stdin.end(JSON.stringify({ session_id, cwd, ...input }));
      assert.equal(await done, 0, `real ${program} failed: ${stderr}`);
      assert.equal(errors.length, 0, `real daemon lane threw: ${errors.map(String).join("; ")}`);
      return JSON.parse(stdout) as Output;
    } finally { clearTimeout(timer); }
  }
  const prompt = (text: string) => hook("prompt-hook.ts", { hook_event_name: "UserPromptSubmit", prompt: text });
  // Claude Code runs every matching PreToolUse hook in parallel and a deny
  // wins over any allow/updatedInput (code.claude.com/docs/en/hooks). #1305:
  // without a deny, "when several hooks return additionalContext for the same
  // event, Claude receives all of the values" (same page) — so both reach it.
  const tool = async (tool_name: string, tool_input: object): Promise<Output> => {
    const input = { hook_event_name: "PreToolUse", tool_name, tool_input };
    const [gate, lane] = await Promise.all([hook("gate-hook.ts", input), hook(tool_name === "Bash" ? "bash-pre-hook.ts" : "hook.ts", input)]);
    if (denied(gate)) return gate;
    const contexts = [context(gate), context(lane)].filter(Boolean);
    if (contexts.length < 2) return context(gate) ? gate : lane;
    return { ...lane, hookSpecificOutput: { ...lane.hookSpecificOutput, additionalContext: contexts.join("\n") } };
  };
  async function replay() {
    const start = await hook("session-hook.ts", { hook_event_name: "SessionStart", source: "compact" });
    assert.ok(context(start).includes(vault[3].id), "setup: lexical-only compact start must reach real session formatter");
    const hints = [await prompt(SHORT), await prompt(SHORT)];
    assert.ok(hints.some(hint => mustLoadIds.every(id => context(hint).includes(id))),
      "setup: real prompt hook must expose both must-load IDs before gate assertions");
    const first = await tool("Edit", { file_path: join(cwd, "invented.ts"), old_string: "one", new_string: "two" });
    const retry = await tool("Edit", { file_path: join(cwd, "invented.ts"), old_string: "one", new_string: "two" });
    const toolSearch = await tool("ToolSearch", { query: "select:fixture_send_message" });
    const toolSearchRetry = await tool("ToolSearch", { query: "select:fixture_send_message" });
    const bash: Output[] = [];
    for (let call = 0; call < 30; call++) bash.push(await tool("Bash", { command: "printf invented" }));
    const cueStart = requests.length;
    const cueRowStart = promptRows.length;
    const cue = await prompt(CUE);
    const cueRequests = requests.slice(cueStart);
    const cueModes = promptRows.slice(cueRowStart).map(row => row.detected_mode);
    const message = await prompt(ANNOUNCEMENT);
    const followup = await prompt("ok");
    return { start, hints, first, retry, toolSearch, toolSearchRetry, bash, cue, cueRequests, cueModes, message, followup };
  }
  async function startupProjection() {
    const global = await readFile(join(configHome, ".codex", "AGENTS.md"), "utf8").catch(() => "");
    // Skills are conditional, so the installer's SKILL.md is not an always-on projection.
    return global;
  }
  return { replay, prompt, tool, hook, requests, promptRows, dir, cwd, stateDir, set, startupProjection,
    async close() {
      await loadedVault.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

let baseline: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["replay"]>>;
before(async () => {
  if (!enabled) return;
  const f = await fixture();
  try { baseline = await f.replay(); } finally { await f.close(); }
});

test("1 must-load gate denies first action with both IDs, then releases retry (#1303)", options, () => {
  assert.deepEqual({ firstDenied: denied(baseline.first), reasonNamesIds: mustLoadIds.every(id =>
    (baseline.first.hookSpecificOutput?.permissionDecisionReason ?? "").includes(id)), retryDenied: denied(baseline.retry) },
  { firstDenied: true, reasonNamesIds: true, retryDenied: false },
  "missing one-shot pending-load gate: first action must name both unloaded IDs; retry must pass");
});

test("2 ToolSearch action-time reflex denies once with full invented body (#1303/#1304)", options, () => {
  assert.deepEqual({ denied: denied(baseline.toolSearch), fullBody: JSON.stringify(baseline.toolSearch).includes(vault[2].body),
    retryDenied: denied(baseline.toolSearchRetry) }, { denied: true, fullBody: true, retryDenied: false },
  "ToolSearch bypassed the action-time reflex: expected one deny carrying the full synthetic rule body");
});

test("3 rule kernel is re-emitted by tool call 25 without another prompt (#1305)", options, () => {
  const emitted = baseline.bash.slice(0, 25).map(context).join("\n");
  assert.ok(/rule[- ]kernel|regelkern/i.test(emitted), "30 safe Bash calls produced no rule kernel by call 25");
});

test("4 implicit last-time cue retrieves and explicitly reports no matching rule (#1307)", options, () => {
  assert.deepEqual({ retrieval: baseline.cueRequests.some(row => row.path === "/hook/recall" && row.body.query === CUE),
    retrievalMode: baseline.cueModes.includes("retrieval"),
    explicitMiss: /no stored rule matched/i.test(context(baseline.cue)) }, { retrieval: true, retrievalMode: true, explicitMiss: true },
  "implicit cue must force retrieval AND emit 'no stored rule matched' when the invented vault has no rule");
});

test("5 messaging convention remains active with ID and revision on 'ok' (#1305/#1306)", options, () => {
  assert.ok(context(baseline.message).includes(vault[2].id), "setup: invented correspondence rule must actually surface on announcement");
  const next = context(baseline.followup);
  assert.deepEqual({ activeBlock: /active[- ]conventions/i.test(next), id: next.includes(vault[2].id),
    revision: next.includes(vault[2].revision) }, { activeBlock: true, id: true, revision: true },
  "trivial follow-up lost the active correspondence convention: expected Active-Conventions with ID and revision");
});

test("6 actual ENOTDIR state I/O failure fails open with gate_timeout/non-conformance evidence (#1303)", options, async () => {
  const f = await fixture();
  try {
    await f.prompt(SHORT);
    const obstacle = join(f.dir, "not-a-directory");
    await writeFile(obstacle, "synthetic state-write obstacle");
    const broken = join(obstacle, "state");
    f.set("BASTRA_HOOK_STATE_DIR", broken);
    // Verify actual filesystem failure rather than simulating a failure event.
    await assert.rejects(mkdir(broken, { recursive: true }), { code: "ENOTDIR" });
    // This case observes product telemetry only in a throwaway log directory.
    f.set("BASTRA_TELEMETRY", "on");
    await f.prompt(SHORT);
    const output = await f.tool("Edit", { file_path: join(f.cwd, "invented.ts"), old_string: "a", new_string: "b" });
    const logs = join(f.dir, "logs");
    const names = await readdir(logs).catch(() => [] as string[]);
    const bytes = (await Promise.all(names.map(name => readFile(join(logs, name), "utf8")))).join("\n");
    assert.deepEqual({ denied: denied(output), failureEvent: /gate_timeout|non[-_]conformance/i.test(bytes) },
      { denied: false, failureEvent: true }, "ENOTDIR failed open silently: missing gate_timeout/non-conformance event in isolated log");
  } finally { await f.close(); }
});

test("7 real installer provides an always-on startup projection and preserves replay parity (#1119/#1314)", options, async () => {
  const without = await fixture(false);
  let plain: typeof baseline;
  let plainProjection = "";
  try { plainProjection = await without.startupProjection(); plain = await without.replay(); } finally { await without.close(); }
  const withProjection = await fixture(true);
  let projected: typeof baseline;
  let installedProjection = "";
  try { installedProjection = await withProjection.startupProjection(); projected = await withProjection.replay(); } finally { await withProjection.close(); }
  const outcome = (run: typeof baseline) => ({ gate: denied(run.first), reflex: denied(run.toolSearch),
    cadence: run.bash.slice(0, 25).some(output => /rule[- ]kernel|regelkern/i.test(context(output))),
    explicitMiss: /no stored rule matched/i.test(context(run.cue)),
    active: /active[- ]conventions/i.test(context(run.followup)) && context(run.followup).includes(vault[2].revision) });
  assert.deepEqual({ uninstalledHasProjection: plainProjection.length > 0,
    installedHasRecallBootstrap: /bastra[- ]recall/i.test(installedProjection) && /load_memory/.test(installedProjection),
    without: outcome(plain!), with: outcome(projected!) },
  { uninstalledHasProjection: false, installedHasRecallBootstrap: true,
    without: { gate: true, reflex: true, cadence: true, explicitMiss: true, active: true },
    with: { gate: true, reflex: true, cadence: true, explicitMiss: true, active: true } },
  "installer currently provides no always-on recall bootstrap: both startup projections are empty; require a real managed projection plus replay parity");
});


test("8 declared frontmatter validator activates through real prompt → approved-copy → repair → session receipt", options, async () => {
  const f = await fixture();
  try {
    f.set("BASTRA_STOP_SAME_TURN", "1");
    await f.prompt(ANNOUNCEMENT);
    await f.prompt("ok");
    const sid = "replay-fixture-conventions";
    const state = await loadSessionState(sid);
    assert.equal(state.activeTask?.kind, "approved-copy");
    const rule = state.activeConventions?.find((c) => c.id === "fixture-message");
    assert.deepEqual(rule?.validator, vault[2].validator);
    assert.match(rule?.revision ?? "", /^sha256:/);
    const text = "Hallo Alex, das erfundene Paket kommt morgen.";
    const stop = (repeated = false) => runStopLane({ hook_event_name: "Stop", session_id: sid, cwd: f.cwd,
      stop_hook_active: repeated, transcript: [{ role: "user", content: "ok" }, { role: "assistant", content: text }] }, "http://127.0.0.1:1");
    assert.match(await stop(), /copy-repair/);
    const validation = await callerSessionStore.run(sid, () => validateArtifactHandler({
      text, channel: rule!.validator!.channel, limit: rule!.validator!.limit,
      unit: rule!.validator!.unit, normalize: "none", rule: { id: rule!.id, revision: rule!.revision! },
      task: { kind: state.activeTask!.kind, generation: state.activeTask!.generation },
    }));
    assert.equal(validation.receipt_stored, true);
    assert.equal(await stop(true), "{}");
  } finally { await f.close(); }
});
