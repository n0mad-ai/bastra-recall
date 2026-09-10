/**
 * The /api/v1 POST tool dispatcher: maps a tool name from the URL to the
 * shared MCP tool handlers (recall, save_memory, documents, floors, …).
 * The auth/CORS gate and the GET routes stay in http.ts.
 * Split out of http.ts (file-size convention).
 */
import {
  recallHandler,
  loadMemoryHandler,
  saveMemoryHandler,
  archiveMemoryHandler,
  type ToolDeps,
} from "./tool-handlers.js";
import {
  FindDocumentArgs,
  ReadDocumentArgs,
  OpenDocumentArgs,
  findDocument,
  readDocument,
  openDocument,
} from "./documents-handler.js";
import {
  SaveDocumentArgs,
  RecategorizeDocumentArgs,
  MoveDocumentArgs,
  saveDocument,
  recategorizeDocument,
  moveDocument,
} from "./documents-write-handler.js";
import { addFloor, affirm, release } from "./floors.js";
import { saveProductDocHandler } from "./product-doc-handler.js";
import { recoverCallArguments } from "./call-corruption.js";
import { TOOL_ARG_EXPECTATIONS } from "./tool-defs.js";

// ─── /api/v1 dispatcher ──────────────────────────────────────────

export interface DispatchCtx {
  toolDeps: ToolDeps;
  documentWriteEnabled: boolean;
  /** Echte CC-Session aus den Forwarder-Headern (#74); null = unbekannt. */
  ccSessionId?: string | null;
}

export async function dispatchApi(
  tool: string,
  body: Record<string, unknown>,
  ctx: DispatchCtx,
): Promise<unknown | undefined> {
  const { toolDeps, documentWriteEnabled } = ctx;
  const { vault, search } = toolDeps;

  // #482: the corrupted-arguments check belongs at the boundary, not in one
  // handler. This is where every tool call from the forwarder arrives, so a
  // client that turns its JSON arguments into XML gets the same honest answer
  // whatever it called — instead of anonymous "received undefined" lines.
  // 08.09.: and it repairs what it can. A `body` glued into `summary` by the
  // client's XML fallback is fully present — only its framing was lost, so the
  // call runs on the recovered arguments instead of costing the user the save.
  body = recoverCallArguments(tool, body, TOOL_ARG_EXPECTATIONS) as Record<string, unknown>;

  switch (tool) {
    case "recall":
      return await recallHandler(toolDeps, body);
    case "load_memory":
      return await loadMemoryHandler(toolDeps, body, { sessionId: ctx.ccSessionId ?? null });
    case "save_memory":
      return await saveMemoryHandler(toolDeps, body);
    case "archive_memory":
      return await archiveMemoryHandler(toolDeps, body);
    case "save_product_doc":
      return await saveProductDocHandler(toolDeps, body);

    // Floor-Registry (#141/#142). Bewusst KEIN neues MCP-Tool (Tool-Surface-
    // Disziplin) — Governance-Surfaces konsumieren die REST-API. Die
    // Invarianten (cap, affirm braucht affirmed_by+why, release-by-condition)
    // erzwingt floors.ts selbst; Fehler landen als 400 beim Caller.
    case "floors": {
      const memoryId = typeof body.memory_id === "string" ? body.memory_id : "";
      const condition = typeof body.condition === "string" ? body.condition : "";
      const reason = typeof body.reason === "string" ? body.reason : "";
      const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope : undefined;
      const affirmedBy = typeof body.affirmed_by === "string" ? body.affirmed_by : undefined;
      const why = typeof body.why === "string" ? body.why : undefined;
      const entry = await addFloor({
        memory_id: memoryId,
        condition,
        reason,
        scope,
        affirmed_by: affirmedBy,
        why,
        // Carried only when this rewrite IS an affirm (#198).
        ...(typeof body.occurred_at === "string" ? { occurred_at: body.occurred_at } : {}),
      });
      return { ok: true, entry };
    }
    case "floors/release": {
      const condition = typeof body.condition === "string" ? body.condition : "";
      const released = await release(condition);
      return { released };
    }
    case "floors/affirm": {
      // #198: `occurred_at` is the queuing surface's intent time, carried
      // verbatim. Only the surface knows when the affirm was meant; a drain
      // after downtime replays the original time, not the write time. Absent
      // is legitimate — an inline affirm has no second clock.
      const occurredAt = typeof body.occurred_at === "string" ? body.occurred_at : undefined;
      const entry = await affirm(
        typeof body.memory_id === "string" ? body.memory_id : "",
        typeof body.affirmed_by === "string" ? body.affirmed_by : "",
        typeof body.why === "string" ? body.why : "",
        occurredAt !== undefined ? { occurredAt } : {},
      );
      return { ok: true, entry };
    }

    case "find_document": {
      const parsed = FindDocumentArgs.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.message);
      return findDocument(search, vault, parsed.data);
    }
    case "read_document": {
      const parsed = ReadDocumentArgs.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.message);
      const doc = readDocument(vault, parsed.data);
      // #457: read_document liefert ganze Dokumentkörper — bisher der größte
      // Posten, der in keiner Kontextrechnung stand.
      void toolDeps.telemetry.logReadDocument({
        id: parsed.data.id,
        found: doc !== null,
        ...(doc
          ? {
              delivered_chars: JSON.stringify(doc, null, 2).length,
              delivered_tokens_est: Math.ceil(JSON.stringify(doc, null, 2).length / 4),
              body_chars: doc.body.length,
            }
          : {}),
        caller_session: ctx.ccSessionId ?? null,
      }).catch(() => {});
      if (!doc) throw new Error(`document not found: ${parsed.data.id}`);
      return doc;
    }
    case "open_document": {
      const parsed = OpenDocumentArgs.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.message);
      const result = await openDocument(vault, parsed.data);
      if ("ok" in result && !result.ok) {
        throw new Error(result.message);
      }
      return result;
    }

    case "save_document":
    case "recategorize_document":
    case "move_document": {
      if (!documentWriteEnabled) {
        throw new Error(
          `${tool} is a Pro feature — set BASTRA_DOCUMENT_WRITE=1 to enable.`,
        );
      }
      if (tool === "save_document") {
        const parsed = SaveDocumentArgs.safeParse(body);
        if (!parsed.success) throw new Error(parsed.error.message);
        return await saveDocument(vault, parsed.data);
      }
      if (tool === "recategorize_document") {
        const parsed = RecategorizeDocumentArgs.safeParse(body);
        if (!parsed.success) throw new Error(parsed.error.message);
        return await recategorizeDocument(vault, parsed.data);
      }
      const parsed = MoveDocumentArgs.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.message);
      return await moveDocument(vault, parsed.data);
    }
  }
  return undefined;
}
