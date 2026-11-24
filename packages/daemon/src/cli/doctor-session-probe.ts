/** #1472: follow a synthetic SessionStart through the installed native client,
 * its registered Recall runner, the live daemon, and the client's model input.
 * A loopback model fixture observes the canary before any model could answer.
 * The client receives the verified hook registration and a synthetic prompt.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { MAX_BODY_BYTES, readJsonBody, sendJson } from "../http-util.js";
import { DOCTOR_SESSION_PATH } from "../session-output.js";
import { DAEMON_VERSION } from "../version.js";
import { hookCommandTokens } from "./adapters/command-paths.js";
import { findCodexExecutable } from "./codex-cli.js";
import { findExecutable } from "./exec.js";
import { DAEMON_PACKAGE_ROOT, HOOK_STUB_BIN, SESSION_HOOK_BIN } from "./paths.js";
import { mapBinToStableRuntime, resolveNodeModulesRoot, stableRuntimeTarget } from "./stable-runtime.js";
import type { DoctorResult, SessionStartRegistration } from "./types.js";

type HookClient = "claude-code" | "codex";
const TIMEOUT_MS = 12_000;
const MODEL_PROMPT = "This is a local Recall doctor probe.";
const execFileAsync = promisify(execFile);

function matchesInstalledBin(configured: string, bin: string): boolean {
  const stable = stableRuntimeTarget(DAEMON_VERSION);
  const sourceNodeModules = resolveNodeModulesRoot(DAEMON_PACKAGE_ROOT) ?? undefined;
  return (
    configured === bin ||
    configured === mapBinToStableRuntime(bin, {}) ||
    configured === mapBinToStableRuntime(bin, { ...stable, sourceNodeModules })
  );
}

function directRunner(command: string, surface: HookClient): string[] | undefined {
  const words = hookCommandTokens(command).map((part) => part.value);
  if (words.shift() !== `BASTRA_HOOK_CLIENT=${surface}`) return undefined;
  if (surface === "codex" && /^BASTRA_CODEX_VERSION=\d+\.\d+\.\d+$/.test(words[0] ?? "")) words.shift();
  if (words.length !== 2) return undefined;
  if (words[0] === "node" && matchesInstalledBin(words[1], SESSION_HOOK_BIN)) return [process.execPath, words[1]];
  if (words[1] === "session" && matchesInstalledBin(words[0], HOOK_STUB_BIN)) return words;
  return undefined;
}

/** Only copy our unwrapped runner at its exact package path. Doctor must not
 * execute arbitrary shell clauses or any unrelated hook from assistant settings. */
export function sessionStartRegistration(
  hooks: Record<string, unknown>,
  surface: HookClient
): SessionStartRegistration | undefined {
  if (!Array.isArray(hooks.SessionStart)) return undefined;
  for (const group of hooks.SessionStart) {
    if (!Array.isArray(group?.hooks)) continue;
    for (const hook of group.hooks) {
      if (hook?.type !== "command" || typeof hook.command !== "string") continue;
      const runner = directRunner(hook.command, surface);
      if (runner) return { runner, matcher: typeof group.matcher === "string" ? group.matcher : undefined };
    }
  }
  return undefined;
}

function quoted(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function isolatedHook(registration: SessionStartRegistration) {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: registration.matcher,
          hooks: [{ type: "command", command: registration.runner.map(quoted).join(" "), timeout: 3 }],
        },
      ],
    },
  };
}

async function runClient(
  surface: HookClient,
  bin: string,
  dir: string,
  baseUrl: string,
  hook: SessionStartRegistration
) {
  // Select a local provider explicitly and do not inherit a real API key,
  // cloud provider selection, session context, proxy or client credentials.
  const blockedState = join(dir, "no-hook-state");
  await writeFile(blockedState, "", { flag: "wx" });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: dir,
    BASTRA_DAEMON_URL: baseUrl,
    BASTRA_HOOK_CLIENT: surface,
    BASTRA_CHAT_SESSIONS_PATH: blockedState,
    BASTRA_HOOK_STATE_DIR: blockedState,
    BASTRA_TELEMETRY: "off",
  };
  const settings = isolatedHook(hook);
  const args = surface === "codex" ? codexArgs(dir, baseUrl, hook, env) : claudeArgs(dir, baseUrl, settings, env);
  const child = execFileAsync(bin, args, { cwd: dir, env, timeout: TIMEOUT_MS, killSignal: "SIGKILL" });
  child.child.stdin?.end();
  await child;
}

