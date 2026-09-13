/**
 * #62 — step 1 of the real-Claude-Code long-save probe.
 *
 * Builds the throwaway world the probe runs in and leaves it standing:
 *   · a temp vault, a temp HOME and a temp working directory
 *   · a real bastra daemon on that vault, on a random loopback port
 *   · an MCP config naming exactly one server, our forwarder against that
 *     daemon — handed to `claude --mcp-config … --strict-mcp-config`, so the
 *     session sees this server and no other
 *   · one prompt file per session
 *
 * It prints the paths and exits; `run.sh` then drives the real client and
 * `verify.mjs` tears everything down again. Nothing here reads or writes the
 * host's vault, settings or MCP registration.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER, LINES_DEFAULT, promptFor } from "./shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SESSIONS = Number(process.env.SESSIONS ?? 4);
const LINES = (process.env.LINES ?? LINES_DEFAULT).split(",").map((n) => Number(n.trim()));

async function waitHealth(port, ms = 40_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const vault = await mkdtemp(join(tmpdir(), "bastra62cc-vault-"));
const home = await mkdtemp(join(tmpdir(), "bastra62cc-home-"));
const work = await mkdtemp(join(tmpdir(), "bastra62cc-work-"));
await mkdir(join(vault, "memories"), { recursive: true });
await mkdir(join(work, "transcripts"), { recursive: true });
const port = 16_000 + Math.floor(Math.random() * 4_000);

const childEnv = {
  HOME: home,
  BASTRA_VAULT_PATH: vault,
  BASTRA_HTTP_PORT: String(port),
  BASTRA_DAEMON_URL: `http://127.0.0.1:${port}`,
  BASTRA_FORWARDER_SPAWN: "0",
  BASTRA_TELEMETRY: "off",
  BASTRA_UPDATE_CHECK: "off",
  BASTRA_TOOL_SURFACE: "full",
  // The forwarder already has the diagnostic #62 needs: it logs, per tool
  // call, whether the client attached a `_meta.progressToken`. Without one no
  // `notifications/progress` is ever sent — and progress handling is exactly
  // where the defect #62 records lived. Turning it on here turns "we think
  // Claude Code omits it" into a measurement.
  BASTRA_PROGRESS_DEBUG: "1",
};

const daemonEnv = { ...process.env, ...childEnv };
delete daemonEnv.NEXUS_VAULT_PATH;

const daemonLog = join(work, "daemon.log");
const daemon = spawn(process.execPath, ["--import", "tsx", join(REPO, "packages/daemon/src/index.ts")], {
  env: daemonEnv,
  cwd: REPO,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
daemon.stdout.on("data", (c) => (log += c));
daemon.stderr.on("data", (c) => (log += c));
daemon.unref();

if (!(await waitHealth(port))) {
  await writeFile(daemonLog, log, "utf8");
  console.error(`daemon did not start — see ${daemonLog}\n${log.slice(-2000)}`);
  process.exit(1);
}

await writeFile(
  join(work, "mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        [SERVER]: {
          // Wrapped in a shell only so the forwarder's stderr — where the
          // progress-token diagnostic lands — is captured in the throwaway
          // world instead of the host's MCP debug log.
          command: "/bin/sh",
          args: [
            "-c",
            `exec ${JSON.stringify(process.execPath)} --import tsx ` +
              `${JSON.stringify(join(REPO, "packages/daemon/src/mcp-forwarder.ts"))} ` +
              `2>>${JSON.stringify(join(work, "forwarder.log"))}`,
          ],
          env: childEnv,
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);

for (let s = 0; s < SESSIONS; s++) {
  await writeFile(join(work, `prompt-${s}.txt`), promptFor(s, LINES), "utf8");
}

await writeFile(
  join(work, "state.json"),
  JSON.stringify({ vault, home, work, port, sessions: SESSIONS, lines: LINES, daemonPid: daemon.pid }, null, 2),
  "utf8",
);

console.log(work);
process.exit(0);
