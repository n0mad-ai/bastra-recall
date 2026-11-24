/** Installer adapter registry, including Codex/ChatGPT desktop (#15). */
import { claudeDesktopAdapter } from "./adapters/claude-desktop.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { cursorAdapter } from "./adapters/cursor.js";
import { codexAdapter } from "./adapters/codex.js";
import { adapterWordsIn } from "./adapter-words.js";
import type { Adapter } from "./types.js";

export const ADAPTERS: Record<string, Adapter> = {
  "claude-desktop": claudeDesktopAdapter,
  "claude-code": claudeCodeAdapter,
  "codex": codexAdapter,
  "cursor": cursorAdapter,
};

const descriptionsDe: Record<string, string> = {
  "claude-desktop": "Claude Desktop App",
  "claude-code": "Claude Code (MCP, Skill und Hooks)",
  codex: "Codex und ChatGPT Desktop (MCP, Skill und Hooks)",
  cursor: "Cursor (nur MCP)",
};

export function adapterDescription(adapter: Adapter, language?: string): string {
  return adapterWordsIn(language)(adapter.description, descriptionsDe[adapter.surface] ?? adapter.description);
}

export function resolveTargets(surface: string | null, language?: string): Adapter[] | { error: string } {
  const text = adapterWordsIn(language);
  if (!surface)
    return {
      error: text(
        "missing surface — use one of: claude-desktop, claude-code, codex, cursor, all",
        "Client fehlt — verwende claude-desktop, claude-code, codex, cursor oder all"
      ),
    };
  if (surface === "all") return Object.values(ADAPTERS);
  const a = ADAPTERS[surface];
  if (!a) {
    const supported = Object.keys(ADAPTERS).join(", ");
    return {
      error: text(
        `unknown surface '${surface}' — supported: ${supported}`,
        `unbekannter Client '${surface}' — unterstützt: ${supported}`
      ),
    };
  }
  return [a];
}