function codexArgs(dir: string, baseUrl: string, hook: SessionStartRegistration, env: NodeJS.ProcessEnv): string[] {
  env.CODEX_HOME = dir;
  const matcher = hook.matcher === undefined ? "" : `matcher=${JSON.stringify(hook.matcher)},`;
  const command = JSON.stringify(hook.runner.map(quoted).join(" "));
  // Isolated CODEX_HOME has exactly one vetted Recall runner. No persistent
  // trust is bypassed or modified in the user's normal Codex configuration.
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--dangerously-bypass-hook-trust",
    "-c",
    "features.apps=false",
    "-c",
    "features.hooks=true",
    "-c",
    `projects.${JSON.stringify(dir)}.trust_level="trusted"`,
    "-c",
    `hooks.SessionStart=[{${matcher}hooks=[{type="command",command=${command},timeout=3}]}]`,
    "-c",
    'model_provider="recall_probe"',
    "-m",
    "recall-probe",
    "-c",
    'model_providers.recall_probe.name="Recall doctor loopback"',
    "-c",
    `model_providers.recall_probe.base_url=${JSON.stringify(baseUrl)}`,
    "-c",
    'model_providers.recall_probe.wire_api="responses"',
    "-c",
    "model_providers.recall_probe.requires_openai_auth=false",
    "-c",
    "model_providers.recall_probe.request_max_retries=0",
    "-c",
    "model_providers.recall_probe.stream_max_retries=0",
    MODEL_PROMPT,
  ];
}

function claudeArgs(dir: string, baseUrl: string, settings: unknown, env: NodeJS.ProcessEnv): string[] {
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: "recall-doctor-local-probe",
  });
  return [
    "--print",
    "--no-session-persistence",
    "--restricted",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--tools",
    "",
    "--settings",
    JSON.stringify(settings),
    "--model",
    "sonnet",
    MODEL_PROMPT,
  ];
}

async function relaySession(
  req: IncomingMessage,
  res: ServerResponse,
  daemon: string,
  challenge: string
): Promise<void> {
  try {
    const { payload } = await readJsonBody(req, MAX_BODY_BYTES);
    if ((payload as { hook_event_name?: unknown } | null)?.hook_event_name === "SessionStart") {
      const result = await fetch(`${daemon}${DOCTOR_SESSION_PATH}`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge }),
        signal: AbortSignal.timeout(1_000),
      });
      if (result.ok) {
        const output = await result.text();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(output);
        return;
      }
    }
  } catch {
    // Returning the normal empty document keeps even an old hook runner out
    // of its offline-notice / failed-transport state path.
  }
  sendJson(res, 200, {});
}

function modelContextContains(body: Record<string, unknown>, marker: string): boolean {
  // The fixture receives actual model input. A hook exit code or successful
  // response from the daemon alone does not prove native context injection.
  return [body.input, body.messages, body.system, body.instructions].some((part) =>
    JSON.stringify(part)?.includes(marker)
  );
}

