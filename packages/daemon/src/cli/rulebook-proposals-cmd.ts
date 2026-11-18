/** Chat decisions use the same explicit user-direction attestation as MCP.
 * A CLI invocation is not independent proof of a human's consent. */
import { getJson } from "../prompt-loopback.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { projectForFilter } from "../scope-filter.js";
import { getApiToken } from "../settings.js";
import { DAEMON_VERSION } from "../version.js";
import { usageWords } from "./usage-words.js";

/** Older daemons may ignore dry_run; check their served schema before any write. */
async function requireSavePreviewSupport(): Promise<void> {
  const listed = await getJson<{
    tools?: { name?: string; inputSchema?: { properties?: { dry_run?: { type?: string } } } }[];
  }>(resolveDaemonEndpoint().baseUrl, "/tools?surface=write", 2000);
  const save = Array.isArray(listed?.tools) && listed.tools.find((entry) => entry.name === "save_memory");
  if (!save || save.inputSchema?.properties?.dry_run?.type !== "boolean") {
    throw new Error("daemon does not advertise save_memory dry_run support; nothing was sent to save_memory");
  }
}

export async function rulebookCliCall(
  tool:
    | "list_rules"
    | "load_memory"
    | "edit_memory"
    | "review_save_suggestion"
    | "restore_memory"
    | "recall"
    | "save_memory",
  input: unknown
): Promise<any> {
  if (tool === "save_memory" && (input as { dry_run?: unknown } | null)?.dry_run === true) {
    await requireSavePreviewSupport();
  }
  const token = process.env.BASTRA_API_TOKEN || (await getApiToken());
  const response = await fetch(`${resolveDaemonEndpoint().baseUrl}/api/v1/${tool}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `bastra-cli/${DAEMON_VERSION}`,
      "x-bastra-project": encodeURIComponent(projectForFilter(process.cwd()) ?? ""),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10000),
  });
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export async function cmdRulebookProposals(words: string[], dryRun: boolean): Promise<number> {
  try {
    const [operation, id, revision, origin, ...extra] = words;
    if (!["proposals", "confirm", "reject"].includes(operation)) throw new Error("Unknown rulebook proposal operation");
    if (operation === "proposals") {
      if (id) throw new Error((await usageWords()).rulesProposals);
      const proposals = [];
      let cursor: string | undefined;
      do {
        const page = await rulebookCliCall("list_rules", { proposals: true, ...(cursor ? { cursor } : {}) });
        if (page.restarted) throw new Error("Proposal list changed; run bastra rules proposals again.");
        for (const rule of page.rules) proposals.push(await rulebookCliCall("load_memory", { id: rule.id }));
        cursor = page.next_cursor;
      } while (cursor);
      process.stdout.write(JSON.stringify({ proposals }, null, 2) + "\n");
      return 0;
    }
    if (!id || !revision || origin !== "user-directed" || extra.length) {
      throw new Error((await usageWords()).rulesDecide);
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
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
