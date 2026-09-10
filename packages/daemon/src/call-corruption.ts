/**
 * Detect the Claude/MCP failure where native JSON tool arguments switch into
 * legacy XML inside the first multiline string. The lost siblings never reach
 * Zod, so a generic "received undefined" message sends the model into a retry
 * loop. Detection is deliberately narrow: required fields must be absent and
 * the surviving string must contain structural tags for at least two of them.
 *
 * #482: this is a TRANSPORT failure, not a save failure — it hits every tool
 * with more than one parameter in exactly the same way. `save_memory` is only
 * where it was noticed, because it has the most parameters and the longest
 * values. The expected fields therefore come in as an argument, taken from
 * each tool's own `inputSchema.required`, so a new tool is covered without
 * anyone remembering to add it.
 *
 * The narrowness is the load-bearing part: a false positive here would mask a
 * genuine validation error, which is worse than the generic message.
 */

export interface CallCorruption {
  missing: string[];
  swallowed: string[];
  container: string;
}

const tagFor = (field: string): RegExp =>
  new RegExp(`(?:<|&lt;)\\/?${field}(?:\\s|>|&gt;)|(?:<|&lt;)parameter\\s+name=["']${field}["']`, "i");

/**
 * The EXPLICIT wrapper — `<parameter name="body">` — as opposed to a bare
 * `<body>` tag.
 *
 * 08.09.2026: the `>= 2` rule below missed the case that actually cost a save.
 * Only ONE field (`body`) was swallowed; `topic_path`, `tags` and `recall_when`
 * arrived as proper JSON, so Zod reported a single anonymous "received
 * undefined" and the model retried three times against a call that could never
 * succeed. Two swallowed fields were never the signal — the ambiguity the
 * threshold guarded against lives in the BARE tag form, where `<body>` can
 * plausibly occur inside real prose (an HTML snippet, a code sample). The
 * explicit `<parameter name="...">` form cannot: it names a field the call is
 * missing, in the exact shape the transport produces. One of those is proof.
 */
const parameterWrapperFor = (field: string): RegExp =>
  new RegExp(`(?:<|&lt;)parameter\\s+name=["']${field}["']\\s*(?:>|&gt;)`, "i");

