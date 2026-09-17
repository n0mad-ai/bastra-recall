/**
 * Route dispatch for the loopback-only surface: the liveness/introspection
 * doors (/health, /tools, /vault/count), the hook lanes that still answer
 * inline (/hook/prompt, /hook/write, the two bash lanes), the read-only hook
 * companions (/hook/taxonomy, /hook/drift, /hook/care, /hook/floors), the
 * curator endpoints and /settings/docs. Returns true when the request was
 * handled.
 *
 * None of these carry auth — they are loopback-only by design and the DNS-
 * rebinding host gate in http.ts runs BEFORE this dispatcher. Everything
 * token-gated lives on /api/v1/* (http-api-surface.ts) instead.
 *
 * Split out of http.ts (file-size convention); the route order is preserved
 * exactly — these are sequential early returns, and /settings/docs in
 * particular answers 405 for any method it does not know, so it must stay
 * behind the GET routes above it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Vault } from "@bastra-recall/core";
import { truncateSummaryTo } from "@bastra-recall/core";
import { type Telemetry } from "./telemetry.js";
import { handleHookReflex, reflexPoolIds } from "./reflex.js";
import { runPromptLane, type ClaudeHookPayload } from "./prompt-lane.js";
import { runWriteLane, type WriteHookPayload } from "./write-lane.js";
import { runBashPreLane, type BashHookPayload } from "./bash-pre-lane.js";
import { runBashFailLane, type BashFailPayload } from "./bash-fail-lane.js";
import { dispatchLaneRoutes } from "./http-lane-routes.js";
import { distinctiveTokensForActedOn, type ToolDeps } from "./tool-handlers.js";
import { handleHookCare } from "./webui.js";
import { listConventions, detectTaxonomyDrift } from "./taxonomy.js";
import { listFloors } from "./floors.js";
import { handleCuratorRun, handleCuratorState, type CuratorRunDeps } from "./curator-run.js";
import {
  getDocsLanguage,
  getDocsMode,
  setDocsLanguage,
  setDocsMode,
  isDocsMode,
  isDocsLanguage,
  DOCS_MODES,
} from "./settings.js";
import { ALL_TOOL_DEFS, filterToolDefsForSurface, toolSurfaceFrom } from "./tool-defs.js";
import { MAX_BODY_BYTES, readJsonBody, sendJson } from "./http-util.js";
import { handleHookRecall } from "./http-hook-routes.js";
import { handleHookAct } from "./http-hook-act.js";

export interface LocalRouteCtx {
  vault: Vault;
  telemetry: Telemetry;
  toolDeps: ToolDeps;
  /** Reachability + vault size, shared by /health and /api/v1/health. */
  healthPayload: () => Record<string, unknown>;
  /** Curator-Deps (#155/#156) für die /curator/*-Loopback-Endpoints. */
  curator?: CuratorRunDeps;
}

