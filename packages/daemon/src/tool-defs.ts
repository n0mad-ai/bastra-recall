/**
 * The canonical list of MCP tool definitions the daemon exposes — the single
 * source of truth for both the embedded server (index.ts), the stdio forwarder
 * (mcp-forwarder.ts), and the `GET /tools` endpoint (http.ts).
 *
 * Why one place: the forwarder used to ship its OWN static copy of this list,
 * so the schema a client saw came from the forwarder's build while validation
 * happened at the daemon. A long-lived shared daemon running older code in RAM
 * (it deliberately doesn't restart on a dist rebuild — the update-staged
 * pattern) could then validate against a schema that differed from what the
 * client was told — surfacing as "argument X arrives undefined" (#132). The
 * forwarder now fetches /tools from the daemon, so the schema the client sees
 * always matches the validator; this constant is the fallback when the daemon
 * isn't reachable yet.
 */
import { requiredFieldsOf } from "./call-corruption.js";
import { MEMORY_TOOL_DEFS } from "./tool-handlers.js";
import { documentTools } from "./documents-handler.js";
import { documentWriteTools } from "./documents-write-handler.js";
import { productDocTools } from "./product-doc-handler.js";

export const ALL_TOOL_DEFS = [
  ...MEMORY_TOOL_DEFS,
  ...documentTools,
  ...documentWriteTools,
  ...productDocTools,
];

/**
 * #481: the tool surface a single MCP client sees. Chosen at install time
 * (the installer writes `BASTRA_TOOL_SURFACE` into the client's server block)
 * and overridable there by hand.
 *
 * - `search` — read only: recall, load_memory, find_document, read_document
 * - `write`  — search + save_memory, save_document, save_product_doc
 * - `full`   — everything, including the lifecycle operations
 *
 * Lifecycle operations (archive_memory, move_document, recategorize_document)
 * reshape the vault, and an agent reaching them through the same list as
 * `recall` is the whole reason for this: nothing structural made a 47-memory
 * move a deliberate act. They stay `full`-only, and so does anything not
 * named below — a new tool is lifecycle-shaped until someone says otherwise.
 *
 * `full` is the fallback when nothing is set, so the Mac app, the CLI and
 * every registration made before this existed keep today's behaviour.
 */
export type ToolSurface = "search" | "write" | "full";

export const DEFAULT_TOOL_SURFACE: ToolSurface = "full";

/** What a fresh MCP-client install gets: agents save, they do not reorganise. */
export const INSTALL_TOOL_SURFACE: ToolSurface = "write";

const SEARCH_SURFACE_TOOLS = ["recall", "load_memory", "find_document", "read_document"] as const;

const WRITE_SURFACE_TOOLS = [
  ...SEARCH_SURFACE_TOOLS,
  "save_memory",
  "save_document",
  "save_product_doc",
] as const;

export function toolSurfaceFrom(raw: string | undefined): ToolSurface {
  const v = raw?.trim().toLowerCase();
  return v === "search" || v === "write" || v === "full" ? v : DEFAULT_TOOL_SURFACE;
}

/** The tool names a surface allows, or `null` for "no restriction" (`full`). */
export function toolNamesForSurface(surface: ToolSurface): readonly string[] | null {
  if (surface === "search") return SEARCH_SURFACE_TOOLS;
  if (surface === "write") return WRITE_SURFACE_TOOLS;
  return null;
}

export function isToolAllowed(name: string, surface: ToolSurface): boolean {
  const allowed = toolNamesForSurface(surface);
  return allowed === null || allowed.includes(name);
}

export function filterToolDefsForSurface<T extends { name: string }>(
  defs: readonly T[],
  surface: ToolSurface,
): T[] {
  const allowed = toolNamesForSurface(surface);
  return allowed === null ? [...defs] : defs.filter((d) => allowed.includes(d.name));
}

/**
 * The refusal an agent gets for a call outside its surface. It names the
 * surface and how to widen it, so the agent tells the user instead of
 * retrying the same call.
 */
export function toolSurfaceDenial(name: string, surface: ToolSurface): string {
  const allowed = toolNamesForSurface(surface) ?? [];
  return (
    `${name} is not available on the "${surface}" tool surface of bastra-recall ` +
    `(allowed: ${allowed.join(", ")}). Do not retry — tell the user instead. ` +
    `To widen it, set BASTRA_TOOL_SURFACE=full (or =write) in the bastra-recall ` +
    `MCP server config and restart this client.`
  );
}

/**
 * #482: what each tool needs, resolved ONCE at module load — the corrupted-
 * arguments check runs on every tool call, so it must not rebuild anything.
 * Derived from the definitions above rather than a hand-kept constant, so a
 * new tool is covered the moment it is declared.
 */
export const TOOL_ARG_EXPECTATIONS: ReadonlyMap<string, { required: readonly string[]; readOnly: boolean }> =
  new Map(
    ALL_TOOL_DEFS.map((def) => [
      def.name,
      {
        required: requiredFieldsOf(def),
        readOnly: (def as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true,
      },
    ]),
  );
