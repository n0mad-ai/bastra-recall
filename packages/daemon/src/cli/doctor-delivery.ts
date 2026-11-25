/**
 * #1472 — doctor asks, per installed client, whether the MCP tool list
 * actually arrives, and what it costs.
 *
 * The registration checks above it only read config files. A client whose
 * forwarder cannot reach the daemon still starts — it falls back to the tool
 * list bundled with the CLI — and the user only notices that the agent "does
 * not remember". This asks the daemon the same question the forwarder asks
 * (`GET /tools?surface=<the client's surface>`), read-only, and reports the
 * answer per client together with what that list costs at session start.
 *
 * Two numbers, because clients differ (owner decision 25.11.2026): Claude Code
 * and current Codex load only the tool names and the server instructions at
 * start and fetch a tool's description and schema when it is needed; that is
 * the start value. A client that loads every definition at once pays the full
 * list plus the instructions; that is shown as the addition.
 *
 * A NOTE like the other global blocks: never a failure, never a write.
 */
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { toolSurfaceFrom, type ToolSurface } from "../tool-defs.js";
import { existingToolSurface, SERVER_KEY } from "./helpers.js";
import { doctorNotesWordsIn } from "./doctor-notes-words.js";
import { serverInstructions } from "../mcp-instructions.js";
import { codeAwarenessDisabledByEnv, enabledRepos } from "../code-graph/enabled-repos.js";

/** The surface a client's MCP entry selects; no BASTRA_TOOL_SURFACE means the forwarder's default. */
export function clientMcpSurface(entry: unknown): ToolSurface {
  return existingToolSurface(entry) ?? toolSurfaceFrom(undefined);
}

/** `bytes`: the full definitions as JSON; `names`: the tool names as a deferring client lists them. */
export type ToolListProbe = { ok: true; tools: number; bytes: number; names: number } | { ok: false; detail: string };

/** One line per tool, named the way Claude Code and Codex list a deferred MCP tool. */
function listedNameChars(tools: unknown[]): number {
  return tools.map((tool) => `mcp__${SERVER_KEY}__${String((tool as { name?: unknown })?.name ?? "")}`).join("\n")
    .length;
}

/** The server instructions this machine's forwarder sends (same condition as mcp-forwarder.ts). */
export async function serverInstructionChars(): Promise<number> {
  const code = !codeAwarenessDisabledByEnv() && (await enabledRepos().catch(() => [])).length > 0;
  return serverInstructions(code).length;
}

/** One GET, as the forwarder makes it; injectable for tests. */
export type FetchTools = (surface: ToolSurface) => Promise<ToolListProbe>;

const TIMEOUT_MS = 2_000;

export function fetchToolsFromDaemon(baseUrl = resolveDaemonEndpoint().baseUrl, language = "en"): FetchTools {
  const w = doctorNotesWordsIn(language);
  return async (surface) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(`${baseUrl}/tools?surface=${encodeURIComponent(surface)}`, { signal: ctrl.signal });
      if (!resp.ok) return { ok: false, detail: w.deliveryHttp(resp.status) };
      const body = (await resp.json()) as { tools?: unknown };
      if (!Array.isArray(body.tools)) return { ok: false, detail: w.deliveryNoList };
      return {
        ok: true,
        tools: body.tools.length,
        bytes: JSON.stringify(body.tools).length,
        names: listedNameChars(body.tools),
      };
    } catch (error) {
      return { ok: false, detail: w.deliveryUnreachable((error as Error).message) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** ~4 characters per token, the estimate the recall budgets use too. */
const tokens = (bytes: number): number => Math.round(bytes / 4);

/** Pure formatter (exported for tests). `instructions`: characters of the server instructions. */
export function deliveryLines(
  rows: Array<{ surface: string; mcpSurface: ToolSurface; probe: ToolListProbe }>,
  language = "en",
  instructions = 0
): string[] {
  if (rows.length === 0) return [];
  const w = doctorNotesWordsIn(language);
  const lines = [w.deliveryHeader];
  for (const { surface, mcpSurface, probe } of rows) {
    lines.push(
      probe.ok
        ? w.deliveryOk(
            surface,
            probe.tools,
            mcpSurface,
            tokens(probe.names + instructions),
            tokens(probe.bytes + instructions)
          )
        : w.deliveryMissing(surface, probe.detail)
    );
  }
  return lines;
}

/** Doctor's printer: never throws, never changes the exit code. */
export async function printDeliveryNote(
  clients: Array<{ surface: string; mcpSurface?: ToolSurface }>,
  fetchTools: FetchTools = fetchToolsFromDaemon(),
  language = "en",
  instructions: () => Promise<number> = serverInstructionChars
): Promise<void> {
  try {
    const rows = [];
    for (const { surface, mcpSurface } of clients) {
      if (!mcpSurface) continue;
      rows.push({ surface, mcpSurface, probe: await fetchTools(mcpSurface) });
    }
    const lines = deliveryLines(rows, language, rows.length ? await instructions() : 0);
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n\n`);
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
