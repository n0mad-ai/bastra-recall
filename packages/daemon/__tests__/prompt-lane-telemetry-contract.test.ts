import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPromptLane } from "../src/prompt-lane.js";
import { loadSessionState } from "../src/session-state.js";
import type { PromptHookTelemetry } from "../src/prompt-lane-telemetry.js";
import { telemetrySession } from "../src/telemetry-session.js";

for (const scenario of ["trivial", "system"] as const) {
  test(`prompt telemetry contract: ${scenario} persists before callback and preserves bookings`, async () => {
    const root = await mkdtemp(join(tmpdir(), "bastra-prompt-contract-"));
    const env = { BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: root, BASTRA_HOOK_STATE_DIR: root };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      const rows: PromptHookTelemetry[] = [];
      const stdout = await runPromptLane(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "telemetry-contract",
          cwd: root,
          prompt: scenario === "trivial" ? "ok" : "<task-notification><task-id>t1</task-id></task-notification>",
        },
        null,
        "http://127.0.0.1:1",
        () => "skipped-no-provider",
        undefined,
        {
          onTelemetry(row) {
            const files = readdirSync(root).filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"));
            const persisted = files.flatMap((name) =>
              readFileSync(join(root, name), "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
            );
            const event = persisted.find((entry) => entry.kind === "prompt_hook_call");
            assert.ok(event, "the row must already be persisted when the callback runs");
            const { client: _client, agent: _agent, session_id: _session, ...fields } = row;
            for (const [key, value] of Object.entries(fields)) {
              if (value !== undefined) assert.deepEqual(event[key], value, key);
            }
            assert.equal(event.session_id, telemetrySession("telemetry-contract"));
            assert.equal(event.dimensions.client, "unknown");
            assert.equal(event.dimensions.hook_source, "prompt");
            rows.push(row);
          },
        }
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].prewarm, "skipped-no-provider");
      const state = await loadSessionState("telemetry-contract");
      assert.equal(stdout, "{}");
      assert.equal(rows[0].hint_tokens_est, 0);
      assert.equal(rows[0].status, "gated");
      assert.equal(rows[0].origin, scenario === "system" ? "system" : undefined);
      assert.deepEqual(state.shown, {});
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
