import { indexedActionConventions } from "./action-conventions.js";
import { recordDeliveredDraftHints } from "./draft-delivery.js";
import { cleanDraftField } from "./draft-text.js";
/**
 * Route dispatch for the loopback-only surface: the liveness/introspection
 * doors (/health, /tools, /vault/count), the hook lanes (/hook/prompt,
 * /hook/write, the two bash lanes and the lanes of http-lane-routes.ts, all
 * wired in http-hook-lanes.ts), the read-only hook companions (/hook/taxonomy,
 * /hook/drift, /hook/care, /hook/floors), the curator endpoints, /code/refresh
 * and /settings/docs. Returns true when the request was handled.
 *
 * None of these carry auth — they are loopback-only by design and the DNS-
 * rebinding host gate in http.ts runs BEFORE this dispatcher. Everything
 * token-gated lives on /api/v1/* (http-api-surface.ts) instead.
 *
 * Split out of http.ts (file-size convention). #1529: the former chain of
 * early returns is the route table `LOCAL_ROUTES`, in the same order. Every
 * path is listed once, so the order decides nothing: a route without a method
 * (/code/refresh, /settings/docs) takes every method and answers 405 for one
 * it does not know.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { truncateSummaryTo } from "@bastra-recall/core";
import { type Telemetry } from "./telemetry.js";
import { handleHookReflex } from "./reflex.js";
import { distinctiveTokensForActedOn } from "./tool-handlers.js";
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
import { filterToolDefsForSurface, servedToolDefs, toolSurfaceFrom } from "./tool-defs.js";
import { MAX_BODY_BYTES, readJsonBody, sendJson } from "./http-util.js";
import { handleHookRecall } from "./http-hook-routes.js";
import {
  dispatchHookLanes,
  handleHookBashFail,
  handleHookBashPre,
  handleHookPrompt,
  handleHookWrite,
  type HookLaneCtx,
} from "./http-hook-lanes.js";
import { handleHookAct } from "./http-hook-act.js";
import { toRefreshStatusRows } from "./code-graph/refresh-status.js";
import type { RepoStatus } from "./code-graph/refresh.js";

/** The code-graph refresh coordinator, as far as the CLI may see and poke it (#1148). */
export interface CodeRefreshDeps {
  status: () => RepoStatus[];
  enqueue: (repoRoot: string, reason: "manual") => void;
  allows: (repoRoot: string) => boolean;
}

export interface LocalRouteCtx extends HookLaneCtx {
  telemetry: Telemetry;
  /** Reachability + vault size, shared by /health and /api/v1/health. */
  healthPayload: () => Record<string, unknown>;
  /** Curator-Deps (#155/#156) für die /curator/*-Loopback-Endpoints. */
  curator?: CuratorRunDeps;
  /** Code-graph refresh state and the manual trigger (#1148), for /code/refresh. */
  codeRefresh?: CodeRefreshDeps;
  /** #1458: /tools lists the document write tools only when this daemon accepts them. */
  documentWriteEnabled: boolean;
}

/** One request as a route handler sees it. */
interface LocalRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: string;
  /** Request start, for the hook-recall telemetry path. */
  t0: number;
  ctx: LocalRouteCtx;
}

interface LocalRoute {
  /** Absent: the handler takes every method and answers 405 itself. */
  method?: "GET" | "POST";
  path: string;
  /** Also take the path with a query string (`path?…`). */
  query?: true;
  /** A route whose dependency this daemon was started without does not exist. */
  enabled?: (ctx: LocalRouteCtx) => boolean;
  handle: (request: LocalRequest) => void;
}

/**
 * The daemon's own tool definitions (#132): the stdio forwarder fetches these
 * so the schema a client is told always matches what THIS daemon validates —
 * no skew when a forwarder build is newer than the daemon code in RAM.
 * Loopback-only + token-free like /health (the Host-gate in http.ts covers
 * it; this is non-/api/v1).
 * #481: `?surface=search|write|full` narrows the list to what that client's
 * tool surface allows. Absent or unknown → `full`, today's behaviour.
 */
function handleTools({ res, url, ctx }: LocalRequest): void {
  const surface = toolSurfaceFrom(new URL(url, "http://127.0.0.1").searchParams.get("surface") ?? undefined);
  sendJson(res, 200, { tools: filterToolDefsForSurface(servedToolDefs(ctx.documentWriteEnabled), surface) });
}

function handleVaultCount({ res, ctx: { vault } }: LocalRequest): void {
  // Reconcile the index against disk before answering — the fs watcher
  // misses external writes/deletes on cloud-storage mounts, so a plain
  // vault.size() can be stale. This is the fresh count the `bastra` status
  // panel reads. Falls back to the in-memory size if reconcile throws.
  vault
    .reconcile()
    .then((count) => sendJson(res, 200, { count }))
    .catch(() => sendJson(res, 200, { count: vault.size() }));
}

