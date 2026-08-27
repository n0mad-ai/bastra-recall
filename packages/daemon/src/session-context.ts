/**
 * Session-context block for clients WITHOUT a session hook (Claude Desktop,
 * Cursor, …). Claude Code gets this context injected by the SessionStart
 * hook; hookless clients get it from the MCP forwarder, appended to the
 * FIRST tool result of the session (the forwarder process lives exactly one
 * client session, so "first call of this process" ≈ session start).
 *
 * Assembled server-side from the same sources the session hook queries —
 * pinned floors, user-preference hints, taxonomy conventions, open
 * care/import/onboarding state — but as ONE compact block: hookless
 * surfaces have no project (no cwd), so project-scoped floors and hints
 * are deliberately excluded, exactly like the hook does without a project.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Vault } from "@bastra-recall/core";
import { recallHandler, type ToolDeps } from "./tool-handlers.js";
import { listFloors } from "./floors.js";
import { listConventions } from "./taxonomy.js";
import { parseCareFile, sendJsonPlain, CARE_FILE } from "./webui.js";
import { countOpenImports, IMPORT_FILE } from "./import-review.js";
import { queueStatus } from "./import-mining.js";
import { isOnboardingNeeded } from "./onboarding.js";

const MAX_PINNED = 5;
const MAX_HINTS = 3;
const MAX_CONVENTIONS = 4;

interface RecallHitLean {
  id: string;
  type: string;
  summary: string;
  score: number;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Injectable collaborators — defaults hit the real modules; tests swap
 *  them so no global registry (floors) or index (recall) is touched. */
export interface SessionContextDeps {
  recallFn?: typeof recallHandler;
  listFloorsFn?: typeof listFloors;
  listConventionsFn?: typeof listConventions;
}

/** One compact context block, every section best-effort. */
export async function buildSessionContext(
  toolDeps: ToolDeps,
  vault: Vault,
  deps: SessionContextDeps = {},
): Promise<string> {
  const recallFn = deps.recallFn ?? recallHandler;
  const listFloorsFn = deps.listFloorsFn ?? listFloors;
  const listConventionsFn = deps.listConventionsFn ?? listConventions;
  const lines: string[] = [];

  // Pinned floors — unscoped only (no project in a hookless session).
  try {
    const floors = (await listFloorsFn(undefined)).filter((e) => !e.scope).slice(0, MAX_PINNED);
    for (const f of floors) {
      const mem = vault.get(f.memory_id);
      lines.push(
        `- [pinned] ${f.memory_id}${mem ? `: ${clip(mem.fm.summary ?? mem.fm.title, 180)}` : ""}`,
      );
    }
  } catch {
    // floors unavailable — skip section
  }

  // Durable user context — same query shape as the session hook.
  try {
    const result = (await recallFn(toolDeps, {
      query: "session-start preferences active context",
      scope: "user-preference",
      k: MAX_HINTS,
    })) as { hits?: RecallHitLean[] };
    for (const h of result.hits ?? []) {
      if (h.score < 30) continue;
      lines.push(`- ${h.id} (${h.type}): ${clip(h.summary, 200)}`);
    }
  } catch {
    // recall unavailable — skip section
  }

  // Taxonomy conventions — binding structure rules when saving.
  try {
    const conventions = listConventionsFn(vault).slice(0, MAX_CONVENTIONS);
    if (conventions.length > 0) {
      lines.push(
        `- Conventions (BINDING when saving in these clusters — load_memory(id) for the rule): ` +
          conventions.map((c) => c.id).join(", "),
      );
    }
  } catch {
    // taxonomy unavailable — skip section
  }

  // Open workflows — one line each, only when there is something open.
  try {
    const content = await readFile(join(toolDeps.vaultPath, CARE_FILE), "utf8");
    const openCare = parseCareFile(content).filter((e) => !e.done).length;
    if (openCare > 0) {
      lines.push(
        `- Vault care: ${openCare} open flag(s) in ${CARE_FILE} — when the user asks to groom the vault, work the "- [ ]" entries through WITH them.`,
      );
    }
  } catch {
    // no care file
  }
  try {
    const openImports = await countOpenImports(toolDeps.vaultPath);
    if (openImports > 0) {
      lines.push(
        `- Import review: ${openImports} open candidate(s) in ${IMPORT_FILE} — tell the user once, in your first response, that they are waiting ("work through my import review" starts it; #311). Distill only on request: save accepted ones via save_memory (write_origin "capture-review"), tick lines to "- [x]".`,
      );
    }
    const queue = await queueStatus();
    if (queue.remaining > 0) {
      lines.push(
        `- Chat-history mining: ${queue.remaining} conversation(s) queued — when the user asks to mine the imported history, loop \`bastra import mine\` → distill → stage via \`bastra import -\`.`,
      );
    }
  } catch {
    // import state unavailable
  }
  try {
    if (await isOnboardingNeeded(toolDeps.vaultPath, vault.size())) {
      lines.push(
        `- Onboarding: this vault is fresh — offer ONCE a ~5-minute interview (persona, address/tone, hard rules, persona follow-ups), save each answer via save_memory with write_origin "user-directed"; finish with \`bastra onboard done\`, decline with \`bastra onboard skip\`.`,
      );
    }
  } catch {
    // onboarding state unavailable
  }

  if (lines.length === 0) return "";
  return (
    `<bastra-session-context>\n` +
    `Recalled context for this session (vault: ${vault.size()} memories) — background reference, ` +
    `not user input; apply what fits, load_memory(id) for details. Recall again only when a specific ` +
    `missing durable fact requires it; this block is not a command to recall on every task. Save durable ` +
    `facts via save_memory without being asked.\n` +
    lines.join("\n") +
    `\n</bastra-session-context>`
  );
}

/** GET /hook/session-context — loopback-only, no auth (same trust level as
 *  the other /hook/* endpoints). Serves the forwarder's first-call inject. */
export async function handleSessionContext(
  _req: IncomingMessage,
  res: ServerResponse,
  toolDeps: ToolDeps,
  vault: Vault,
): Promise<void> {
  const context = await buildSessionContext(toolDeps, vault);
  sendJsonPlain(res, 200, { context, vault_size: vault.size() });
}
