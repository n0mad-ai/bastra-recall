/**
 * Route dispatch for the vault-map web UI surface (#207/#208/#215/#216) and
 * its hook-side companions (/hook/import, /hook/onboarding,
 * /hook/session-context). All loopback-only — the host gate in http.ts runs
 * before this dispatcher. Returns true when the request was handled.
 * Split out of http.ts (file-size convention); the route order is preserved.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Vault, SearchIndex } from "@bastra-recall/core";
import type { ToolDeps } from "./tool-handlers.js";
import {
  handleWebUi,
  handleUiAnnotate,
  handleUiAnnotations,
  handleUiSearch,
  handleUiVaultImageGet,
  handleUiVaultImagePost,
} from "./webui.js";
import { handleUiChat, type ChatFn } from "./webui-chat.js";
import { handleHookImport, handleUiImport } from "./import-review.js";
import { handleUiImportVault, handleUiFsBrowse } from "./import-vault.js";
import { handleUiSkills } from "./skills-registry.js";
import { handleUiAreas } from "./webui-areas.js";
import { handleUiTelemetry } from "./webui-telemetry.js";
import type { createLiveUpdates } from "./live-updates.js";
import { handleHookOnboarding, handleUiOnboarding } from "./onboarding.js";
import { handleSessionContext, handleSessionContextPost } from "./session-context.js";
import { sendJson } from "./http-util.js";

export interface UiRouteCtx {
  vault: Vault;
  search: SearchIndex;
  toolDeps: ToolDeps;
  /** #216: fresh-memory buffer for the map's live mode (supernova + card) */
  liveUpdates: ReturnType<typeof createLiveUpdates>;
  /** Lokaler Chat-Client für den Such-Copiloten (#207). null = kein lokales
   *  Generierungsmodell verfügbar → /ui/chat antwortet 503. */
  uiChat?: ChatFn | null;
}