function handleActionConventions({ req, res, ctx: { vault } }: LocalRequest): void {
  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      if (body.category !== "github-issues-prs") {
        sendJson(res, 400, { error: "Unknown structural category" });
        return;
      }
      sendJson(
        res,
        200,
        await indexedActionConventions(
          vault,
          typeof body.project === "string" ? body.project : null,
          "github-issues-prs"
        )
      );
    })
    .catch(() => sendJson(res, 200, { hits: [], unavailable: true }));
}

function handleRecall({ req, res, t0, ctx: { vault, telemetry, toolDeps } }: LocalRequest): void {
  handleHookRecall(
    req,
    res,
    t0,
    vault,
    toolDeps.search,
    telemetry,
    toolDeps.learnedBridges,
    toolDeps.sharedRecallLang,
    toolDeps.embeddingDegraded,
    toolDeps.evidenceGateEnabled,
    toolDeps.deadlineShadow
  );
}

/**
 * Surfaced-Feedback (#154): die Hook-CLI meldet die ids, die sie nach ihrem
 * client-seitigen Filtern WIRKLICH injiziert hat — nur die zählen als
 * "surfaced" im Usage-Sidecar. Loopback-only wie /hook/act.
 */
function handleHinted({ req, res, ctx: { vault, telemetry } }: LocalRequest): void {
  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
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
        typeof (body as { session_id?: unknown })?.session_id === "string" &&
        (body as { session_id: string }).session_id.length > 0
          ? cleanDraftField((body as { session_id: string }).session_id)
          : null;
      {
        telemetry.recordSurfacedHints(
          ids.flatMap((id) => {
            const memory = vault.get(id);
            if (!memory) return [];
            const shown = `${id.replace(/[-_]+/g, " ")} ${truncateSummaryTo(String(memory.fm.summary ?? ""), 160)}`;
            return [{ memory_id: id, distinctive_tokens: distinctiveTokensForActedOn(shown) }];
          }),
          hintedSession
        );
      }
      const draftIds = Array.isArray(body.draft_ids)
        ? body.draft_ids.filter((id): id is string => typeof id === "string")
        : [];
      const draftCount = await recordDeliveredDraftHints(
        draftIds,
        hintedSession,
        typeof body.draft_input === "string" ? body.draft_input : null
      );
      sendJson(res, 200, {
        ok: true,
        counted: ids.length,
        ...(draftCount > 0 ? { drafts_counted: draftCount } : {}),
      });
    })
    .catch(() => sendJson(res, 400, { error: "invalid body" }));
}

/**
 * Code-graph refresh (#1148): GET says per repository whether the automatic
 * refresh is running, paused on a busy lock or stopped after failed builds,
 * and when the next attempt is due. POST {repo} is the `manual` request the
 * coordinator honours above any pause: `bastra code index` sends it after its
 * own build. Loopback-only, no auth, like /health — the repository path is the
 * caller's own, and a refresh of an enabled repository is what the daemon does
 * on every file save anyway.
 */