async function probeNativeClient(
  surface: HookClient,
  bin: string,
  hook: SessionStartRegistration,
  daemon: string
): Promise<boolean> {
  const challenge = randomBytes(16).toString("hex");
  const marker = `bastra-recall-doctor:${challenge}`;
  const dir = await mkdtemp(join(tmpdir(), "bastra-doctor-"));
  let delivered = false;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/hook/session") {
      void relaySession(req, res, daemon, challenge);
      return;
    }
    if (req.method !== "POST" || !/^\/(?:v1\/)?(?:messages|responses)(?:\?|$)/.test(req.url ?? "")) {
      sendJson(res, 404, {});
      return;
    }
    void readJsonBody(req, 2 * MAX_BODY_BYTES)
      .then((body) => {
        delivered ||= modelContextContains(body, marker);
        // The proof is in the input. End locally, before a model can answer.
        sendJson(res, 400, {
          type: "error",
          error: { type: "invalid_request_error", message: "Doctor probe complete" },
        });
      })
      .catch(() => sendJson(res, 400, {}));
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("missing loopback address"));
      });
    });
    await runClient(surface, bin, dir, `http://127.0.0.1:${port}`, hook).catch(() => {});
    return delivered;
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

async function hasManagedClientConfig(surface: HookClient): Promise<boolean> {
  // Machine-level policy can outlive an isolated user config. It can launch
  // other hooks or override the model endpoint, so do not probe such clients.
  // https://code.claude.com/docs/en/managed-settings#where-each-mechanism-stores-the-policy
  // https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence
  const isMac = process.platform === "darwin";
  const paths =
    surface === "codex" ? ["/etc/codex"] : [isMac ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code"];
  if (isMac) {
    const domain = surface === "codex" ? "com.openai.codex" : "com.anthropic.claudecode";
    paths.push(`/Library/Managed Preferences/${domain}.plist`);
    paths.push(`/Library/Managed Preferences/${userInfo().username}/${domain}.plist`);
    paths.push(join(homedir(), `Library/Managed Preferences/${domain}.plist`));
  }
  const present = await Promise.all(
    paths.map((path) =>
      lstat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code !== "ENOENT"
      )
    )
  );
  return present.some(Boolean);
}

export type SessionProbeResult = "delivered" | "missing" | "unavailable" | "hookless";

export async function probeSessionStart(surface: string, hook?: SessionStartRegistration): Promise<SessionProbeResult> {
  if (surface !== "codex" && surface !== "claude-code") return "hookless";
  if (!hook || process.platform === "win32") return "unavailable";
  const bin = surface === "codex" ? findCodexExecutable() : findExecutable("claude");
  const daemon = resolveDaemonEndpoint();
  if (!bin || !["127.0.0.1", "localhost", "[::1]"].includes(daemon.host)) return "unavailable";
  if (await hasManagedClientConfig(surface).catch(() => true)) {
    return "unavailable";
  }
  const delivered = await probeNativeClient(surface, bin, hook, daemon.baseUrl).catch(() => false);
  return delivered ? "delivered" : "missing";
}

const words = {
  en: {
    delivered: "✓ Recall start context reached the model input in the isolated probe",
    missing: "⚠ isolated client did not receive Recall start context",
    unavailable: "· native SessionStart probe unavailable for this registration",
    hookless: "· no native probe for this client's MCP start context",
  },
  de: {
    delivered: "✓ Recall-Startkontext ist in der isolierten Probe am Modelleingang angekommen",
    missing: "⚠ im isolierten Client kam kein Recall-Startkontext an",
    unavailable: "· für diese Anbindung ist keine native SessionStart-Probe verfügbar",
    hookless: "· keine native Probe für den MCP-Startkontext dieses Clients",
  },
};

export async function printSessionStartNote(
  clients: Array<{ surface: string; result: DoctorResult }>,
  language: string,
  machineOutput: boolean
): Promise<void> {
  if (machineOutput) return;
  const installed = clients.filter(({ result }) => result.features || result.status === "ok");
  if (installed.length === 0) return;
  const isGerman = language === "de";
  const w = isGerman ? words.de : words.en;
  const rows = await Promise.all(
    installed.map(
      async ({ surface, result }) => `${surface}  ${w[await probeSessionStart(surface, result.sessionStart)]}`
    )
  );
  process.stdout.write(
    `→ ${isGerman ? "Startkontext je Client" : "Start context per client"}\n  ${rows.join("\n  ")}\n\n`
  );
}
