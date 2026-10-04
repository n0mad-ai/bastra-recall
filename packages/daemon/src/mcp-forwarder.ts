#!/usr/bin/env node
/**
 * bastra-recall MCP-stdio forwarder.
 *
 * Spricht das MCP-Protocol über stdio (wie jeder andere MCP-Server), hält
 * aber selbst KEINEN Vault, KEINEN Embedding-Index und KEINEN Watcher. Jeder
 * CallToolRequest wird in einen HTTP-POST an den lokalen bastra-recall-
 * Daemon (`packages/daemon/dist/index.js`, Port 6723) übersetzt.
 *
 * Warum? Jede `claude`-Session, jeder Cursor-Tab, jeder MCP-Client spawnt
 * normalerweise einen eigenen stdio-Daemon. Das bedeutet n In-Memory-Vaults,
 * n Embedding-Indizes, n × Ollama-Backfills, und vor allem n unabhängige
 * State-Maschinen die per File-Watcher synchron gehalten werden müssen — auf
 * Cloud-Storage-Mounts (Google Drive, iCloud) ein bekannter Sync-Bug.
 *
 * Mit dem Forwarder gibt es genau einen Daemon. Alle Clients teilen
 * denselben Vault-State, denselben Embedding-Index, dieselbe Telemetry-
 * Verknüpfung. Hooks (POST /hook/recall), MCP-Clients (Claude Code, Claude
 * Desktop, Cursor, …) und perspektivisch externe Caller (ChatGPT Custom
 * GPT Actions via Tunnel) reden alle gegen dieselbe REST-API.
 *
 * Bootstrap:
 *   1. GET /health probieren. 200 → Daemon läuft, weiter.
 *   2. Sonst: detached `node dist/index.js` spawnen, ~10s auf /health
 *      pollen. Bei EADDRINUSE-Race (zwei Forwarder gleichzeitig) gewinnt
 *      einer, der andere sieht beim re-poll das fertige /health.
 *   3. Falls Daemon binnen Timeout nicht hoch kommt: Stdio-Server startet
 *      trotzdem, jeder CallTool-Request gibt einen Fehler zurück. Damit
 *      blockt der Forwarder den Client nicht.
 *
 * Konfig (env):
 *   BASTRA_DAEMON_URL       — default `http://127.0.0.1:6723`
 *   BASTRA_API_TOKEN        — falls gesetzt: als Bearer durchgereicht
 *   BASTRA_FORWARDER_SPAWN  — `0` deaktiviert den auto-spawn (für Fälle
 *                             wo der Daemon als launchd-Service läuft)
 *   BASTRA_VAULT_PATH       — wird beim Auto-Spawn an den Daemon vererbt
 *                             (alle weiteren BASTRA_*-Vars ebenfalls).
 *   BASTRA_TOOL_SURFACE     — `search` | `write` | `full` (#481). Bestimmt,
 *                             welche Tools DIESER Client sieht und aufrufen
 *                             darf. Default ohne Wert: `full`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  pickPhrase,
  pickToolPhrase,
  banterModeFromEnv,
  progressIndexFor,
  RECALL_STAGE_ORDER,
  type RecallStage,
} from "@bastra-recall/core";
import {
  ALL_TOOL_DEFS,
  filterToolDefsForSurface,
  isToolAllowed,
  toolSurfaceDenial,
  toolSurfaceFrom,
} from "./tool-defs.js";
import { reapStaleFeeds } from "./statusline-session.js";
import { commandOf, parentPidOf } from "./reap-forwarders.js";
import { DAEMON_VERSION } from "./version.js";
import { isOnValue } from "./env.js";
import { serverInstructions } from "./mcp-instructions.js";
import { codeAwarenessDisabledByEnv, enabledRepos } from "./code-graph/enabled-repos.js";

import {
  DAEMON_URL,
  SPAWN_ENABLED,
  fetchWithTimeout,
  holdForDaemon,
  primeDaemon,
  awaitDaemonReady,
} from "./forwarder-daemon-client.js";
import { callDaemon, callRecallStreaming, maybeSessionContextItem } from "./mcp-forwarder-calls.js";
import { liveStatusline, syncStatuslineTurn, flushStatusline } from "./mcp-forwarder-statusline.js";

async function main(): Promise<void> {
  // Best-effort: Daemon hochziehen wenn er fehlt. NICHT awaited (#78): der
  // Stdio-Server connected sofort (Client-initialize hängt nicht am Boot);
  // Tool-Calls warten via holdForDaemon() bis der Daemon healthy ist.
  const daemonReady = primeDaemon();

  // Seed the session statusline feed with the current vault size, so the
  // idle banner shows "N memories" from session start (not "0 memories"
  // until the first recall). Best-effort, sobald der Daemon steht.
  void daemonReady.then(async () => {
    try {
      const resp = await fetchWithTimeout(`${DAEMON_URL}/health`, {}, 1500);
      const body = (await resp.json()) as { vault_size?: number };
      if (typeof body.vault_size === "number") {
        liveStatusline.vault_size = body.vault_size;
        flushStatusline();
      }
    } catch {
      // no health / no vault_size — idle banner shows 0 until first recall
    }
  });

  const server = new Server(
    {
      name: "bastra-recall-mcp",
      title: "Bastra Recall",
      version: DAEMON_VERSION,
      // serverInfo icons (MCP spec 2025-11-25, SEP-973): the standardized
      // logo channel. Claude Desktop does not render it for config-file
      // servers yet — shipped so the logo appears the day it does; the
      // .mcpb extension carries the same icon via its manifest already.
      icons: [
        {
          src: "https://raw.githubusercontent.com/n0mad-ai/bastra-recall/main/packages/daemon/mcpb/icon.png",
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ],
    },
    {
      capabilities: { tools: {} },
      // #582: the code paragraph only for a user who has a code graph. Read
      // once at start-up, like the tool surface below — a client restart is
      // what applies a change to either.
      instructions: serverInstructions(
        !codeAwarenessDisabledByEnv() && (await enabledRepos().catch(() => [])).length > 0,
      ),
    },
  );

  // #481: the surface THIS client runs on. Read once — it comes from the
  // server block the installer wrote, and a client restart is what applies a
  // change to it anyway.
  const toolSurface = toolSurfaceFrom(process.env.BASTRA_TOOL_SURFACE);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Fetch the tool schemas from the DAEMON (#132), so the schema the client
    // is told always matches what the daemon actually validates. The forwarder
    // used to ship its own static copy: with a long-lived shared daemon running
    // older code in RAM, the client could be told a schema the daemon didn't
    // validate (→ "argument arrives undefined"). ALL_TOOL_DEFS is the fallback
    // when the daemon isn't reachable yet (or is too old to expose /tools); the
    // first CallTool spawns it and every call thereafter hits it regardless.
    // Document-Write-Tools are always listed — the daemon decides per call
    // whether BASTRA_DOCUMENT_WRITE=1 and otherwise returns a clear Pro-feature
    // error.
    //
    // Wait for the daemon boot first (the same gate CallTool uses) so the schema
    // comes from the RUNNING daemon, not the bundled fallback — otherwise a slow
    // cold start would serve ALL_TOOL_DEFS and reintroduce the very forwarder↔
    // daemon skew this fixes. The fallback then only applies if the daemon is
    // genuinely unreachable after boot.
    //
    // #481: the surface is sent along so the daemon filters the list it
    // serves; the fallback is filtered here with the same rule, so a daemon
    // too old to know the parameter cannot hand a `search` client a
    // `move_document`.
    await awaitDaemonReady();
    try {
      const resp = await fetchWithTimeout(
        `${DAEMON_URL}/tools?surface=${encodeURIComponent(toolSurface)}`,
        {},
        2000,
      );
      if (resp.ok) {
        const body = (await resp.json()) as { tools?: { name?: string }[] };
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          return {
            tools: filterToolDefsForSurface(
              body.tools.filter((t): t is { name: string } => typeof t?.name === "string"),
              toolSurface,
            ),
          };
        }
      }
    } catch {
      // daemon down / old daemon without /tools → fall back to the bundled defs
    }
    return { tools: filterToolDefsForSurface(ALL_TOOL_DEFS, toolSurface) };
  });

  const banterMode = banterModeFromEnv(process.env);
  const banterLang = (process.env.BASTRA_BANTER_LANG ?? "en").toLowerCase() === "de" ? "de" : "en";

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    const progressToken = (req.params as { _meta?: { progressToken?: string | number } })._meta
      ?.progressToken;

    // #481: a call outside this client's surface never reaches the daemon.
    // The list already hides it, so this catches the client that remembers a
    // tool from a wider surface — the refusal names the surface and how to
    // widen it, so the agent tells the user instead of trying again.
    if (!isToolAllowed(name, toolSurface)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: toolSurfaceDenial(name, toolSurface) }],
      };
    }

    // Diagnostic (BASTRA_PROGRESS_DEBUG=1): logs whether Claude Code attaches a
    // progressToken to each tool call. Without one, no notifications/progress
    // can be sent — so this tells us if the live-phrase channel is even open.
    // Lands in the CC MCP debug log as "Server stderr: …".
    if (isOnValue(process.env.BASTRA_PROGRESS_DEBUG)) {
      console.error(
        `[bastra-progress-debug] tool=${name} progressToken=${
          progressToken === undefined ? "ABSENT" : `present(${JSON.stringify(progressToken)})`
        }`,
      );
    }

    // Streaming recall (#38 follow-up): if the client sent a progressToken
    // and the call is `recall`, proxy via SSE against /hook/recall and
    // forward stage events as `notifications/progress` to the client.
    // Claude Code (and any MCP client that honors progress) renders these
    // as live status lines under the tool call.
    if (name === "recall") {
      const recallStartedAt = Date.now();
      // Statusline state-tracking runs for EVERY recall — independent of
      // whether the client sent a progressToken — the streaming SSE path
      // against /hook/recall does not need one. (An earlier note here said
      // Claude Code often omits the token. Measured, that is not true of
      // 2.1.270: `tools/probes/claude-code-long-save` logged a token on
      // 24 of 24 tool calls, recall and save_memory alike. Other clients
      // still may omit it, which is why this path does not depend on it.)
      // Adopt a fresh turn if the prompt-hook reset to idle, then mark this
      // recall started. All mutations on in-memory liveStatusline — serial,
      // no race across parallel recalls.
      syncStatuslineTurn();
      liveStatusline.state = "running";
      liveStatusline.recall_count += 1;
      liveStatusline.current_recall_started_at = recallStartedAt;
      flushStatusline();
      try {
        const result = await holdForDaemon(() => callRecallStreaming(args, async (s: RecallStage) => {
          // Banter phrase for this stage — the human-readable live message.
          // Always computed (null when banter is off) so it reaches the
          // statusline feed, which is the only visible channel in Claude Code
          // (bug #51713). notifications/progress is sent only when the client
          // opted in via a progressToken; CC drops it.
          const phrase = pickPhrase(s, banterMode, banterLang);
          if (progressToken !== undefined) {
            const dur = s.durationMs !== undefined ? `${s.durationMs}ms` : "";
            // Phrase-first: the human-readable banter leads, the technical
            // stage name only shows when banter is off (fallback).
            const message = phrase
              ? dur
                ? `${phrase} · ${dur}`
                : phrase
              : `${s.name}${dur ? ` · ${dur}` : ""}`;
            await extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: progressIndexFor(s.name),
                  total: RECALL_STAGE_ORDER.length,
                  message,
                },
              })
              .catch(() => undefined);
          }
          liveStatusline.current_stage = s.name;
          liveStatusline.current_message = phrase;
          liveStatusline.current_stage_started_at = Date.now();
          flushStatusline();
        }));
        // Recall complete: fold this recall's hits + duration into the turn
        // totals, clear the current-recall marks.
        const hits = (result as { hits?: unknown[] }).hits;
        const vaultSize = (result as { vault_size?: number }).vault_size;
        liveStatusline.total_hits += Array.isArray(hits) ? hits.length : 0;
        liveStatusline.total_ms += Date.now() - recallStartedAt;
        if (typeof vaultSize === "number") liveStatusline.vault_size = vaultSize;
        liveStatusline.current_stage = null;
        liveStatusline.current_message = null;
        liveStatusline.current_stage_started_at = null;
        liveStatusline.current_recall_started_at = null;
        // Done-banner phrase: the recall's `done` stage event is suppressed
        // upstream, so pick a done phrase here. This persists in the feed and
        // is the only phrase the ≥1s statusline refresh reliably shows.
        liveStatusline.last_phrase = pickPhrase(
          { name: "done", startedAtMs: Date.now() },
          banterMode,
          banterLang,
        );
        liveStatusline.last_phrase_at = Date.now();
        flushStatusline();
        const sessionContext = await maybeSessionContextItem();
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
            ...(sessionContext ? [sessionContext] : []),
          ],
        };
      } catch (err) {
        // On error: clear current-recall marks so the statusline doesn't
        // hang on a stuck stage, and show an error banter phrase in the banner.
        liveStatusline.current_stage = null;
        liveStatusline.current_message = null;
        liveStatusline.current_stage_started_at = null;
        liveStatusline.current_recall_started_at = null;
        liveStatusline.last_phrase = pickPhrase(
          { name: "error", startedAtMs: Date.now() },
          banterMode,
          banterLang,
        );
        liveStatusline.last_phrase_at = Date.now();
        flushStatusline();
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    }

    // Non-streaming tools (load_memory, save_memory, find_document, …) have no
    // stages. Count every bastra tool call into the statusline (so it stays
    // alive on load_memory-heavy turns, not just recalls) and surface its
    // phrase, then fire one progress notification so the phrase also shows
    // under "Calling bastra-recall". Race-safe: same adoptTurn + serial
    // in-memory path as recall (#51); no hits/ms are added here (those stay
    // recall-only).
    const toolPhrase = pickToolPhrase(name, banterMode, banterLang, toolPhraseSeed++);
    syncStatuslineTurn();
    liveStatusline.state = "running";
    liveStatusline.recall_count += 1;
    if (toolPhrase) {
      liveStatusline.last_phrase = toolPhrase;
      liveStatusline.last_phrase_at = Date.now();
    }
    flushStatusline();
    if (progressToken !== undefined && toolPhrase) {
      await extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 1, message: toolPhrase },
        })
        .catch(() => undefined);
    }

    const toolStartedAt = Date.now();
    try {
      const result = await holdForDaemon(() => callDaemon(name, args));
      // Fold this tool call's duration into the turn total (hits stay
      // recall-only, so the statusline shows "N calls · Xms" for load_memory).
      liveStatusline.total_ms += Date.now() - toolStartedAt;
      flushStatusline();
      const sessionContext = await maybeSessionContextItem();
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
          ...(sessionContext ? [sessionContext] : []),
        ],
      };
    } catch (err) {
      liveStatusline.total_ms += Date.now() - toolStartedAt;
      flushStatusline();
      return {
        isError: true,
        content: [
          { type: "text" as const, text: (err as Error).message },
        ],
      };
    }
  });

  // Clean up feed files left behind by CC sessions that died without a clean
  // shutdown (hard kill / crash) — runs once at startup.
  reapStaleFeeds();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[bastra-recall-mcp] forwarder ready (daemon=${DAEMON_URL}, spawn=${SPAWN_ENABLED ? "on" : "off"})`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    // Forwarder beendet sich, aber lässt den Daemon laufen — andere
    // Sessions können noch verbunden sein. Guard gegen Mehrfach-Trigger
    // (SIGTERM + stdin-end + ppid-Poll können gleichzeitig feuern).
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Fast path: CC closes our stdin when it exits → shut down immediately.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());

  // Backstop: if CC dies without closing stdin (hard kill), we get reparented
  // to init/launchd → ppid becomes 1. Poll for it so we never linger as a
  // zombie. unref() so the timer itself never keeps the process alive.
  //
  // Desktop-Wrapper-Shape (#80): Claude Desktop spawnt uns durch den
  // `disclaimer`-Helper. Stirbt Desktop hart, lebt der Wrapper weiter (hält
  // unsere stdio-Pipes offen, ppid bleibt ≠ 1) — beide #49-Pfade greifen
  // nie. Erkennung: der WRAPPER wird dann zu init/launchd reparented, also
  // poll'en wir im Wrapper-Modus zusätzlich `ppid(wrapper) === 1`.
  // #345 generalisiert den Wrapper-Begriff: jeder Parent, der unser Script
  // im Kommando trägt (sh -c, npx, …), ist ein Wrapper — ein direkter
  // Client-Spawn (claude, Cursor, Codex) trägt es nie.
  const wrapperPid = process.ppid;
  const wrapperCmd = commandOf(wrapperPid) ?? "";
  const wrapperMode = /disclaimer/i.test(wrapperCmd) || wrapperCmd.includes("mcp-forwarder");
  const orphanCheck = setInterval(() => {
    if (process.ppid === 1) {
      void shutdown();
      return;
    }
    if (wrapperMode && process.ppid === wrapperPid) {
      const wrapperParent = parentPidOf(wrapperPid);
      if (wrapperParent === 1 || wrapperParent === null) void shutdown();
    }
  }, 30_000);
  orphanCheck.unref();
}

/** Cycles per non-streaming tool call so a series shows varying tool phrases. */
let toolPhraseSeed = 0;

main().catch((err) => {
  console.error("[bastra-recall-mcp] FATAL:", err);
  process.exit(1);
});