function handleCodeRefresh({ req, res, method, ctx }: LocalRequest): void {
  const refresh = ctx.codeRefresh as CodeRefreshDeps;
  if (method === "GET") {
    sendJson(res, 200, { repos: toRefreshStatusRows(refresh.status()) });
    return;
  }
  if (method === "POST") {
    readJsonBody(req, MAX_BODY_BYTES)
      .then((body) => {
        const repo = (body as { repo?: unknown }).repo;
        if (typeof repo !== "string" || repo.length === 0) {
          sendJson(res, 400, { error: "repo must be an absolute repository path" });
          return;
        }
        // An arbitrary path must not get a permanent entry in the coordinator.
        if (!refresh.allows(repo)) {
          sendJson(res, 404, { error: "code awareness is not enabled for this repository" });
          return;
        }
        refresh.enqueue(repo, "manual");
        sendJson(res, 200, { ok: true, repos: toRefreshStatusRows(refresh.status()) });
      })
      .catch((err: Error) => sendJson(res, 400, { error: err.message }));
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

/**
 * Floor-Registry (#141/#142): Einträge für die Session-Hook-Injection. Der
 * Join id→title/summary passiert HIER via vault.get, damit die Hook-CLI dumm
 * bleibt (ein GET, keine per-Eintrag-Roundtrips). Ein nicht auflösbarer
 * Eintrag kommt ohne title zurück — sichtbar statt still (stale floor).
 */
function handleFloors({ res, url, ctx: { vault } }: LocalRequest): void {
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
}

/**
 * Produkt-Doku-Settings für die Mac-App-Options-Pane: GET liest, POST
 * schreibt nach ~/.bastra/cli-settings.json (das OSS-owned Settings-File —
 * die App fasst es so nie direkt an). Kein Token, weil dieselbe Maschine +
 * derselbe User.
 */
function handleDocsSettings({ req, res, method }: LocalRequest): void {
  if (method === "GET") {
    Promise.all([getDocsMode(), getDocsLanguage()])
      .then(([mode, language]) => sendJson(res, 200, { mode, language }))
      .catch((err: Error) => sendJson(res, 500, { error: err.message }));
    return;
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
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

/** The loopback routes, in the order the former branch chain checked them. */
const LOCAL_ROUTES: readonly LocalRoute[] = [
  { method: "GET", path: "/health", handle: ({ res, ctx }) => sendJson(res, 200, ctx.healthPayload()) },
  { method: "GET", path: "/tools", query: true, handle: handleTools },
  { method: "GET", path: "/vault/count", handle: handleVaultCount },
  { method: "POST", path: "/hook/action-conventions", handle: handleActionConventions },
  { method: "POST", path: "/hook/recall", handle: handleRecall },
  // #217 Reflex-Lane: hartes recall_when-Matching ohne aktive Query, nur
  // über reflex-markierte Memories. Loopback-only wie /hook/recall.
  {
    method: "POST",
    path: "/hook/reflex",
    handle: ({ req, res, t0, ctx }) => handleHookReflex(req, res, t0, ctx.vault, ctx.telemetry),
  },
  { method: "POST", path: "/hook/prompt", handle: ({ req, res, ctx }) => handleHookPrompt(req, res, ctx) },
  { method: "POST", path: "/hook/write", handle: ({ req, res, ctx }) => handleHookWrite(req, res, ctx) },
  { method: "POST", path: "/hook/bash-pre", handle: ({ req, res, ctx }) => handleHookBashPre(req, res, ctx) },
  { method: "POST", path: "/hook/bash-fail", handle: ({ req, res, ctx }) => handleHookBashFail(req, res, ctx) },
  // #144: lightweight act-signal (PostToolUse:Bash). No recall, no injection —
  // only matches the excerpt against open loadedMemories episodes so
  // shell-driven applications of a memory can close them. Same trust level as
  // /hook/recall.
  { method: "POST", path: "/hook/act", handle: ({ req, res, ctx }) => handleHookAct(req, res, ctx.telemetry) },
  { method: "POST", path: "/hook/hinted", handle: handleHinted },
  // Curator (#155/#156): GET = State lesen; POST = manueller Lauf, default
  // dry-run (Review-Anfrage, kein Demote-Consent) — Handler leben in
  // curator-run.ts.
  {
    method: "GET",
    path: "/curator/state",
    enabled: (ctx) => Boolean(ctx.curator),
    handle: ({ req, res, ctx }) => handleCuratorState(req, res, ctx.curator as CuratorRunDeps),
  },
  {
    method: "POST",
    path: "/curator/run",
    enabled: (ctx) => Boolean(ctx.curator),
    handle: ({ req, res, ctx }) => handleCuratorRun(req, res, ctx.curator as CuratorRunDeps),
  },
  { path: "/code/refresh", enabled: (ctx) => Boolean(ctx.codeRefresh), handle: handleCodeRefresh },
  // Selbstlernende Taxonomie (#64): Konventions-Liste für die Session-Hook-
  // Injection (#66) und Drift-Analyse für den Stop-Hook (#67). Read-only.
  {
    method: "GET",
    path: "/hook/taxonomy",
    handle: ({ res, ctx }) => sendJson(res, 200, { conventions: listConventions(ctx.vault) }),
  },
  {
    method: "GET",
    path: "/hook/drift",
    handle: ({ res, ctx }) => sendJson(res, 200, { clusters: detectTaxonomyDrift(ctx.vault) }),
  },
  // Vault-care count für die Session-Hook-Injection (#207), read-only.
  {
    method: "GET",
    path: "/hook/care",
    handle: ({ res, ctx }) => {
      handleHookCare(res, ctx.toolDeps.vaultPath).catch(() => sendJson(res, 200, { open: 0 }));
    },
  },
  { method: "GET", path: "/hook/floors", query: true, handle: handleFloors },
  { path: "/settings/docs", handle: handleDocsSettings },
];

function routeMatches(route: LocalRoute, method: string, url: string, ctx: LocalRouteCtx): boolean {
  if (route.method !== undefined && route.method !== method) return false;
  if (url !== route.path && !(route.query && url.startsWith(`${route.path}?`))) return false;
  return route.enabled === undefined || route.enabled(ctx);
}

export function dispatchLocalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  /** Request start, for the hook-recall telemetry path. */
  t0: number,
  ctx: LocalRouteCtx
): boolean {
  const route = LOCAL_ROUTES.find((candidate) => routeMatches(candidate, method, url, ctx));
  if (route) {
    route.handle({ req, res, method, url, t0, ctx });
    return true;
  }
  // POST /hook/stop, /hook/session, /hook/todo, /hook/gate: none of them is a
  // path of the table above.
  return dispatchHookLanes(req, res, method, url, ctx);
}
