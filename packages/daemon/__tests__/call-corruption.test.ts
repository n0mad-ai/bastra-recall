/**
 * #482: the corrupted-arguments diagnosis is for every tool, not just saves.
 *
 * When a client turns its native JSON arguments into legacy XML inside the
 * first multiline string, the sibling parameters never arrive. That is a
 * transport failure — it hits `recall` and `read_document` exactly like
 * `save_memory`, which is only where it was noticed because it has the most
 * parameters. Before this, every other tool still answered with anonymous
 * "received undefined" lines and the model retried into the wall.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/call-corruption.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertCallNotCorrupted,
  callCorruptionMessage,
  detectCallCorruption,
  recoverCallArguments,
  repairCallCorruption,
  requiredFieldsOf,
} from "../src/call-corruption.js";
import { TOOL_ARG_EXPECTATIONS } from "../src/tool-defs.js";
import { dispatchApi } from "../src/http-api-routes.js";

/** A `move_document` call the client turned into XML. */
const CORRUPTED_MOVE = {
  id: "doc-1</id><folder_path>Rechnungen</folder_path><title>Beleg</title>",
};

test("every declared tool contributes its own required fields", () => {
  const recall = TOOL_ARG_EXPECTATIONS.get("recall");
  assert.deepEqual(recall?.required, ["query"]);
  assert.equal(recall?.readOnly, true);

  const save = TOOL_ARG_EXPECTATIONS.get("save_memory");
  assert.ok((save?.required.length ?? 0) >= 8, "save_memory keeps its full required list");
  assert.equal(save?.readOnly, false);
  // The point of deriving it: nothing here is hand-maintained.
  assert.ok(TOOL_ARG_EXPECTATIONS.size >= 5, "all tool definitions are covered");
});

test("a corrupted call to a tool other than save_memory gets the same diagnosis", async () => {
  await assert.rejects(
    dispatchApi("save_product_doc", {
      project: "buzz</project><area>hints</area><title>T</title><summary>S</summary><body>B</body>",
    }, { toolDeps: {} as never, documentWriteEnabled: false, ccSessionId: null }),
    (err: Error) =>
      err.message.includes("save_product_doc arguments were corrupted before validation")
      && err.message.includes("caller-side MCP serialization failure")
      && err.message.includes("STOP retrying"),
  );
});

test("the same holds for the other multi-field write tool", () => {
  assert.throws(
    () => assertCallNotCorrupted("save_document", {
      original_path: "/tmp/a.pdf</original_path><title>T</title><tags><item>x</item></tags><category>rechnungen</category>",
    }, TOOL_ARG_EXPECTATIONS),
    /save_document arguments were corrupted before validation/,
  );
});

/**
 * The honest limit of this change, pinned so nobody reads more into it.
 *
 * The detector needs structural tags for at least TWO MISSING required fields
 * — the rule that keeps it from masking real validation errors. A tool with a
 * SINGLE required field can therefore never trigger it, however corrupted the
 * call is: `recall`, `load_memory`, `find_document`, `read_document`,
 * `archive_memory`, `open_document`, `recategorize_document` — including the
 * very tools #482 names as still unhelped. Widening this would mean matching
 * optional properties too, which is a separate decision about false positives,
 * not a fix for this one.
 */
test("tools with a single required field stay out of reach — by construction", () => {
  const oneField = [...TOOL_ARG_EXPECTATIONS.entries()].filter(([, v]) => v.required.length === 1);
  assert.ok(oneField.length > 0);
  for (const [name] of oneField) {
    assert.doesNotThrow(
      () => assertCallNotCorrupted(name, { id: "x</id><query>y</query><scope>z</scope>" }, TOOL_ARG_EXPECTATIONS),
      `${name} cannot be detected with a single required field`,
    );
  }
});

/**
 * Two required fields ARE reachable — the container is any surviving string,
 * not necessarily a required one (`Object.entries(args)`). Pinned because the
 * earlier wording of this file claimed a three-field floor, which promised
 * more than the code delivers (review find, Archie 06.09.).
 */
test("two required fields are reachable when an optional string carries the text", () => {
  const corruption = detectCallCorruption(
    { note: "x</id><folder_path>Rechnungen</folder_path>" },
    ["id", "folder_path"],
  );
  assert.deepEqual(corruption?.swallowed, ["id", "folder_path"]);
  assert.equal(corruption?.container, "note");
});

test("a read tool does not claim that nothing was saved", () => {
  const corruption = detectCallCorruption(
    { query: "a</query><scope>s</scope><type>lesson</type>" },
    ["query", "scope", "type"],
  );
  assert.ok(corruption);
  const message = callCorruptionMessage("recall", corruption!, true);
  assert.match(message, /THE CALL DID NOT RUN/);
  assert.doesNotMatch(message, /NOTHING WAS SAVED/);
});

test("detection stays as narrow as it was — one tag is not enough", () => {
  // Only ONE missing field has a structural tag: a genuine validation error
  // must not be masked by this.
  assert.equal(
    detectCallCorruption({ query: "text with <body>only one</body>" }, ["query", "body", "tags"]),
    null,
  );
  // Nothing missing at all.
  assert.equal(detectCallCorruption({ query: "q", k: 5 }, ["query"]), null);
  // A plain missing field, no XML anywhere: Zod's own error is the right answer.
  assert.equal(detectCallCorruption({ query: "q" }, ["query", "scope", "type"]), null);
  // Not an object.
  assert.equal(detectCallCorruption("string", ["query"]), null);
  // A tool with no required fields can never be corrupted by this shape.
  assert.equal(detectCallCorruption({ a: "<b>x</b><c>y</c>" }, []), null);
});

