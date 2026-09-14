/**
 * Server instructions (MCP InitializeResult.instructions): loaded into the
 * model's context at session start by Claude Code (official channel, works
 * like a skill description); currently ignored by Claude Desktop, but free
 * to ship and live the day Anthropic wires it up. Kept compact — in Claude
 * Code the skill + hooks already carry the long form.
 *
 * Own module since #472/#473: this is one of four surfaces that grant recall
 * and save authority (skill, recall/save_memory tool descriptions, session
 * context inject are the others). It lived inline in mcp-forwarder.ts and was
 * therefore compared against nothing. The policy it states is the canonical
 * proactive one — recall before acting, save durable facts without being
 * asked — and `recall-policy-parity.test.ts` fails loudly when this text
 * drifts away from the other three.
 */
export const SERVER_INSTRUCTIONS =
  "bastra-recall is the user's persistent local memory, not a general search engine. Call `recall` only " +
  "when the answer depends on a durable fact from the user's past that is missing from the current prompt " +
  "and from the named live source, or when the user explicitly asks to search their memory/history. Do not " +
  "call it for generic knowledge, troubleshooting from a supplied log, opinions, current code/repository " +
  "state, URLs, uploads, or facts available by reading the live artifact. Use at most ONE recall call per " +
  "user turn; put genuinely distinct memory questions into that call via `queries: [...]`. A weak or " +
  "irrelevant result ends the memory branch — do not retry with paraphrases. For personal historical or " +
  "document lookup, use `recall` and then `find_document` before chat or web search. " +
  "When the user states a durable rule or preference, finalizes a decision, or a hard-won fix " +
  "lands, save it via `save_memory` immediately and acknowledge in one short line. recall returns lean " +
  "candidates — call `load_memory` only for 1-2 hits you actually need. To CHANGE an existing " +
  "memory use `edit_memory` (str_replace / append / frontmatter patch) — never edit a vault file " +
  "directly, and do not re-send a whole body just to add a line. If your harness also carries a " +
  "built-in file-based memory of its own, the vault is still the store: durable facts go through " +
  "`save_memory` here, never into that directory, and a save counts as done only once it landed here.";
