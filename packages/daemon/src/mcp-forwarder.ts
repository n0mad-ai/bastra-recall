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
import * as fs from "node:fs";
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
import { mergeBatchResults, projectRecallResult } from "./recall-batch.js";
import { claudeSessionPid, sessionFeedPath, STATUSLINE_DIR, reapStaleFeeds } from "./statusline-session.js";
import { commandOf, parentPidOf } from "./reap-forwarders.js";
import { DAEMON_VERSION } from "./version.js";
import { envInt } from "./env.js";
import {
  adoptTurn,
  defaultStatuslineState,
  type StatuslineState,
} from "./statusline-feed.js";
import { SERVER_INSTRUCTIONS } from "./mcp-instructions.js";

import {
  DAEMON_URL,
  API_TOKEN,
  SPAWN_ENABLED,
  REQUEST_TIMEOUT_MS,
  FORWARDER_HOOK_BUDGET_MS,
  fetchWithTimeout,
  holdForDaemon,
  primeDaemon,
  awaitDaemonReady,
} from "./forwarder-daemon-client.js";
function ccTurnHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (typeof liveStatusline.cc_session_id === "string" && liveStatusline.cc_session_id) {
    h["x-bastra-cc-session"] = liveStatusline.cc_session_id;
    if (liveStatusline.turn_id > 0) h["x-bastra-cc-turn"] = String(liveStatusline.turn_id);
  }
  return h;
}

async function callDaemon(tool: string, args: unknown): Promise<unknown> {
  const url = `${DAEMON_URL}/api/v1/${tool}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...ccTurnHeaders(),
  };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const doFetch = async (): Promise<Response> => {
    return await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(args ?? {}),
      },
      REQUEST_TIMEOUT_MS,
    );
  };

  let resp: Response;
  try {
    resp = await doFetch();
  } catch (err) {
    // Netzwerk-Fehler: einmaliger Retry — vielleicht ist der Daemon gerade
    // restartet. Beim zweiten Fehler durchreichen.
    await new Promise((r) => setTimeout(r, 300));
    try {
      resp = await doFetch();
    } catch (err2) {
      throw new Error(
        `daemon unreachable at ${DAEMON_URL}: ${(err2 as Error).message}`,
      );
    }
  }

  const text = await resp.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`invalid JSON response from daemon: ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const errMsg =
      (body as { error?: string })?.error ?? `HTTP ${resp.status}`;
    throw new Error(errMsg);
  }
  return body;
}

/**
 * Session-context inject for hookless clients (Claude Desktop, Cursor): the
 * forwarder process lives exactly one client session, so the FIRST tool call
 * of this process ≈ session start — its result gets the same context block
 * the SessionStart hook injects in Claude Code (pinned memories, durable
 * user hints, conventions, open care/import/onboarding state). Claude Code
 * sessions are skipped: the prompt-hook stamps cc_session_id into the
 * statusline feed, which hookless clients never have. 404 = old daemon
 * without the endpoint → give up for this session; transient error → retry
 * on the next call. Opt out with BASTRA_MCP_SESSION_CONTEXT=0.
 */
let sessionContextPending = process.env.BASTRA_MCP_SESSION_CONTEXT !== "0";