export function detectCallCorruption(raw: unknown, requiredFields: readonly string[]): CallCorruption | null {
  if (requiredFields.length === 0) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const args = raw as Record<string, unknown>;
  const missing = requiredFields.filter((field) => args[field] === undefined);
  if (missing.length === 0) return null;
  for (const [container, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const wrapped = missing.filter((field) => parameterWrapperFor(field).test(value));
    if (wrapped.length >= 1) return { missing: [...missing], swallowed: wrapped, container };
    const swallowed = missing.filter((field) => tagFor(field).test(value));
    if (swallowed.length >= 2) return { missing: [...missing], swallowed, container };
  }
  return null;
}

export function callCorruptionMessage(
  tool: string,
  corruption: CallCorruption,
  /** A read tool writes nothing, so claiming "nothing was saved" there would be
   *  its own small lie. Taken from the tool's own `annotations.readOnlyHint`. */
  readOnly = false,
): string {
  const nothingHappened = readOnly ? "THE CALL DID NOT RUN." : "NOTHING WAS SAVED.";
  return (
    `${tool} arguments were corrupted before validation: ${corruption.swallowed.join(", ")} ` +
    `were embedded as XML inside '${corruption.container}' instead of arriving as JSON properties ` +
    `(missing required fields: ${corruption.missing.join(", ")}). ${nothingHappened} ` +
    `This is a caller-side MCP serialization failure, not a vault or schema rejection. ` +
    `STOP retrying this call in the current session; start a fresh client session, update the client if possible, and retry once.`
  );
}

/** `inputSchema.required` of a tool definition, or an empty list. */
export function requiredFieldsOf(def: { inputSchema?: Record<string, unknown> } | undefined): string[] {
  const required = def?.inputSchema?.required;
  return Array.isArray(required) ? required.filter((f): f is string => typeof f === "string") : [];
}

/**
 * The boundary check: resolve the tool's own required fields once, then throw
 * the honest diagnosis instead of letting Zod report anonymous "received
 * undefined" lines. Returns silently for unknown tools and for anything that
 * does not match the narrow shape.
 */
export function assertCallNotCorrupted(
  tool: string,
  args: unknown,
  defs: ReadonlyMap<string, { required: readonly string[]; readOnly: boolean }>,
): void {
  const def = defs.get(tool);
  if (!def) return;
  const corruption = detectCallCorruption(args, def.required);
  if (corruption) throw new Error(callCorruptionMessage(tool, corruption, def.readOnly));
}

/**
 * The boundary as it now behaves: repair first, diagnose only what is really
 * gone (08.09.2026).
 *
 * Returns the arguments to run with — the originals when nothing was wrong, the
 * repaired ones when the framing could be undone. Throws the diagnosis only
 * when the content itself did not survive the transport, which is the case the
 * message was written for.
 *
 * `onRepair` reports a repair to the daemon log. It stays visible on purpose:
 * a silently patched-up call would hide a client bug that is worth fixing at
 * its source.
 */
export function recoverCallArguments(
  tool: string,
  args: unknown,
  defs: ReadonlyMap<string, { required: readonly string[]; readOnly: boolean }>,
  onRepair: (tool: string, corruption: CallCorruption) => void = defaultRepairNotice,
): unknown {
  const def = defs.get(tool);
  if (!def) return args;
  const corruption = detectCallCorruption(args, def.required);
  if (!corruption) return args;
  const repaired = repairCallCorruption(args, corruption);
  if (repaired) {
    onRepair(tool, corruption);
    return repaired;
  }
  throw new Error(callCorruptionMessage(tool, corruption, def.readOnly));
}

function defaultRepairNotice(tool: string, corruption: CallCorruption): void {
  console.error(
    `[bastra-recall] ${tool}: recovered ${corruption.swallowed.join(", ")} from XML embedded in ` +
      `'${corruption.container}' — the client sent legacy XML instead of JSON arguments`,
  );
}

/**
 * Repair, not just diagnose (08.09.2026).
 *
 * The diagnosis above tells the model to stop retrying — correct, but the save
 * is still lost, and on 08.09. that cost a researched finding the user had
 * asked to keep. Nothing about it was unrecoverable: the swallowed `body`
 * arrived in full, glued onto `summary` behind `</summary>` and its own
 * `<parameter name="body">` opener. The transport mangled the framing, not the
 * content.
 *
 * So the framing is undone here. The container splits at the earlier of its own
 * closing tag and the first `<parameter …>` opener; everything after is read as
 * the parameter blocks the client failed to emit as JSON.
 *
 * Deliberate limits, because a wrong repair writes wrong memory:
 *   - Only fields the call is MISSING are filled. An argument that arrived is
 *     never overwritten by something parsed out of prose.
 *   - A value that parses as JSON array/object becomes that (`tags` and friends
 *     are not strings); anything else stays the string it is, and Zod still has
 *     the last word.
 *   - Returns null unless EVERY missing field came back. A half-repair would
 *     save a memory with holes, which is worse than the honest failure.
 */
export function repairCallCorruption(
  raw: unknown,
  corruption: CallCorruption,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const args = raw as Record<string, unknown>;
  const value = args[corruption.container];
  if (typeof value !== "string") return null;

  const closing = value.search(new RegExp(`(?:<|&lt;)/${corruption.container}\\s*(?:>|&gt;)`, "i"));
  const firstOpener = value.search(/(?:<|&lt;)parameter\s+name=["'][^"']+["']\s*(?:>|&gt;)/i);
  if (firstOpener < 0) return null;
  const cut = closing >= 0 ? Math.min(closing, firstOpener) : firstOpener;

  const blocks = /(?:<|&lt;)parameter\s+name=["']([^"']+)["']\s*(?:>|&gt;)/gi;
  const tail = value.slice(cut);
  const found: { field: string; opensAt: number; valueFrom: number }[] = [];
  for (let m = blocks.exec(tail); m !== null; m = blocks.exec(tail)) {
    found.push({ field: m[1]!, opensAt: m.index, valueFrom: m.index + m[0].length });
  }
  if (found.length === 0) return null;

  const repaired: Record<string, unknown> = { ...args };
  repaired[corruption.container] = value.slice(0, cut).trimEnd();
  for (const [i, block] of found.entries()) {
    if (!corruption.missing.includes(block.field)) continue;
    // A block ends where the next one opens — or at the end of the tail for the
    // last one, which is how the 08.09. case arrived: the closing `</parameter>`
    // never made it either.
    const end = i + 1 < found.length ? found[i + 1]!.opensAt : tail.length;
    const body = tail
      .slice(block.valueFrom, end)
      .replace(/(?:<|&lt;)\/parameter\s*(?:>|&gt;)\s*$/i, "")
      .trim();
    // An opener with nothing behind it recovered nothing. Leaving the field
    // undefined lets the completeness check below fail the repair, which is the
    // point: an empty body is not a rescued memory.
    if (body.length === 0) continue;
    repaired[block.field] = coerceRepairedValue(body);
  }

  const stillMissing = corruption.missing.filter((field) => repaired[field] === undefined);
  return stillMissing.length === 0 ? repaired : null;
}

/** A recovered `tags` is a list, not the text `["a","b"]`. Anything that is not
 *  valid JSON array/object notation stays the string it was. */
function coerceRepairedValue(text: string): unknown {
  const looksStructured = /^[[{]/.test(text) && /[\]}]$/.test(text);
  if (!looksStructured) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
