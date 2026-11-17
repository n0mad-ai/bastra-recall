/**
 * #1472 — doctor asks, per installed client, whether the MCP tool list
 * actually arrives, and what it costs.
 *
 * The registration checks above it only read config files. A client whose
 * forwarder cannot reach the daemon still starts — it falls back to the tool
 * list bundled with the CLI — and the user only notices that the agent "does
 * not remember". This asks the daemon the same question the forwarder asks
 * (`GET /tools?surface=<the client's surface>`), read-only, and reports the
 * answer per client together with the size of that list: the context every
 * session of that client pays before anything has been recalled.
 *
 * A NOTE like the other global blocks: never a failure, never a write.
 */
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { toolSurfaceFrom, type ToolSurface } from "../tool-defs.js";
import { existingToolSurface } from "./helpers.js";

/** The surface a client's MCP entry selects; no BASTRA_TOOL_SURFACE means the forwarder's default. */
export function clientMcpSurface(entry: unknown): ToolSurface {
  return existingToolSurface(entry) ?? toolSurfaceFrom(undefined);
}

export type ToolListProbe = { ok: true; tools: number; bytes: number } | { ok: false; detail: string };

/** One GET, as the forwarder makes it; injectable for tests. */
export type FetchTools = (surface: ToolSurface) => Promise<ToolListProbe>;

const TIMEOUT_MS = 2_000;

export function fetchToolsFromDaemon(baseUrl = resolveDaemonEndpoint().baseUrl): FetchTools {
  return async (surface) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(`${baseUrl}/tools?surface=${encodeURIComponent(surface)}`, { signal: ctrl.signal });
      if (!resp.ok) return { ok: false, detail: `daemon answered HTTP ${resp.status}` };
      const body = (await resp.json()) as { tools?: unknown };
      if (!Array.isArray(body.tools)) return { ok: false, detail: "daemon sent no tool list" };
      return { ok: true, tools: body.tools.length, bytes: JSON.stringify(body.tools).length };
    } catch (error) {
      return { ok: false, detail: `daemon not reachable (${(error as Error).message})` };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** ~4 characters per token, the estimate the recall budgets use too. */
const tokens = (bytes: number): number => Math.round(bytes / 4);

/** Pure formatter (exported for tests). */
export function deliveryLines(
  rows: Array<{ surface: string; mcpSurface: ToolSurface; probe: ToolListProbe }>
): string[] {
  if (rows.length === 0) return [];
  const lines = ["→ delivery per client (what the daemon hands each client right now)"];
  for (const { surface, mcpSurface, probe } of rows) {
    lines.push(
      probe.ok
        ? `  ✓ ${surface}: MCP lists ${probe.tools} tools (surface ${mcpSurface}), ~${tokens(probe.bytes)} tokens per session start`
        : `  ⚠ ${surface}: MCP tool list not delivered by the daemon: ${probe.detail}; the client falls back to the bundled list until it is reachable`
    );
  }
  return lines;
}

/** Doctor's printer: never throws, never changes the exit code. */
export async function printDeliveryNote(
  clients: Array<{ surface: string; mcpSurface?: ToolSurface }>,
  fetchTools: FetchTools = fetchToolsFromDaemon()
): Promise<void> {
  try {
    const rows = [];
    for (const { surface, mcpSurface } of clients) {
      if (!mcpSurface) continue;
      rows.push({ surface, mcpSurface, probe: await fetchTools(mcpSurface) });
    }
    const lines = deliveryLines(rows);
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n\n`);
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