async function maybeSessionContextItem(): Promise<{ type: "text"; text: string } | null> {
  if (!sessionContextPending) return null;
  if (typeof liveStatusline.cc_session_id === "string" && liveStatusline.cc_session_id) {
    sessionContextPending = false; // Claude Code — the SessionStart hook already injected
    return null;
  }
  try {
    const resp = await fetchWithTimeout(`${DAEMON_URL}/hook/session-context`, {}, 1200);
    if (resp.status === 404) {
      sessionContextPending = false;
      return null;
    }
    if (!resp.ok) return null;
    const body = (await resp.json()) as { context?: string };
    sessionContextPending = false;
    return typeof body.context === "string" && body.context ? { type: "text", text: body.context } : null;
  } catch {
    return null;
  }
}

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
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
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
    if (process.env.BASTRA_PROGRESS_DEBUG) {
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
      // whether the client sent a progressToken. (Claude Code often omits
      // it; the streaming SSE path against /hook/recall does not need it.)
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

// ─── helpers ─────────────────────────────────────────────────────


const VALID_STAGE_NAMES: ReadonlySet<RecallStage["name"]> = new Set([
  "query.parse",
  "cache.hit",
  "bm25.search",
  "vector.search",
  "rrf.fuse",
  "hops.expand",
  "staleness.rank",
  "done",
  "error",
]);

/**
 * Streaming recall path. Posts to `/hook/recall` with `Accept:
 * text/event-stream`, parses SSE frames, fires `onStage` for each stage
 * event, returns the final result shaped like `/api/v1/recall` so the
 * client JSON is consistent regardless of which path was taken.
 *
 * Note: this reuses `/hook/recall` — that endpoint is open (no token)
 * and already SSE-capable. The side-effect is that hook_recall telemetry
 * gets logged for MCP recalls too; since #263 the `hook_source: "mcp"`
 * dimension says so as its own column (the `tool_name: "mcp-forwarder"`
 * marker stays for the events written before it existed).
 */
interface HookRecallDonePayload {
  hits: unknown[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
  /** Die Ehrlichkeitsfelder des Daemons. Sie standen schon immer im
   *  `done`-Event, fehlten aber hier — und was der Typ nicht kennt, hat die
   *  Projektion unten nicht weitergereicht. Siehe `projectRecallResult`. */
  weak_result?: boolean;
  no_home?: boolean;
  score_kind?: "rrf" | "bm25";
  score_arms?: string[];
  score_version?: string;
  unfused?: boolean;
  degraded?: string;
}

/** Dense-arm deadline for model-triggered recalls (see body.vector_deadline_ms). */
const MCP_VECTOR_DEADLINE_MS = envInt("BASTRA_MCP_VECTOR_DEADLINE_MS", 1500);

async function callRecallStreaming(
  args: unknown,
  onStage: (s: RecallStage) => void | Promise<void>,
): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  // #351 batch mode: several phrasings, ONE tool round trip. Sub-recalls run
  // in parallel against /hook/recall — each gets its own recall_id/telemetry
  // (the reach-join keys per query); only the first streams stages (the
  // statusline shows one recall either way). Results interleave by BEST
  // original score, so the tool description's score bands stay valid.
  if (Array.isArray(a.queries) && a.queries.length > 0 && a.queries.every((q) => typeof q === "string")) {
    const queries = (a.queries as string[]).slice(0, 4);
    const subs = (await Promise.all(
      queries.map((q, i) =>
        callRecallStreaming(
          { ...a, queries: undefined, query: q, batch_of: queries.length },
          i === 0 ? onStage : () => undefined,
        ),
      ),
    )) as Parameters<typeof mergeBatchResults>[1];
    return mergeBatchResults(queries, subs, typeof a.k === "number" ? a.k : 5);
  }
  const body: Record<string, unknown> = {
    query: typeof a.query === "string" ? a.query : "",
    tool_name: "mcp-forwarder",
    // #263: Dieser Aufruf ist KEIN Hook — er kommt über denselben Endpunkt,
    // weil der offen und SSE-fähig ist. `hook_source: "mcp"` sagt das als
    // eigene Spalte, statt es wie bisher am `tool_name`-Marker abzulesen.
    hook_source: "mcp",
    // #74: echte CC-Session an die hook_recall-Telemetrie durchreichen.
    session_id: typeof liveStatusline.cc_session_id === "string" ? liveStatusline.cc_session_id : null,
  };
  if (typeof a.k === "number") body.k = a.k;
  if (typeof a.scope === "string") body.scope = a.scope;
  if (typeof a.type === "string") body.type = a.type;
  // #351: batch width rides along so the hook_recall event can count it.
  if (typeof a.batch_of === "number") body.batch_of = a.batch_of;
  // MCP-Pfad: genau k Hits, keine 1-Hop-Nachbarn (#50). Der /hook/recall-
  // Default ist 1 (gut für die PreToolUse-Hook-CLI), aber für den vom Modell
  // ausgelösten recall verdoppeln die Nachbarn nur den Context. Das Modell
  // kann expand_hops:1 explizit anfordern, wenn es Related-Memories will.
  body.expand_hops = typeof a.expand_hops === "number" ? a.expand_hops : 0;
  // 20.08.: a model is waiting on this call, not a 600ms hook budget — give
  // the dense arm room. At the hook default (150ms) a 3-query batch (#351)
  // serialised on one Ollama and 15 of 19 MCP recalls came back BM25-only.
  body.vector_deadline_ms = MCP_VECTOR_DEADLINE_MS;
  // #493: Die eigene Wanduhr, statt stillschweigend die einer fremden Lane zu
  // erben. Ohne dieses Feld fiel die Route auf `BASTRA_HOOK_BUDGET_MS` zurück
  // — die 200 ms der Prompt-Lane — und die Schattenzeilen der MCP-Lane lasen
  // live `deadline_ms 1500, lane_budget_ms 200, cap_reason floor`: ein
  // gesunder 400-ms-Arm, gemessen an einer Grenze, die für ihn nie galt.
  //
  // Die Zahl selbst steht bei ihrem Ursprung (`FORWARDER_HOOK_BUDGET_MS`).
  body.hook_budget_ms = FORWARDER_HOOK_BUDGET_MS;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...ccTurnHeaders(),
  };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${DAEMON_URL}/hook/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(tid);
    throw new Error(`daemon unreachable at ${DAEMON_URL}: ${(err as Error).message}`);
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(tid);
    throw new Error(`daemon /hook/recall failed: HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let payload: HookRecallDonePayload | null = null;
  let errorMsg: string | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseSseFrame(frame);
        if (!evt) continue;
        if (evt.type === "stage") {
          const d = evt.data as { name?: string; durationMs?: number; meta?: Record<string, unknown> };
          if (!d.name || !VALID_STAGE_NAMES.has(d.name as RecallStage["name"])) continue;
          const stage: RecallStage = {
            name: d.name as RecallStage["name"],
            startedAtMs: Date.now(),
            durationMs: d.durationMs,
            meta: d.meta,
          };
          await onStage(stage);
        } else if (evt.type === "done") {
          payload = evt.data as HookRecallDonePayload;
        } else if (evt.type === "error") {
          errorMsg = (evt.data as { error?: string })?.error ?? "unknown error";
        }
      }
    }
  } finally {
    clearTimeout(tid);
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!payload) throw new Error("daemon /hook/recall ended without done event");

  // No `stages` block in the tool-result (#50): stage events already drove
  // the live progress channel via onStage; the timing map would just bloat
  // the context Claude reads. Debug timings live in /api/v1/recall + telemetry.
  // Alles Übrige — Score-Raum, Armmenge, Formelversion, weak_result/no_home —
  // reicht `projectRecallResult` durch: der Batch-Merge liest genau daraus
  // seine Vergleichbarkeitssignatur, und ohne sie war jeder Batch „gemischt".
  return projectRecallResult(body.query as string, payload);
}

// Feed is namespaced by the CC session (claude ancestor PID) so concurrent
// sessions don't clobber each other (CC sends no session id — #41836).
// Computed once at startup; the forwarder lives for the whole session.
const STATUSLINE_FEED_PATH = sessionFeedPath(claudeSessionPid());

/**
 * Statusline state — aggregated per Assistant-Turn. Read live by the
 * @bastra-recall/statusline `bastra` segment which renders it next to the
 * user's powerline. Claude Code does NOT render MCP notifications/progress
 * (issue #51713), so this file is the out-of-band channel.
 *
 * Ownership: this forwarder process owns the authoritative copy IN MEMORY
 * (single-threaded JS → concurrent recalls mutate it serially, no race).
 * The disk file is write-only from here, plus a single read at recall-start
 * to detect the prompt-hook's turn boundary (see `adoptTurn` / Issue #51).
 * State shape + the turn-boundary decision live in `statusline-feed.ts`.
 */
let liveStatusline: StatuslineState = defaultStatuslineState();

/** Cycles per non-streaming tool call so a series shows varying tool phrases. */
let toolPhraseSeed = 0;

/**
 * At recall start: adopt a fresh turn iff the prompt-hook stamped a new
 * `turn_id` (Issue #51 — replaces the old `state === "idle"` trigger that
 * let late idle markers clobber parallel-recall counts). This is the only
 * disk READ in the hot path. Keeps the latest vault_size across the reset.
 */
function syncStatuslineTurn(): void {
  try {
    const onDisk = JSON.parse(
      fs.readFileSync(STATUSLINE_FEED_PATH, "utf8"),
    ) as Partial<StatuslineState>;
    liveStatusline = adoptTurn(liveStatusline, onDisk);
  } catch {
    // no file / unreadable — keep in-memory state
  }
}

let statuslineDirEnsured = false;

/** Flush in-memory state to disk (atomic). Write-only — never reads. */
function flushStatusline(): void {
  try {
    if (!statuslineDirEnsured) {
      fs.mkdirSync(STATUSLINE_DIR, { recursive: true });
      statuslineDirEnsured = true;
    }
    liveStatusline.ts = Date.now();
    const tmp = `${STATUSLINE_FEED_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(liveStatusline), { encoding: "utf8" });
    fs.renameSync(tmp, STATUSLINE_FEED_PATH);
  } catch {
    // Best-effort — never fail the recall over a statusline write.
  }
}

function parseSseFrame(frame: string): { type: string; data: unknown } | null {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event || !data) return null;
  try {
    return { type: event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error("[bastra-recall-mcp] FATAL:", err);
  process.exit(1);
});
