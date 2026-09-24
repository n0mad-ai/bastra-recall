import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { hookAgent } from "../src/hook-surface.js";
import { dimensionsFrom } from "../src/telemetry-dimensions.js";

// Revert-check: make hookAgent always return "main" → the subagent case is red;
// drop the allowlist spread in dimensionsFrom → the free-text case is red.
describe("hook agent dimension: main thread vs subagent", () => {
  it("a payload with agent_id comes from a subagent; without it, from the main thread", () => {
    assert.equal(hookAgent({ session_id: "s", agent_id: "a1b2", agent_type: "Explore" }), "subagent");
    assert.equal(hookAgent({ session_id: "s" }), "main");
    assert.equal(hookAgent({ session_id: "s", agent_id: "" }), "main");
    assert.equal(hookAgent({ session_id: "s", agent_id: 7 }), "main");
    assert.equal(hookAgent(null), null);
    // `claude --agent X` puts agent_type on the MAIN thread's payloads too —
    // agent_type alone is not a subagent.
    assert.equal(hookAgent({ session_id: "s", agent_type: "reviewer" }), "main");
  });

  it("a Codex payload without agent_id backs no answer — null, not a guessed main", () => {
    // Codex never sends agent_id, so its absence there says nothing (#507 rule).
    assert.equal(hookAgent({ session_id: "s", bastra_client: "codex" }), null);
    assert.equal(hookAgent({ session_id: "s", tool_name: "apply_patch" }), null);
    // Presence is still evidence, whoever sent it.
    assert.equal(hookAgent({ session_id: "s", bastra_client: "codex", agent_id: "x" }), "subagent");
    assert.equal(hookAgent({ session_id: "s", bastra_client: "claude-code" }), "main");
  });

  it("dimensionsFrom keeps agent only from the allowlist, never free text", () => {
    assert.equal(dimensionsFrom({ hook_source: "bash-pre", agent: "subagent" }).agent, "subagent");
    assert.equal(dimensionsFrom({ hook_source: "bash-pre", agent: "main" }).agent, "main");
    // agent_type is user-defined text (custom agent names) — it must not become a column value.
    assert.equal("agent" in dimensionsFrom({ hook_source: "bash-pre", agent: "my-private-agent" }), false);
  });

  it("rows without hook evidence carry no agent column rather than a guessed main", () => {
    assert.equal("agent" in dimensionsFrom({ hook_source: "mcp" }), false);
  });
});
