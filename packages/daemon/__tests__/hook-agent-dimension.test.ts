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
    assert.equal(hookAgent(null), "main");
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
