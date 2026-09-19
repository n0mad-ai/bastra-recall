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
  "bastra-recall is the user's persistent local memory. Treat it as YOUR long-term memory and use it " +
  "without being asked: (1) At the start of a conversation and before acting on a task, call `recall` " +
  "with the topic — durable preferences, lessons, decisions and project facts live there. When several " +
  "angles are worth asking in one turn, batch the phrasings into ONE call via `queries: [...]` (2-4) " +
  "instead of firing separate recalls. (2) For ANY " +
  "question about the user's past, projects, documents, people or preferences ('find…', 'where is…', " +
  "'when did I…', 'how much was…'), search `recall` + `find_document` BEFORE any other lookup tool. " +
  "(3) When the user states a durable rule or preference, finalizes a decision, or a hard-won fix " +
  "lands, save it via `save_memory` immediately and acknowledge in one short line. recall returns lean " +
  "candidates — call `load_memory` only for the hits you actually need. (4) To CHANGE an existing " +
  "memory use `edit_memory` (str_replace / append / frontmatter patch) — never edit a vault file " +
  "directly, and do not re-send a whole body just to add a line. (5) If your harness also carries a " +
  "built-in file-based memory of its own, the vault is still the store: durable facts go through " +
  "`save_memory` here, never into that directory, and a save counts as done only once it landed here.";

/**
 * The code-awareness paragraph, appended ONLY for a client whose user has a
 * code graph (#582).
 *
 * Three things it must not do, each learned the hard way:
 *
 *   It must not displace the recall. The memory policy above asks for a recall
 *   before acting on a task; this paragraph slots in AFTER that and before
 *   Grep, so an agent following both does not have to choose.
 *
 *   It must not lead. bastra-recall is the memory first, and these
 *   instructions reach every client — ChatGPT, Codex, a user who never asked
 *   for code awareness. The memory policy above is the product's standing
 *   promise; this is an addition to it, not a replacement.
 *
 *   It must not tell one client's story. In some clients an MCP tool is
 *   DEFERRED — listed, but its schema fetched on demand, and a direct call
 *   fails until it is loaded. In others it is there from the start, and a
 *   lookup for it returns nothing. An earlier version resolved that by
 *   declaring an empty lookup to mean "already loaded", which is only true in
 *   the second kind of client: elsewhere empty can equally mean missing, not
 *   connected, or not permitted. So the text names the two situations and
 *   leaves the mechanics to the client, with one instruction for the case
 *   where the tool really is not there: say so once, use Grep, stop retrying.
 *
 *   It must not be shouted. The memory paragraph states its policy plainly and
 *   this one says no more than it needs to.
 */
export const CODE_AWARENESS_CLAUSE =
  "\n\nCODE. This vault also indexes the user's code, and there is one question the index answers " +
  "better than any text search: what a change would break. When that is the question — before or " +
  "after you edit an exported symbol, when you are handed a diff and asked " +
  "what else must be adapted, when you are asked which files would stop compiling, or which call " +
  "sites you might have missed — call `find_affected_files` with that file after the recall above and " +
  "before any Grep. If your client lists tools but loads their details on demand, load it the way " +
  "that client does; if it is already available, just call it. " +
  "It reads the repository's import and call graph and names the files that may break, including the " +
  "ones reached through a workspace package (`@scope/pkg`), which a grep for the symbol name inside " +
  "the changed package cannot find. Its answer is candidates, not proof: grep them to confirm. " +
  "`find_code` locates a symbol or a file in the same graph, and the same goes for it. Should either " +
  "be genuinely unavailable in this session, say so once and use Grep — do not keep retrying.";

/**
 * The instructions this client gets. The code paragraph is appended only when
 * the user actually has code awareness on: without it both tools answer
 * `unavailable`, and an instruction that sends an agent to a tool which can
 * only say "no graph here" spends its trust for nothing.
 */
export function serverInstructions(codeAwarenessEnabled: boolean): string {
  return codeAwarenessEnabled ? SERVER_INSTRUCTIONS + CODE_AWARENESS_CLAUSE : SERVER_INSTRUCTIONS;
}