export function dispatchLocalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  /** Request start, for the hook-recall telemetry path. */
  t0: number,
  ctx: LocalRouteCtx,
): boolean {
  const { vault, telemetry, toolDeps, healthPayload } = ctx;
  const { search } = toolDeps;

  if (method === "GET" && url === "/health") {
    sendJson(res, 200, healthPayload());
    return true;
  }

  // The daemon's own tool definitions (#132): the stdio forwarder fetches
  // these so the schema a client is told always matches what THIS daemon
  // validates — no skew when a forwarder build is newer than the daemon code
  // in RAM. Loopback-only + token-free like /health (the Host-gate in http.ts
  // covers it; this is non-/api/v1).
  // #481: `?surface=search|write|full` narrows the list to what that client's
  // tool surface allows. Absent or unknown → `full`, today's behaviour.
  if (method === "GET" && (url === "/tools" || url.startsWith("/tools?"))) {
    const surface = toolSurfaceFrom(
      new URL(url, "http://127.0.0.1").searchParams.get("surface") ?? undefined,
    );
    sendJson(res, 200, { tools: filterToolDefsForSurface(ALL_TOOL_DEFS, surface) });
    return true;
  }

  if (method === "GET" && url === "/vault/count") {
    // Reconcile the index against disk before answering — the fs watcher
    // misses external writes/deletes on cloud-storage mounts, so a plain
    // vault.size() can be stale. This is the fresh count the `bastra` status
    // panel reads. Falls back to the in-memory size if reconcile throws.
    vault
      .reconcile()
      .then((count) => sendJson(res, 200, { count }))
      .catch(() => sendJson(res, 200, { count: vault.size() }));
    return true;
  }

  if (method === "POST" && url === "/hook/recall") {
    handleHookRecall(req, res, t0, vault, search, telemetry, toolDeps.learnedBridges, toolDeps.sharedRecallLang, toolDeps.embeddingDegraded, toolDeps.evidenceGateEnabled, toolDeps.deadlineShadow);
    return true;
  }

  // #217 Reflex-Lane: hartes recall_when-Matching ohne aktive Query, nur
  // über reflex-markierte Memories. Loopback-only wie /hook/recall.
  if (method === "POST" && url === "/hook/reflex") {
    handleHookReflex(req, res, t0, vault, telemetry);
    return true;
  }

  // #343 (stage A of #305 direction 2): the full UserPromptSubmit pipeline,
  // server-side. The thin client POSTs {payload, client_ppid} and writes the
  // response body to stdout verbatim, so this endpoint returns the exact
  // document Claude Code expects — `{}` or the hookSpecificOutput envelope —
  // and fails open to `{}` with 200: the client must never see an error it
  // would only translate back into `{}` anyway. Loopback-only like
  // /hook/recall. Logic lives in prompt-lane.ts; this stays a route.
  if (method === "POST" && url === "/hook/prompt") {
    readJsonBody(req, MAX_BODY_BYTES)
      .then(async (body) => {
        const payload = (body.payload ?? {}) as ClaudeHookPayload;
        const ppid = typeof body.client_ppid === "number" ? body.client_ppid : null;
        const self = `http://127.0.0.1:${req.socket.localPort ?? 6723}`;
        // #361: the prewarmer rides in from toolDeps — the lane fires it at
        // turn start and never awaits the embed behind it.
        // #371: the wired reflex pool rides in from the vault index. Mode
        // "none" — 91% of prompts — can inject nothing else, so the lane
        // uses it to decide whether the full-vault recall is worth paying
        // for at all.
        const out = await runPromptLane(payload, ppid, self, toolDeps.prewarmEmbedding, () =>
          reflexPoolIds(vault),
        );
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(out);
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end("{}");
      });
    return true;
  }

  // #343 second half: same contract as /hook/prompt, for the PreToolUse
  // Write/Edit lane. The skip gate stays in the thin client (pure stdlib,
  // fires on the majority of calls), so everything arriving here already
  // survived it. No client_ppid — this lane touches no statusline feed.
  if (method === "POST" && url === "/hook/write") {
    readJsonBody(req, MAX_BODY_BYTES)
      .then(async (body) => {
        const payload = (body.payload ?? {}) as WriteHookPayload;
        const self = `http://127.0.0.1:${req.socket.localPort ?? 6723}`;
        const out = await runWriteLane(payload, self, toolDeps.vaultPath);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(out);
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end("{}");
      });
    return true;
  }

  // #343 pattern, bash lanes: same contract as /hook/prompt and /hook/write.
  // No client-side content gates — the pattern tables and invokesOwnBinary
  // are gate logic that must stay hot-swappable, so they live in the lanes.
  if (method === "POST" && url === "/hook/bash-pre") {
    readJsonBody(req, MAX_BODY_BYTES)
      .then(async (body) => {
        const out = await runBashPreLane(
          (body.payload ?? {}) as BashHookPayload,
          `http://127.0.0.1:${req.socket.localPort ?? 6723}`,
        );
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(out);
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end("{}");
      });
    return true;
  }
  if (method === "POST" && url === "/hook/bash-fail") {
    readJsonBody(req, MAX_BODY_BYTES)
      .then(async (body) => {
        const out = await runBashFailLane(
          (body.payload ?? {}) as BashFailPayload,
          `http://127.0.0.1:${req.socket.localPort ?? 6723}`,
        );
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(out);
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end("{}");
      });
    return true;
  }

  // #369, same pattern, three more lanes: /hook/stop, /hook/session,
  // /hook/todo. Their routes live in http-lane-routes.ts (file-size
  // convention) — the contract is identical to the four above.
  // #490: the session lane among them takes the shared embedding warm-up,
  // injected here the same way the prompt lane takes its prewarmer.
  if (dispatchLaneRoutes(req, res, method, url, toolDeps.warmupEmbedding)) return true;

  // #144: lightweight act-signal (PostToolUse:Bash). No recall, no injection —
  // only matches the excerpt against open loadedMemories episodes so
  // shell-driven applications of a memory can close them. Loopback-only
  // (Host-Gate in http.ts), no auth — same trust level as /hook/recall.
  if (method === "POST" && url === "/hook/act") {
    handleHookAct(req, res, telemetry);
    return true;
  }

  // Surfaced-Feedback (#154): die Hook-CLI meldet die ids, die sie nach
  // ihrem client-seitigen Filtern WIRKLICH injiziert hat — nur die zählen
  // als "surfaced" im Usage-Sidecar. Loopback-only wie /hook/act.
  if (method === "POST" && url === "/hook/hinted") {
    readJsonBody(req, MAX_BODY_BYTES)
      .then((body) => {
        const ids = Array.isArray((body as { ids?: unknown })?.ids)
          ? ((body as { ids: unknown[] }).ids.filter((x) => typeof x === "string") as string[])
          : [];
        telemetry.recordSurfacedUsage(ids);
        // #478 Part 2 (shadow): open an act-detection window for what was
        // actually injected.
        //
        // TWO REVIEW FINDS SHAPE THIS (Vera, 06.09.):
        //
        // 1. Tokens come from what the model SAW. The lanes print
        //    `id (type): summary` (`write-lane.ts:384-391`) or
        //    `id (type/scope): summary` (`session-lane.ts:653-659`) — the ID
        //    and the truncated summary, never the body and never the title.
        //    Matching the body would score a hint as followed on words
        //    nobody read; matching the title would do the same for a title
        //    that is not on screen. The id is split on its slug separators
        //    first: `distinctiveTokensForActedOn` keeps `a-b` as one token
        //    (`save-similarity.ts` tokenizer), so a reader typing the words
        //    of the id they just saw would otherwise never match. `type` and
        //    `scope` stay out on purpose — they are rubrics, and counting a
        //    later command that merely says "lesson" would be a false
        //    positive by construction.
        //
        // 2. No session id, no window. Without it the entry lands on an
        //    `inferred` turn, where the session lock in `matchLoadedMemories`
        //    does not apply and a command from a PARALLEL session can close
        //    it. A missing number beats a number about the wrong session.
        //    `recordSurfacedUsage` above is unaffected — it never needed one.
        const hintedSession =
          typeof (body as { session_id?: unknown })?.session_id === "string"
            && (body as { session_id: string }).session_id.length > 0
            ? (body as { session_id: string }).session_id
            : null;
        if (hintedSession) {
          telemetry.recordSurfacedHints(
            ids.flatMap((id) => {
              const memory = vault.get(id);
              if (!memory) return [];
              const shown = `${id.replace(/[-_]+/g, " ")} ${truncateSummaryTo(String(memory.fm.summary ?? ""), 160)}`;
              return [{ memory_id: id, distinctive_tokens: distinctiveTokensForActedOn(shown) }];
            }),
            hintedSession,
          );
        }
        sendJson(res, 200, { ok: true, counted: ids.length });
      })
      .catch(() => sendJson(res, 400, { error: "invalid body" }));
    return true;
  }

  // Curator (#155/#156): Loopback-only wie /hook/* (Host-Gate in http.ts).
  // GET = State lesen; POST = manueller Lauf, default dry-run (Review-
  // Anfrage, kein Demote-Consent) — Handler leben in curator-run.ts.
  if (ctx.curator && method === "GET" && url === "/curator/state") {
    handleCuratorState(req, res, ctx.curator);
    return true;
  }
  if (ctx.curator && method === "POST" && url === "/curator/run") {
    handleCuratorRun(req, res, ctx.curator);
    return true;
  }

  // Selbstlernende Taxonomie (#64): Konventions-Liste für die Session-Hook-
  // Injection (#66) und Drift-Analyse für den Stop-Hook (#67). Beides
  // loopback-only (Host-Gate in http.ts), read-only, kein Auth — wie
  // /hook/recall.
  if (method === "GET" && url === "/hook/taxonomy") {
    sendJson(res, 200, { conventions: listConventions(vault) });
    return true;
  }
  if (method === "GET" && url === "/hook/drift") {
    sendJson(res, 200, { clusters: detectTaxonomyDrift(vault) });
    return true;
  }

  // Vault-care count für die Session-Hook-Injection (#207): loopback-only,
  // read-only, kein Auth — wie /hook/taxonomy.
  if (method === "GET" && url === "/hook/care") {
    handleHookCare(res, toolDeps.vaultPath).catch(() => sendJson(res, 200, { open: 0 }));
    return true;
  }

  // Floor-Registry (#141/#142): Einträge für die Session-Hook-Injection.
  // Loopback-only (Host-Gate in http.ts), read-only, kein Auth — wie
  // /hook/taxonomy. Der Join id→title/summary passiert HIER via vault.get,
  // damit die Hook-CLI dumm bleibt (ein GET, keine per-Eintrag-Roundtrips).
  // Ein nicht auflösbarer Eintrag kommt ohne title zurück — sichtbar statt
  // still (stale floor).
  if (method === "GET" && (url === "/hook/floors" || url.startsWith("/hook/floors?"))) {
    const u = new URL(url, "http://127.0.0.1");
    const scope = u.searchParams.get("scope") ?? undefined;
    listFloors(scope)
      .then((entries) => {
        const floors = entries.map((e) => {
          const mem = vault.get(e.memory_id);
          return {
            ...e,
            ...(mem ? { title: mem.fm.title, summary: mem.fm.summary } : {}),
          };
        });
        sendJson(res, 200, { floors });
      })
      .catch(() => sendJson(res, 200, { floors: [] }));
    return true;
  }

  // Produkt-Doku-Settings für die Mac-App-Options-Pane: GET liest, POST
  // schreibt nach ~/.bastra/cli-settings.json (das OSS-owned Settings-File —
  // die App fasst es so nie direkt an). Loopback-only wie /hook/* (Host-Gate
  // in http.ts); kein Token, weil dieselbe Maschine + derselbe User.
  if (url === "/settings/docs") {
    if (method === "GET") {
      Promise.all([getDocsMode(), getDocsLanguage()])
        .then(([mode, language]) => sendJson(res, 200, { mode, language }))
        .catch((err: Error) => sendJson(res, 500, { error: err.message }));
      return true;
    }
    if (method === "POST") {
      readJsonBody(req, MAX_BODY_BYTES)
        .then(async (body) => {
          const mode = body.mode;
          const language = body.language;
          if (mode !== undefined && !isDocsMode(mode)) {
            sendJson(res, 400, { error: `mode must be one of: ${DOCS_MODES.join(" | ")}` });
            return;
          }
          if (language !== undefined && !isDocsLanguage(language)) {
            sendJson(res, 400, { error: "language must be a short tag like 'en', 'de', 'pt-br'" });
            return;
          }
          if (isDocsMode(mode)) await setDocsMode(mode);
          if (isDocsLanguage(language)) await setDocsLanguage(language);
          sendJson(res, 200, { mode: await getDocsMode(), language: await getDocsLanguage() });
        })
        .catch((err: Error) => sendJson(res, 400, { error: err.message }));
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  return false;
}
