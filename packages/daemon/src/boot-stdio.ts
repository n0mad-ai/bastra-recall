/**
 * Start-up phase 7 (#1039): the standalone MCP stdio surface — tool list, the
 * call dispatcher (with #38 progress notifications) and the stdio transport.
 *
 * Moved verbatim out of `main()` in `index.ts`, with its `errorResult` helper.
 */
import { draftReviewTools, reviewDraftHandler } from "./draft-review-handler.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Vault,
  SearchIndex,
  pickPhrase,
  banterModeFromEnv,
  progressIndexFor,
  RECALL_STAGE_ORDER,
  type RecallStage,
  type StageListener,
} from "@bastra-recall/core";
import { recoverCallArguments } from "./call-corruption.js";
import { TOOL_ARG_EXPECTATIONS } from "./tool-defs.js";
import {
  recallHandler,
  loadMemoryHandler,
  saveMemoryHandler,
  archiveMemoryHandler,
  MEMORY_TOOL_DEFS,
  type ToolDeps,
} from "./tool-handlers.js";
import { editMemoryHandler } from "./edit-memory-handler.js";
import {
  documentTools,
  FindDocumentArgs,
  ReadDocumentArgs,
  OpenDocumentArgs,
  findDocument,
  readDocument,
  openDocument,
} from "./documents-handler.js";
import { codeTools, FindCodeArgs, findCode, sharedCodeGraphCache } from "./code-graph/find-code.js";
import { findAffectedFilesEvent, findCodeEvent } from "./code-graph/tool-telemetry.js";
import {
  affectedTools,
  FindAffectedFilesArgs,
  findAffectedFiles,
} from "./code-graph/find-affected-files.js";
import {
  documentWriteTools,
  SaveDocumentArgs,
  RecategorizeDocumentArgs,
  MoveDocumentArgs,
  saveDocument,
  recategorizeDocument,
  moveDocument,
} from "./documents-write-handler.js";
import { productDocTools, saveProductDocHandler } from "./product-doc-handler.js";
import { DAEMON_VERSION } from "./version.js";
import { projectForFilter } from "./scope-filter.js";

