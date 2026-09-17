import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TOOL_DEFS } from "../src/tool-defs.js";

/**
 * Drift gate: every tool must exist on BOTH MCP surfaces (#576).
 *
 * The daemon serves tools two ways, from two separate lists:
 *
 *   - `ALL_TOOL_DEFS` (tool-defs.ts) — what `GET /tools` returns, and what the
 *     forwarder falls back to.
 *   - the `ListToolsRequestSchema` handler in `index.ts` — the embedded stdio
 *     server, which spreads its own set of arrays.
 *
 * A tool added to only the first one works through the forwarder and simply
 * does not exist over stdio: no error, no warning, just absent for every client
 * on that transport. That happened while building `find_code` and was caught by
 * review rather than by a test, which is the wrong way round for a mistake this
 * silent and this easy to repeat.
 *
 * So this reads the handler's source and checks that the two agree. Reading
 * source rather than booting an MCP server is deliberate: the failure being
 * guarded against is a MISSING REGISTRATION, which is visible in the source and
 * would cost a full server start to observe at runtime. The CLI drift gates in
 * this suite (`cli-help`, `cli-completion`, `cli-flag-validation`) parse
 * `cli.ts` the same way, for the same reason.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = join(HERE, "..", "src", "index.ts");

/**
 * The tool-group identifiers mentioned inside the stdio ListTools handler.
 *
 * Matched as bare identifiers rather than as `...name`, because a group can be
 * spread conditionally — `...(DOCUMENT_WRITE_ENABLED ? documentWriteTools : [])`
 * is a registration too. A gate that only understood the unconditional form
 * would report that one as missing, which is a false alarm about working code
 * and exactly the kind of noise that gets a gate switched off.
 */
async function stdioToolArrays(): Promise<string[]> {
  const source = await readFile(INDEX_TS, "utf8");
  // The HANDLER, not the import of the same name at the top of the file.
  // Anchoring on the bare symbol matched the import, which made the "block"
  // span almost the whole file — and a gate that reads the whole file finds
  // every identifier and can never fail. Verified by deleting the
  // registration and watching this go red.
  const start = source.indexOf("setRequestHandler(ListToolsRequestSchema");
  assert.notEqual(start, -1, "could not find the stdio ListTools handler in index.ts");
  const end = source.indexOf("}));", start);
  assert.notEqual(end, -1, "could not find the end of the stdio ListTools handler");
  // Comments are stripped first. The block carries a comment that NAMES this
  // very problem, and a gate that counted a mention in prose as a registration
  // would pass on exactly the file it is meant to police.
  const block = stripComments(source.slice(start, end));
  return [...block.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]!);
}

/** Source with `//` and block comments removed. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** The spread array names inside ALL_TOOL_DEFS. */
async function canonicalToolArrays(): Promise<string[]> {
  const source = await readFile(join(HERE, "..", "src", "tool-defs.ts"), "utf8");
  const start = source.indexOf("export const ALL_TOOL_DEFS");
  assert.notEqual(start, -1);
  const end = source.indexOf("];", start);
  const block = source.slice(start, end);
  return [...block.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]!);
}

test("every tool group in ALL_TOOL_DEFS is also served over stdio", async () => {
  const canonical = await canonicalToolArrays();
  const stdio = await stdioToolArrays();

  assert.ok(canonical.length > 0, "ALL_TOOL_DEFS should spread at least one group");

  const missing = canonical.filter((name) => !stdio.includes(name));
  assert.deepEqual(
    missing,
    [],
    `these tool groups are in ALL_TOOL_DEFS but not in the stdio ListTools handler, ` +
      `so they are invisible to stdio clients: ${missing.join(", ")}. ` +
      `Add them to the handler in index.ts.`,
  );
});

test("code awareness is registered on both surfaces", async () => {
  // The concrete case the gate was written for.
  const stdio = await stdioToolArrays();
  const canonical = await canonicalToolArrays();
  assert.ok(canonical.includes("codeTools"), "codeTools missing from ALL_TOOL_DEFS");
  assert.ok(stdio.includes("codeTools"), "codeTools missing from the stdio ListTools handler");
});

test("every tool in ALL_TOOL_DEFS has a CallTool branch in the stdio server", async () => {
  // ListTools advertising a tool the CallTool chain cannot dispatch is the
  // other half of the same mistake: the client sees it and every call fails.
  const source = await readFile(INDEX_TS, "utf8");
  const undispatched = (ALL_TOOL_DEFS as Array<{ name: string }>)
    .map((def) => def.name)
    .filter((name) => !source.includes(`name === "${name}"`));

  assert.deepEqual(
    undispatched,
    [],
    `advertised over stdio but never dispatched there: ${undispatched.join(", ")}`,
  );
});
