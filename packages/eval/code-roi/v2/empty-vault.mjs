/**
 * What the memory and document half of arm B's MCP surface answers — the
 * PRODUCT's own shapes over an empty vault, not stand-ins (#582 review, #595).
 *
 * The first version of these stubs answered `{ status: "ok", hits: [], note:
 * "No memories in this vault yet." }`. No product response carries `status` or
 * `note` at all, so an agent that had ever seen bastra-recall could tell it was
 * not talking to it — and the first thing an agent does with a surface it
 * distrusts is stop using the rest of it, which is exactly the observation arm
 * B exists to make. The second version built `recall` by hand from four
 * fields and was still distinguishable (#595): the product's answer leads with
 * `query` and carries the score space (`score_kind`, `score_arms`,
 * `score_version`) even when the vault is empty.
 *
 * So `recall` is no longer built here. The empty-vault payload is pushed
 * through `projectRecallResult`, the daemon's own projection the MCP
 * forwarder applies to every answer, with the score-space fields taken from
 * the daemon's `score-space.js`. The two shapes cannot drift apart again: a
 * field the product adds to its projection is added here by the same code.
 *
 * `find_document` answers with `docs_indexed: 0` — the field the tool
 * description tells the agent to read — and a lookup by id with the handler's
 * own `memory not found: <id>` / `document not found: <id>`.
 *
 * WRITE tools answer with the product's own `toolSurfaceDenial` for the
 * `search` surface. Three candidates were weighed, on one criterion: which one
 * makes an agent behave least differently?
 *   - A faked success would have to invent an id, a file_path and an audit_id
 *     for a memory no vault holds; a follow-up `load_memory` would then
 *     contradict it, which is a worse surface than any refusal.
 *   - A "not available in this measurement" note is honest but tells the agent
 *     it is being measured, and that is the one thing an arm must not learn.
 *   - The surface denial is an ORDINARY product condition: `search` is a real
 *     tool surface on which every write tool is denied in exactly these words
 *     and on which `find_affected_files` is explicitly allowed (tool-defs.ts).
 *     It names its own cause, says not to retry, and casts no doubt on the
 *     code tools. That is the one chosen.
 */
import { randomUUID } from "node:crypto";

const DAEMON_DIST = new URL("../../../daemon/dist/", import.meta.url);
const { projectRecallResult } = await import(new URL("recall-batch.js", DAEMON_DIST).pathname);
const { armsOf, currentScoreVersion } = await import(new URL("score-space.js", DAEMON_DIST).pathname);
const { toolSurfaceDenial } = await import(new URL("tool-defs.js", DAEMON_DIST).pathname);

const EMPTY_VAULT_SURFACE = "search";

/**
 * The payload `/hook/recall` assembles for an empty vault, field for field as
 * `assembleHookRecallPayload` emits it when there is nothing to rank: no hits,
 * so no honesty flags; the dense arm available, so the fused score space with
 * its version; no project filter and no budget cut, so neither of their
 * fields. The arm never sees this object — only its projection below.
 */
export function emptyVaultRecallPayload() {
  return {
    hits: [],
    vault_size: 0,
    latency_ms: 0,
    recall_id: randomUUID(),
    score_kind: "rrf",
    score_arms: armsOf({ hybridActive: true, commonsFused: false }),
    score_version: currentScoreVersion(),
  };
}

export function emptyVaultAnswer(name, args) {
  const id = typeof args?.id === "string" ? args.id : "";
  switch (name) {
    case "recall":
      return projectRecallResult(String(args?.query ?? ""), emptyVaultRecallPayload());
    case "find_document":
      return { query: String(args?.query ?? ""), docs_indexed: 0, hits: [] };
    case "load_memory":
      return { error: `memory not found: ${id}` };
    case "read_document":
    case "open_document":
      return { error: `document not found: ${id}` };
    default:
      return { error: toolSurfaceDenial(name, EMPTY_VAULT_SURFACE) };
  }
}
