/**
 * #448 — one request type for every lane's `/hook/recall` body. The guarantee
 * is a compile-time one, so this file is mostly for `npm run check:types`: a
 * body without `hook_source` or without an identity field must not compile.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hookCaller, type HookRecallRequest } from "../src/hook-surface.js";

const base = { query: "q", topics: [], project: null, tool_name: "Bash", k: 3 };

test("#448: a lane body carries the identity fields and its hook_source", () => {
  const body: HookRecallRequest = {
    ...base,
    ...hookCaller({ session_id: "s", bastra_client: "claude-code" }),
    hook_source: "bash-pre",
  };
  assert.equal(body.session_id, "s");
  assert.equal(body.hook_source, "bash-pre");

  // @ts-expect-error — hook_source is required.
  const noSource: HookRecallRequest = { ...base, ...hookCaller({}) };
  // @ts-expect-error — the identity fields are required (client, agent).
  const noIdentity: HookRecallRequest = { ...base, session_id: null, hook_source: "x" };
  assert.ok(noSource && noIdentity);
});
