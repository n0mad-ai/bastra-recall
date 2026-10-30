import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAPABILITY_KEYS, HOST_CAPABILITIES, hostCapabilities } from "../src/host-capabilities.js";
import { CODEX_GATE_MIN_VERSION, codexGateSupported } from "../src/codex-gate-capability.js";
import { hookDefinitions } from "../src/cli/adapters/claude-code-hooks.js";
import { planCodexHooks } from "../src/cli/adapters/codex.js";
import { isToolAllowed } from "../src/tool-defs.js";

const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8");
const statuses = ["supported", "unsupported", "preparation-only", "unverified"];

test("all evidence rows record all capabilities, sources, runtime scope and coverage limits", () => {
  assert.equal(HOST_CAPABILITIES.length, 7);
  for (const row of HOST_CAPABILITIES) {
    assert.deepEqual(Object.keys(row.capabilities).sort(), [...CAPABILITY_KEYS].sort());
    assert.ok(row.runtime.scope);
    assert.ok(row.pre_tool_coverage.exceptions.length);
    assert.ok(row.pre_tool_coverage.sources.length);
    for (const value of Object.values(row.capabilities)) {
      assert.ok(statuses.includes(value.status));
      assert.ok(statuses.includes(value.bastra));
      assert.ok(value.sources.every(url => url.startsWith("https://")) && value.sources.length);
      assert.ok(value.note);
    }
  }
});

test("installable matrix rows agree with canonical support helper and CLI surface list", async () => {
  // Dynamic import keeps this test on the same canonical helper used by release drift tests.
  const helper = await import(new URL("tools/support-matrix.mjs", repo).href);
  const installable = [...new Set(HOST_CAPABILITIES.filter(row => row.installable).map(row => row.surface))].sort();
  assert.deepEqual(installable, helper.installableSurfaces().sort());
  assert.deepEqual(installable, ["claude-code", "claude-desktop", "codex", "cursor"]);
});

test("installer gate/fork registration agrees with the matrix's actual Bastra path", () => {
  const claudeDefs = hookDefinitions({ includeStop: true });
  assert.ok(claudeDefs.some(def => def.event === "PreToolUse" && def.stubSubcommand === "gate"));
  assert.equal(hostCapabilities("claude-code").capabilities.must_load_gate.bastra, "supported");
  for (const version of [CODEX_GATE_MIN_VERSION, "0.162.2", "0.161.0", null, "garbage", "0.163.0-beta.1"]) {
    const row = hostCapabilities("codex", version);
    const plan = planCodexHooks("install", {}, { includeStop: true, stubPresent: false, codexVersion: version });
    const pre = JSON.stringify(plan.after.PreToolUse);
    const hasGate = pre.includes("gate-hook.js");
    assert.equal(hasGate, codexGateSupported(version), String(version));
    assert.equal(row.capabilities.must_load_gate.bastra === "supported", hasGate, String(version));
    const session = JSON.stringify(plan.after.SessionStart);
    assert.equal(session.includes("fork"), row.capabilities.session_fork.bastra === "supported", String(version));
  }
});

test("Codex runtime certification is exact and coverage distinguishes probe from documentation", () => {
  const tested = hostCapabilities("codex", "0.162.1");
  assert.equal(tested.capabilities.pre_tool_deny.status, "supported");
  assert.deepEqual(tested.pre_tool_coverage.runtimeVerified, ["exec_command (hook name Bash)", "view_image"]);
  assert.ok(tested.pre_tool_coverage.documentedOnly.some(name => name.includes("MCP")));
  assert.match(tested.pre_tool_coverage.exceptions.join(" "), /write_stdin.*no fresh PreToolUse/);
  assert.match(tested.pre_tool_coverage.exceptions.join(" "), /Hosted WebSearch.*unsupported/);
  for (const version of [undefined, null, "0.161.0", "0.162.2", "99.0.0", "0.162.1-beta", "garbage"]) {
    for (const key of ["prompt_hook", "pre_tool_deny", "stop_block", "rule_kernel"] as const) {
      assert.equal(hostCapabilities("codex", version).capabilities[key].status, "unverified");
    }
    assert.deepEqual(hostCapabilities("codex", version).pre_tool_coverage.runtimeVerified, []);
  }
  assert.equal(tested.capabilities.stop_additional_context.bastra, "unsupported");
  assert.equal(tested.capabilities.stop_additional_context.status, "unverified");
  assert.equal(tested.capabilities.stop_block.bastra, "unsupported");
  assert.equal(hostCapabilities("claude-code").capabilities.stop_block.bastra, "supported");
});

