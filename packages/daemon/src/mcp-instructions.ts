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
  "candidates — call `load_memory` only for the hits you actually need.";