test("an unknown tool is left to the dispatcher's own 404", () => {
  assert.doesNotThrow(() => assertCallNotCorrupted("not_a_tool", CORRUPTED_MOVE, TOOL_ARG_EXPECTATIONS));
});

test("requiredFieldsOf survives a definition without a schema", () => {
  assert.deepEqual(requiredFieldsOf(undefined), []);
  assert.deepEqual(requiredFieldsOf({ inputSchema: {} }), []);
  assert.deepEqual(requiredFieldsOf({ inputSchema: { required: ["a", 2, "b"] } }), ["a", "b"]);
});

/**
 * 08.09.2026 — the case that cost a save. Only `body` was swallowed; every
 * other required field arrived as proper JSON, so the `>= 2` rule never fired
 * and Zod answered with one anonymous "received undefined". The model retried
 * three times, hit the failure cap and reported the loss to the user.
 *
 * The shape below is the real one from that call: the summary ends, its own
 * closing tag follows, then the client's `<parameter name="body">` opener with
 * the full body behind it — and no closing tag at all.
 */
const SWALLOWED_BODY = {
  title: "Daniels Bewerbungs-Engpass",
  type: "user-preference",
  scope: "user-preference",
  summary:
    "Befund aus 43 geprüften Firmen: KEINE verlangt ein Studium.</summary>\n" +
    '<parameter name="body">Breite Arbeitgeberrecherche am 08.09.2026.\n\n' +
    "**Der zentrale Befund:** Kein Kandidat verlangte ein Studium.",
  topic_path: ["user-preference", "bewerbung"],
  tags: ["bewerbung"],
  recall_when: ["Bewerbung vorbereiten"],
};

const SAVE_REQUIRED = TOOL_ARG_EXPECTATIONS.get("save_memory")!.required;

test("a single swallowed field is detected when it arrives in the explicit wrapper", () => {
  const corruption = detectCallCorruption(SWALLOWED_BODY, SAVE_REQUIRED);
  assert.deepEqual(corruption?.swallowed, ["body"]);
  assert.deepEqual(corruption?.missing, ["body"]);
  assert.equal(corruption?.container, "summary");
});

test("and the swallowed body is recovered whole, with the summary trimmed back", () => {
  const corruption = detectCallCorruption(SWALLOWED_BODY, SAVE_REQUIRED)!;
  const repaired = repairCallCorruption(SWALLOWED_BODY, corruption)!;
  assert.equal(repaired.summary, "Befund aus 43 geprüften Firmen: KEINE verlangt ein Studium.");
  assert.equal(
    repaired.body,
    "Breite Arbeitgeberrecherche am 08.09.2026.\n\n**Der zentrale Befund:** Kein Kandidat verlangte ein Studium.",
  );
  // Fields that arrived correctly are untouched.
  assert.deepEqual(repaired.tags, ["bewerbung"]);
  assert.deepEqual(repaired.topic_path, ["user-preference", "bewerbung"]);
});

test("the boundary hands the repaired arguments on instead of throwing", () => {
  const seen: string[] = [];
  const out = recoverCallArguments("save_memory", SWALLOWED_BODY, TOOL_ARG_EXPECTATIONS, (tool, c) =>
    seen.push(`${tool}:${c.swallowed.join(",")}`),
  ) as Record<string, unknown>;
  assert.equal(typeof out.body, "string");
  assert.deepEqual(seen, ["save_memory:body"], "a repair is reported, never silent");
});

test("several swallowed fields are split at the block boundaries, lists stay lists", () => {
  const args = {
    title: "T",
    type: "lesson",
    scope: "s",
    summary:
      'S.</summary>\n<parameter name="body">B1\nB2</parameter>\n' +
      '<parameter name="tags">["a","b"]</parameter>\n' +
      '<parameter name="topic_path">["x"]</parameter>\n' +
      '<parameter name="recall_when">["wenn X"]</parameter>',
  };
  const corruption = detectCallCorruption(args, SAVE_REQUIRED)!;
  const repaired = repairCallCorruption(args, corruption)!;
  assert.equal(repaired.summary, "S.");
  assert.equal(repaired.body, "B1\nB2");
  assert.deepEqual(repaired.tags, ["a", "b"]);
  assert.deepEqual(repaired.topic_path, ["x"]);
  assert.deepEqual(repaired.recall_when, ["wenn X"]);
});

test("a half-repair is no repair — the honest diagnosis still wins", () => {
  // The opener is there, the content behind it is not: nothing to recover.
  const args = {
    title: "T",
    type: "lesson",
    scope: "s",
    summary: 'S.</summary>\n<parameter name="body">',
    topic_path: ["x"],
    tags: ["a"],
    recall_when: ["w"],
  };
  const corruption = detectCallCorruption(args, SAVE_REQUIRED)!;
  assert.equal(repairCallCorruption(args, corruption), null, "an empty body is not a recovery");
  assert.throws(
    () => recoverCallArguments("save_memory", args, TOOL_ARG_EXPECTATIONS, () => undefined),
    /NOTHING WAS SAVED/,
  );
});

test("a clean call passes through the boundary unchanged", () => {
  const clean = { query: "was ist der stand", k: 3 };
  assert.equal(recoverCallArguments("recall", clean, TOOL_ARG_EXPECTATIONS, () => undefined), clean);
});