test("#1311 — approved-copy Stop repair: additionalContext on Claude Code, unsupported on Codex, never a block", () => {
  const claudeRow = hostCapabilities("claude-code").capabilities;
  assert.equal(claudeRow.stop_additional_context.bastra, "supported");
  assert.match(claudeRow.stop_additional_context.note, /approved-copy repair/);
  assert.equal(claudeRow.stop_block.bastra, "supported");
  assert.match(claudeRow.stop_block.note, /separate approved-copy repair.*never a block decision/);
  for (const version of [CODEX_GATE_MIN_VERSION, null, "0.161.0"]) {
    const row = hostCapabilities("codex", version).capabilities;
    assert.equal(row.stop_additional_context.bastra, "unsupported", String(version));
    assert.match(row.stop_additional_context.note, /approved-copy Stop repair is not offered on Codex/);
    assert.equal(row.stop_block.bastra, "unsupported", String(version));
    assert.match(row.stop_block.note, /no approved-copy Stop repair on Codex/);
  }
});

test("hookless/replay capability claims do not imply live denial; validation needs write/full MCP", () => {
  for (const surface of ["cursor", "claude-desktop", "remote-mcp"] as const) {
    const row = hostCapabilities(surface);
    for (const key of ["prompt_hook", "pre_tool_deny", "stop_additional_context", "stop_block", "session_fork", "must_load_gate"] as const) {
      assert.equal(row.capabilities[key].status, "unverified");
      assert.equal(row.capabilities[key].bastra, "unsupported");
    }
    assert.equal(row.capabilities.rule_kernel.status, "unverified");
    assert.equal(row.capabilities.rule_kernel.bastra, "preparation-only");
    assert.match(row.prerequisites.join(" "), /without these does not have the tool/);
  }
  assert.ok(Object.values(hostCapabilities("replay").capabilities).every(cap => cap.status === "preparation-only"));
  assert.equal(isToolAllowed("validate_artifact", "search"), false);
  for (const surface of ["write", "full"] as const) assert.ok(isToolAllowed("validate_artifact", surface));
});

test("both README capability tables match the evidence ledger", () => {
  const readme = read("README.md");
  const table = [
    "| Surface | Runtime | Bastra pre_tool_deny | Bastra must_load_gate |",
    "|---|---|---|---|",
    ...HOST_CAPABILITIES.map(row => `| ${row.surface} | ${row.runtime.verifiedVersion ?? "unverified / not version-pinned"} | ${row.capabilities.pre_tool_deny.bastra} | ${row.capabilities.must_load_gate.bastra} |`),
  ].join("\n");
  assert.equal(readme.split(table).length - 1, 2, "EN and DE summaries must agree with the canonical data");
  assert.equal(readme.split("[host-capabilities.ts](./packages/daemon/src/host-capabilities.ts)").length - 1, 2);
  // Existing support rows make narrower installation claims than the capability ledger.
  assert.match(readme, /\*\*Cursor\*\*[^\n]+MCP/);
  assert.match(readme, /\*\*Claude Desktop\*\*[^\n]+MCP/);
  assert.match(readme, /\*\*Codex IDE \+ ChatGPT Desktop\*\*[^\n]+not yet field-tested/);
});


test("README hook registration counts match the Claude Code installer in both languages", () => {
  const readme = read("README.md");
  const withStop = hookDefinitions({ includeStop: true }).length;
  const withoutStop = hookDefinitions({ includeStop: false }).length;
  assert.ok(readme.includes(`${withStop} hook registrations (${withoutStop} without Stop/SessionEnd)`));
  assert.ok(readme.includes(`${withStop} Hook-Registrierungen (${withoutStop} ohne Stop/SessionEnd)`));
});