export async function startStdioServer(opts: {
  vault: Vault;
  search: SearchIndex;
  toolDeps: ToolDeps;
  documentWriteEnabled: boolean;
  markActivity: () => void;
}): Promise<{ server: Server }> {
  const { vault, search, toolDeps, documentWriteEnabled, markActivity } = opts;

  const server = new Server(
    { name: "bastra-recall", version: DAEMON_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...MEMORY_TOOL_DEFS,
      ...draftReviewTools,
      ...documentTools,
      ...(documentWriteEnabled ? documentWriteTools : []),
      ...productDocTools,
      // #576: the stdio surface lists its tools here, separately from
      // ALL_TOOL_DEFS — a tool added only there works through the forwarder
      // and does not exist over stdio.
      ...codeTools,
      ...affectedTools,
    ],
  }));


  // Banter-Lang: nutzt BASTRA_BANTER_LANG (de|en), default `en` —
  // MCP-Clients sind heterogen, ein deutsches "Stichwörter durchforsten"
  // im englischen Chat-Verlauf wirkt fremd. Deutsche Mac-App-User setzen
  // BASTRA_BANTER_LANG=de in ihrer Shell oder dem Daemon-Launchd-Plist.
  const banterMode = banterModeFromEnv(process.env);
  const banterLang = (process.env.BASTRA_BANTER_LANG ?? "en").toLowerCase() === "de" ? "de" : "en";

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    markActivity();
    const { name, arguments: rawArgs } = req.params;

    // #482: same check as the REST boundary — the standalone stdio surface is
    // the other place tool arguments arrive, and the client bug does not care
    // which transport it corrupts.
    const args = recoverCallArguments(name, rawArgs, TOOL_ARG_EXPECTATIONS) as
      | Record<string, unknown>
      | undefined;

    if (name === "recall") {
      try {
        // MCP-Progress-Notification (#38): wenn der Caller einen
        // progressToken mitschickt, leiten wir Stage-Events als
        // `notifications/progress` weiter. Claude Code rendert die als
        // Live-Stage-Lines unter dem Tool-Aufruf. Banter-Phrase landet
        // im `message`-Feld der Notification.
        const progressToken = (req.params as { _meta?: { progressToken?: string | number } })._meta
          ?.progressToken;
        const onStage: StageListener | undefined = progressToken !== undefined
          ? (s: RecallStage) => {
              // Nur Stop-Events (mit durationMs) als Progress-Tick
              // emittieren — Start-Events würden Claude Code mit
              // doppelten Lines fluten.
              if (s.durationMs === undefined && s.name !== "cache.hit" && s.name !== "done") return;
              const phrase = pickPhrase(s, banterMode, banterLang);
              const message = phrase
                ? `${s.name} — ${phrase}${s.durationMs !== undefined ? ` (${s.durationMs}ms)` : ""}`
                : `${s.name}${s.durationMs !== undefined ? ` (${s.durationMs}ms)` : ""}`;
              // Fire-and-forget — Notification-Failures dürfen den
              // Recall nicht kippen.
              void extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: progressIndexFor(s.name),
                  total: RECALL_STAGE_ORDER.length,
                  message,
                },
              }).catch(() => undefined);
            }
          : undefined;
        // #421: Das Projekt dieses stdio-Clients (sein cwd, durch dasselbe
        // Konfidenz-Gate wie in den Lanes) — ohne es liefe der Scope-Filter
        // der gemeinsamen Pipeline für einen Client ohne Hooks nie.
        const result = await recallHandler(toolDeps, args, { onStage, project: projectForFilter(process.cwd()) });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "load_memory") {
      try {
        const result = await loadMemoryHandler(toolDeps, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "review_draft") {
      try { return { content: [{ type: "text", text: JSON.stringify(await reviewDraftHandler(toolDeps, args ?? {})) }] }; }
      catch (err) { return errorResult((err as Error).message); }
    }

    if (name === "save_memory") {
      try {
        const result = await saveMemoryHandler(toolDeps, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "edit_memory") {
      try {
        // #519/#464: ohne Capability — der stdio-Server ist ein öffentlicher
        // Transport (siehe private-access.ts).
        const result = await editMemoryHandler(toolDeps, args ?? {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "archive_memory") {
      try {
        const result = await archiveMemoryHandler(toolDeps, args ?? {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "save_product_doc") {
      try {
        const result = await saveProductDocHandler(toolDeps, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    // #576: code awareness. Synchronous by construction — a cold graph
    // answers "unavailable" rather than blocking on a 20-26 ms load.
    if (name === "find_code") {
      const parsed = FindCodeArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const cache = sharedCodeGraphCache();
      const result = findCode(cache, parsed.data);
      // #579: the call itself, as a countable shape. Never awaited — a
      // telemetry write must not sit inside a tool the hook budget depends on.
      void toolDeps.telemetry
        .logCodeToolCall(findCodeEvent(cache, parsed.data, result, { surface: "mcp" }))
        .catch(() => {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    // #582: change impact from the changed SYMBOLS, across package boundaries.
    if (name === "find_affected_files") {
      const parsed = FindAffectedFilesArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const cache = sharedCodeGraphCache();
      const result = await findAffectedFiles(cache, parsed.data);
      void toolDeps.telemetry
        .logCodeToolCall(findAffectedFilesEvent(cache, parsed.data, result, { surface: "mcp" }))
        .catch(() => {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === "find_document") {
      const parsed = FindDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const result = findDocument(search, vault, parsed.data);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    if (name === "read_document") {
      const parsed = ReadDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const doc = readDocument(vault, parsed.data);
      // #457: derselbe Größen-Eintrag wie auf dem HTTP-Pfad.
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
        caller_session: null,
      }).catch(() => {});
      if (!doc) return errorResult(`document not found: ${parsed.data.id}`);
      return {
        content: [
          { type: "text", text: JSON.stringify(doc, null, 2) },
        ],
      };
    }

    if (name === "open_document") {
      const parsed = OpenDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const result = await openDocument(vault, parsed.data);
      if ("ok" in result && !result.ok) {
        return errorResult(result.message);
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    if (name === "save_document" || name === "recategorize_document" || name === "move_document") {
      if (!documentWriteEnabled) {
        return errorResult(
          `${name} is a Pro feature — set BASTRA_DOCUMENT_WRITE=1 to enable.`,
        );
      }
      try {
        if (name === "save_document") {
          const parsed = SaveDocumentArgs.safeParse(args);
          if (!parsed.success) return errorResult(parsed.error.message);
          const result = await saveDocument(vault, parsed.data);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        if (name === "recategorize_document") {
          const parsed = RecategorizeDocumentArgs.safeParse(args);
          if (!parsed.success) return errorResult(parsed.error.message);
          const result = await recategorizeDocument(vault, parsed.data);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        // move_document
        const parsed = MoveDocumentArgs.safeParse(args);
        if (!parsed.success) return errorResult(parsed.error.message);
        const result = await moveDocument(vault, parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    return errorResult(`unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[bastra-recall] MCP server ready on stdio`);

  return { server };
}

function errorResult(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}
