/** Chat decisions use the same explicit user-direction attestation as MCP.
 * A CLI invocation is not independent proof of a human's consent. */
import { rulebookCliCall } from "./helpers.js";
import { rulesCmdWordsIn } from "./rules-cmd-words.js";
import { usageWordsIn } from "./usage-words.js";

/** `language` is language.primary, read once by `bastra rules` (#1602). The
 *  JSON on stdout and the daemon's error texts stay as they are. */
export async function cmdRulebookProposals(words: string[], dryRun: boolean, language: string): Promise<number> {
  const w = rulesCmdWordsIn(language);
  try {
    const [operation, id, revision, origin, ...extra] = words;
    if (!["proposals", "confirm", "reject"].includes(operation)) throw new Error(w.unknownProposalOperation);
    if (operation === "proposals") {
      if (id) throw new Error(usageWordsIn(language).rulesProposals);
      const proposals = [];
      let cursor: string | undefined;
      do {
        const page = await rulebookCliCall("list_rules", { proposals: true, ...(cursor ? { cursor } : {}) });
        if (page.restarted) throw new Error(w.proposalsChanged);
        for (const rule of page.rules) proposals.push(await rulebookCliCall("load_memory", { id: rule.id }));
        cursor = page.next_cursor;
      } while (cursor);
      process.stdout.write(JSON.stringify({ proposals }, null, 2) + "\n");
      return 0;
    }
    if (!id || !revision || origin !== "user-directed" || extra.length) {
      throw new Error(usageWordsIn(language).rulesDecide);
    }
    const input = {
      id,
      expected_revision: revision,
      rulebook_decision: { decision: operation === "confirm" ? "accept" : "reject", write_origin: "user-directed" },
    };
    if (dryRun) {
      process.stdout.write(JSON.stringify({ dry_run: true, tool: "edit_memory", input }) + "\n");
      return 0;
    }
    const result = await rulebookCliCall("edit_memory", input);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(w.proposalError(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
