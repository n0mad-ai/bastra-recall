/** Graph projections shared by two explicitly different access surfaces.
 * /api/v1/graph* stays filtered behind its REST gate. /ui/graph* includes the
 * user's private memories after http.ts's UI account/Host/forwarding gates.
 * No request parameter can select the privileged projection. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { relative, sep } from "node:path";
import { buildGraph, buildSemanticLayout, type SemanticLayout, type Vault } from "@bastra-recall/core";
import type { HttpServerContext } from "./http-context.js";
import type { ToolDeps } from "./tool-handlers.js";
import { listSkills } from "./skills-registry.js";
import { computeHeat, computeReach, readUsage } from "./usage-sidecar.js";
import { recallDaily } from "./recall-daily.js";
import { defaultLogDir } from "./learned-recall/harvest.js";
import { getUiEnabled } from "./settings.js";
import { sendJson } from "./http-util.js";
import { memoryEditInfo } from "./webui-memory-edit.js";

export interface GraphReadCtx {
  vault: Vault;
  toolDeps: ToolDeps;
  embeddingVectors?: () => ReadonlyMap<string, Float32Array> | null;
  server: HttpServerContext;
  /** Set by http.ts only after a proven peer-account check (fail closed). */
  privateGraph?: boolean;
}

export function isGraphReadPath(path: string, prefix: string): boolean {
  return path === prefix || path === `${prefix}/node` || path === `${prefix}/semantic`;
}

/** Share a layout only while its projection is still current. A sensitivity
 *  edit drops both the cached layout and any build that could repopulate it. */
async function sendSemanticLayout(res: ServerResponse, ctx: GraphReadCtx, includePrivate: boolean): Promise<void> {
  const { server, vault } = ctx;
  const vecs = ctx.embeddingVectors?.() ?? null;
  if (!vecs || vecs.size === 0) {
    sendJson(res, 503, { error: "embeddings not ready" });
    return;
  }
  const cacheKey = includePrivate ? "uiSemanticCache" : "semanticCache";
  const inflightKey = includePrivate ? "uiSemanticInflight" : "semanticInflight";
  const cache = server[cacheKey];
  if (cache && Date.now() - cache.at <= 60_000) {
    sendJson(res, 200, cache.body);
    return;
  }
  if (!server[inflightKey]) {
    const build: Promise<SemanticLayout> = listSkills()
      .then((skills) => buildSemanticLayout(buildGraph(vault, skills, { includePrivate }), vecs))
      .then((body) => {
        if (server[inflightKey] === build) server[cacheKey] = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        if (server[inflightKey] === build) server[inflightKey] = null;
      });
    server[inflightKey] = build;
  }
  const body = await server[inflightKey];
  if (server[cacheKey]?.body !== body) return sendSemanticLayout(res, ctx, includePrivate);
  sendJson(res, 200, body);
}

/** Called only after the enclosing surface's access checks. */
export async function handleGraphRead(
  res: ServerResponse,
  url: string,
  ctx: GraphReadCtx,
  includePrivate: boolean
): Promise<void> {
  const { vault, toolDeps } = ctx;
  const u = new URL(url, "http://127.0.0.1");
  if (u.pathname.endsWith("/node")) {
    const id = u.searchParams.get("id") ?? "";
    const visibleMemory = () => {
      const candidate = vault.get(id);
      return candidate && (includePrivate || candidate.fm.sensitivity !== "private") ? candidate : null;
    };
    // Skip telemetry reads for unavailable notes; check again after a possible sensitivity change.
    const daily = visibleMemory() ? await recallDaily(defaultLogDir()) : null;
    const mem = daily && visibleMemory();
    if (!daily || !mem) {
      sendJson(res, 404, { error: `unknown node: ${id}` });
      return;
    }
    const { fm } = mem;
    const visibleTarget = (target: string) => includePrivate || vault.get(target)?.fm.sensitivity !== "private";
    sendJson(res, 200, {
      id: fm.id,
      title: fm.title,
      type: fm.type,
      scope: fm.scope,
      sensitivity: fm.sensitivity,
      topic_path: fm.topic_path,
      tags: fm.tags,
      summary: fm.summary,
      related: fm.related.filter(visibleTarget),
      source: fm.source ?? null,
      created: fm.created,
      updated: fm.updated,
      body: mem.body,
      recall_when: fm.recall_when,
      recall_mode: fm.recall_mode ?? null,
      related_via: fm.related_via.filter((link) => visibleTarget(link.id)),
      file: relative(toolDeps.vaultPath, mem.filePath).split(sep).join("/"),
      recall_days: daily.get(fm.id) ?? [],
      // #1446: the memory browser edits against this revision and shows the rule state.
      ...memoryEditInfo(mem),
    });
    return;
  }
  if (u.pathname.endsWith("/semantic")) return sendSemanticLayout(res, ctx, includePrivate);
  const skills = await listSkills();
  const usage = await readUsage(toolDeps.vaultPath);
  const heat = computeHeat(usage),
    reach = computeReach(usage);
  const daily = await recallDaily(defaultLogDir());
  const graph = buildGraph(vault, skills, { includePrivate });
  // Explicit zeros distinguish cold nodes from an absent feature (#217/#227).
  for (const n of graph.nodes) {
    n.heat = heat[n.id] ?? 0;
    n.reach = reach[n.id] ?? { loaded: 0, acted_on: 0, weight: 0, last_at: null };
    n.recall_days = daily.get(n.id) ?? [];
  }
  sendJson(res, 200, graph);
}

export function dispatchUiGraph(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  ctx: GraphReadCtx
): boolean {
  if (!isGraphReadPath(url.split("?", 1)[0]!, "/ui/graph")) return false;
  res.setHeader("Cache-Control", "no-store");
  void (async () => {
    if (!(await getUiEnabled())) {
      sendJson(res, 404, { error: "ui disabled" });
      return;
    }
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    await handleGraphRead(res, url, ctx, ctx.privateGraph === true);
  })().catch((err: Error) => sendJson(res, 500, { error: err.message }));
  return true;
}
