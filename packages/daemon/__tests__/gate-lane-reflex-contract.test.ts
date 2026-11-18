import { strict as assert } from "node:assert";
import test from "node:test";
import type { Memory, Vault } from "@bastra-recall/core";
import { actionContext, actionReflexPool, cachedActionReflexPool, MAX_ACTION_CONTEXT_CHARS } from "../src/gate-lane.js";

test("gate action context preserves field order and bytes while excluding non-action input", () => {
  assert.equal(
    actionContext("mcp__fixture__send_message", {
      command: " command ",
      query: " query ",
      path: " path ",
      notebook_path: " notebook ",
      file_path: " file ",
      content: "ignored",
      new_string: "ignored",
    }),
    "mcp__fixture__send_message\nsend_message\n file \n notebook \n path \n query \n command "
  );
  assert.equal(actionContext("Bash", { file_path: "  ", path: 42, query: null, command: "" }), "Bash");
  const longCommand = "x".repeat(MAX_ACTION_CONTEXT_CHARS);
  assert.equal(actionContext("Bash", { command: longCommand }), `Bash\n${longCommand}`.slice(0, 8191));
});

test("gate pool preserves eligible identities and isolates cache invalidation per vault", () => {
  const rule = (id: string, salience: number): Memory =>
    ({ fm: { id, recall_mode: "reflex", write_origin: "user-directed", salience }, body: "" }) as Memory;
  const first = rule("first", 0.8);
  const second = rule("second", 0.9);
  assert.deepEqual(actionReflexPool([first, rule("weak", 0.79), second]), [first, second]);
  assert.equal(actionReflexPool([first])[0], first);
  let invalidate: (() => void) | undefined;
  let watches = 0;
  let lists = 0;
  const vault = {
    list: () => {
      lists++;
      return [first];
    },
    on: (listener: () => void) => {
      watches++;
      invalidate = listener;
    },
  } as unknown as Vault;
  const other = { list: () => [second], on: () => {} } as unknown as Vault;
  const initial = cachedActionReflexPool(vault);
  const otherInitial = cachedActionReflexPool(other);
  assert.equal(cachedActionReflexPool(vault), initial);
  invalidate!();
  const rebuilt = cachedActionReflexPool(vault);
  assert.notEqual(rebuilt, initial);
  assert.equal(rebuilt[0], first);
  assert.equal(cachedActionReflexPool(other), otherInitial);
  invalidate!();
  cachedActionReflexPool(vault);
  assert.equal(watches, 1);
  assert.equal(lists, 3);
});
