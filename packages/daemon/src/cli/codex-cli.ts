/**
 * Official Codex CLI bridge for the Codex/ChatGPT desktop adapter (#15).
 *
 * MCP writes go through `codex mcp` instead of a home-grown TOML editor. This
 * keeps quoting and future config migrations owned by Codex, while the
 * captured JSON response gives install/doctor a stable verification contract.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { findExecutable, runCaptured, type CapturedRunResult } from "./exec.js";

const DEFAULT_SERVER_KEY = "bastra-recall";

interface McpServerBlockLike {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const MAC_APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const USER_MAC_APP_CODEX = resolve(homedir(), "Applications/ChatGPT.app/Contents/Resources/codex");

function trustedExecutable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return (statSync(path).mode & 0o002) === 0;
  } catch {
    return false;
  }
}

export function findCodexExecutable(): string | null {
  const fromPath = findExecutable("codex");
  if (fromPath) return fromPath;
  const configured = process.env.CODEX_CLI_PATH;
  for (const candidate of [configured, MAC_APP_CODEX, USER_MAC_APP_CODEX]) {
    if (candidate && trustedExecutable(candidate)) return candidate;
  }
  return null;
}

export interface CodexMcpServer {
  name: string;
  enabled?: boolean;
  transport: {
    type: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

export function parseCodexMcpServer(raw: string): CodexMcpServer | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const transport = record.transport;
    if (typeof record.name !== "string" || !transport || typeof transport !== "object") return null;
    return value as CodexMcpServer;
  } catch {
    return null;
  }
}

export function codexServerMatches(existing: CodexMcpServer | null, target: McpServerBlockLike): boolean {
  if (!existing || existing.transport.type !== "stdio") return false;
  const transport = existing.transport;
  if (transport.command !== target.command) return false;
  if (JSON.stringify(transport.args ?? []) !== JSON.stringify(target.args)) return false;
  const env = transport.env ?? {};
  return Object.keys(target.env).every((key) => env[key] === target.env[key]);
}

export function codexMcpGet(bin: string, name = DEFAULT_SERVER_KEY): {
  server: CodexMcpServer | null;
  result: CapturedRunResult;
} {
  const result = runCaptured(bin, ["mcp", "get", name, "--json"], { timeoutMs: 10_000 });
  return { server: result.ok ? parseCodexMcpServer(result.stdout) : null, result };
}