export function dispatchUiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  ctx: UiRouteCtx,
): boolean {
  const { vault, search, toolDeps, liveUpdates } = ctx;

  // Vault care (#207): flags from the map, appended to vault-care.md in the
  // vault (open format — an AI session works the list off). Loopback-only
  // like /ui, gated on ui.enabled inside the handlers.
  if (method === "GET" && url === "/ui/annotations") {
    handleUiAnnotations(res, toolDeps.vaultPath).catch(() => sendJson(res, 500, { error: "ui error" }));
    return true;
  }
  // Import review (#208): open candidate count for the session hook —
  // loopback-only like /hook/care.
  if (method === "GET" && url === "/hook/import") {
    handleHookImport(res, toolDeps.vaultPath).catch(() => sendJson(res, 500, { error: "import error" }));
    return true;
  }
  // Visual import (#208): the map's import dialog stages candidates the
  // same way `bastra import` does. Staging only, never saves memories.
  if (method === "POST" && url === "/ui/import") {
    handleUiImport(req, res, toolDeps.vaultPath).catch(() => sendJson(res, 500, { error: "import error" }));
    return true;
  }
  // Folder import (#215): the map's sibling of `bastra import vault <dir>` —
  // ingest a whole memory folder into the isolated imported/ subtree, then
  // reconcile so the new nodes show on the map at once. Writes directly (no
  // staging), but only into memories/imported/.
  if (method === "POST" && url === "/ui/import-vault") {
    handleUiImportVault(req, res, toolDeps.vaultPath, () => vault.reconcile()).catch(() =>
      sendJson(res, 500, { error: "import error" }),
    );
    return true;
  }
  // Skills registry (#215): list + declare ("mark as skill" on a ghost) —
  // classifies the node into the skills ring on the next graph render.
  if ((method === "GET" || method === "POST") && url === "/ui/skills") {
    handleUiSkills(req, res).catch(() => sendJson(res, 500, { error: "skills error" }));
    return true;
  }
  // Folder picker for the import dialog (#215): directory names only.
  if (method === "GET" && url.startsWith("/ui/fs")) {
    handleUiFsBrowse(req, res).catch(() => sendJson(res, 500, { error: "fs error" }));
    return true;
  }
  // Live updates (#216): freshly saved memories for the map's live mode.
  if (method === "GET" && url.startsWith("/ui/updates")) {
    liveUpdates.handleUiUpdates(req, res).catch(() => sendJson(res, 500, { error: "updates error" }));
    return true;
  }
  // Areas manager (#216): list / create / rename / delete the vault's
  // top-level areas. Bulk folder moves heal with one reconcile.
  if ((method === "GET" || method === "POST") && url === "/ui/areas") {
    handleUiAreas(req, res, toolDeps.vaultPath, () => vault.reconcile()).catch(() =>
      sendJson(res, 500, { error: "areas error" }),
    );
    return true;
  }
  if (method === "POST" && url === "/ui/annotate") {
    handleUiAnnotate(req, res, toolDeps.vaultPath).catch(() => sendJson(res, 500, { error: "ui error" }));
    return true;
  }
  // Onboarding interview: needed-flag for the session hook (loopback, not
  // ui-gated) and the map dialog's catalog + answer submission (ui-gated).
  if (method === "GET" && url === "/hook/onboarding") {
    handleHookOnboarding(res, toolDeps.vaultPath, vault.size()).catch(() => sendJson(res, 500, { error: "onboarding error" }));
    return true;
  }
  if ((method === "GET" || method === "POST") && url === "/ui/onboarding") {
    handleUiOnboarding(req, res, toolDeps.vaultPath, vault.size()).catch(() => sendJson(res, 500, { error: "onboarding error" }));
    return true;
  }
  // Session-context for hookless clients (Claude Desktop, Cursor): the MCP
  // forwarder appends this to the FIRST tool result of a client session —
  // the same context the SessionStart hook injects in Claude Code.
  // Loopback-only (Host-Gate above), read-only, no auth — like /hook/care.
  if (method === "GET" && url === "/hook/session-context") {
    handleSessionContext(req, res, toolDeps, vault).catch(() =>
      sendJson(res, 500, { error: "session-context error" }),
    );
    return true;
  }
  // #265: derselbe Pfad, projektbewusst und mit Budgets. GET bleibt der
  // projektlose Forwarder-Vertrag; POST nimmt cwd/project/source/budget und
  // liefert die Blockliste, den §9.4-Marker und die Budgetbilanz daneben.
  if (method === "POST" && url === "/hook/session-context") {
    handleSessionContextPost(req, res, toolDeps, vault).catch(() =>
      sendJson(res, 500, { error: "session-context error" }),
    );
    return true;
  }
  // Telemetry tab (#463): the stats.ts series as JSON over the user's own
  // event logs. Read-only, loopback-only, gated on ui.enabled inside.
  if (method === "GET" && url.startsWith("/ui/telemetry")) {
    handleUiTelemetry(req, res, url).catch(() => sendJson(res, 500, { error: "telemetry error" }));
    return true;
  }
  // Semantic search for the map's search box (#207) — hybrid recall, lean.
  if (method === "GET" && url.startsWith("/ui/search")) {
    handleUiSearch(res, url, search).catch(() => sendJson(res, 500, { error: "ui error" }));
    return true;
  }
  // Search copilot (#207): chat that deepens a search — local Ollama
  // generation model only, loopback-only like the rest of /ui.
  if (method === "POST" && url === "/ui/chat") {
    const getBody = (id: string) => {
      const m = vault.get(id);
      return m && m.fm.sensitivity !== "private" ? m.body : null;
    };
    handleUiChat(req, res, { search, chat: ctx.uiChat ?? null, getBody }).catch(() =>
      sendJson(res, 500, { error: "ui error" }),
    );
    return true;
  }
  // Ring-view center emblem (#207): stored as vault-image.<ext> at the
  // vault root — an open file like everything else the daemon writes.
  // Path-only match: the viewer cache-busts with ?ts=.
  if (url.split("?")[0] === "/ui/vault-image") {
    if (method === "GET") {
      handleUiVaultImageGet(res, url, toolDeps.vaultPath).catch(() => sendJson(res, 404, { error: "no vault image" }));
      return true;
    }
    if (method === "POST") {
      handleUiVaultImagePost(req, res, url, toolDeps.vaultPath).catch(() => sendJson(res, 500, { error: "ui error" }));
      return true;
    }
  }

  // Vault map web UI (#207): static viewer, opt-in via ui.enabled. Sits
  // outside /api/v1/* → loopback-only through the host gate above.
  if (method === "GET" && (url === "/ui" || url.startsWith("/ui/"))) {
    handleWebUi(req, res, url).catch(() => sendJson(res, 500, { error: "ui error" }));
    return true;
  }

  return false;
}
