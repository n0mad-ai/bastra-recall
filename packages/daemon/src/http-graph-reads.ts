/** Graph projections shared by two explicitly different access surfaces.
 * /api/v1/graph* stays filtered behind its REST gate. /ui/graph* includes the
 * user's private memories after http.ts's UI account/Host/forwarding gates.
 * No request parameter can select the privileged projection. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { relative, sep } from "node:path";
import { buildGraph, buildSemanticLayout, type Vault } from "@bastra-recall/core";
import type { HttpServerContext } from "./http-context.js";
import type { ToolDeps } from "./tool-handlers.js";
import { listSkills } from "./skills-registry.js";
import { computeHeat, computeReach, readUsage } from "./usage-sidecar.js";
import { recallDaily } from "./recall-daily.js";
import { defaultLogDir } from "./learned-recall/harvest.js";
import { getUiEnabled } from "./settings.js";
import { sendJson } from "./http-util.js";

export interface GraphReadCtx {
  vault: Vault;
  toolDeps: ToolDeps;
  embeddingVectors?: () => ReadonlyMap<string, Float32Array> | null;
  server: HttpServerContext;
}

export function isGraphReadPath(path: string, prefix: string): boolean {
  return path === prefix || path === `${prefix}/node` || path === `${prefix}/semantic`;
}

/** Called only after the enclosing surface's access checks. */
export async function handleGraphRead(res: ServerResponse, url: string, ctx: GraphReadCtx, includePrivate: boolean): Promise<void> {
  const { vault, toolDeps, server } = ctx;
  const u = new URL(url, "http://127.0.0.1");
  if (u.pathname.endsWith("/node")) {
    const id = u.searchParams.get("id") ?? "";
    const mem = vault.get(id);
    if (!mem || (!includePrivate && mem.fm.sensitivity === "private")) {
      sendJson(res, 404, { error: `unknown node: ${id}` }); return;
    }
    const { fm } = mem;
    const visibleTarget = (target: string) => includePrivate || vault.get(target)?.fm.sensitivity !== "private";
    sendJson(res, 200, {
      id: fm.id, title: fm.title, type: fm.type, scope: fm.scope,
      sensitivity: fm.sensitivity, topic_path: fm.topic_path, tags: fm.tags,
      summary: fm.summary, related: fm.related.filter(visibleTarget),
      source: fm.source ?? null, created: fm.created, updated: fm.updated,
      body: mem.body, recall_when: fm.recall_when, recall_mode: fm.recall_mode ?? null,
      related_via: fm.related_via.filter(link => visibleTarget(link.id)),
      file: relative(toolDeps.vaultPath, mem.filePath).split(sep).join("/"),
      recall_days: (await recallDaily(defaultLogDir())).get(fm.id) ?? [],
    });
    return;
  }
  if (u.pathname.endsWith("/semantic")) {
    const vecs = ctx.embeddingVectors?.() ?? null;
    if (!vecs || vecs.size === 0) { sendJson(res, 503, { error: "embeddings not ready" }); return; }
    const cacheKey = includePrivate ? "uiSemanticCache" : "semanticCache";
    const inflightKey = includePrivate ? "uiSemanticInflight" : "semanticInflight";
    const cache = server[cacheKey];
    if (cache && Date.now() - cache.at <= 60_000) { sendJson(res, 200, cache.body); return; }
    server[inflightKey] ??= (async () => {
      const body = await buildSemanticLayout(buildGraph(vault, await listSkills(), { includePrivate }), vecs);
      server[cacheKey] = { at: Date.now(), body };
      return body;
    })().finally(() => { server[inflightKey] = null; });
    sendJson(res, 200, await server[inflightKey]);
    return;
  }
  const graph = buildGraph(vault, await listSkills(), { includePrivate });
  const usage = await readUsage(toolDeps.vaultPath);
  const heat = computeHeat(usage), reach = computeReach(usage);
  const daily = await recallDaily(defaultLogDir());
  // Explicit zeros distinguish cold nodes from an absent feature (#217/#227).
  for (const n of graph.nodes) {
    n.heat = heat[n.id] ?? 0;
    n.reach = reach[n.id] ?? { loaded: 0, acted_on: 0, weight: 0, last_at: null };
    n.recall_days = daily.get(n.id) ?? [];
  }
  sendJson(res, 200, graph);
}

export function dispatchUiGraph(req: IncomingMessage, res: ServerResponse, method: string, url: string, ctx: GraphReadCtx): boolean {
  if (!isGraphReadPath(url.split("?", 1)[0]!, "/ui/graph")) return false;
  res.setHeader("Cache-Control", "no-store");
  void (async () => {
    if (!(await getUiEnabled())) { sendJson(res, 404, { error: "ui disabled" }); return; }
    if (method !== "GET") { sendJson(res, 405, { error: "method not allowed" }); return; }
    await handleGraphRead(res, url, ctx, true);
  })().catch((err: Error) => sendJson(res, 500, { error: err.message }));
  return true;
}
