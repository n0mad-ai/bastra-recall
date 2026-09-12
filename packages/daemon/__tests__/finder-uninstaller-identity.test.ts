/**
 * #527 — `distribution/Uninstall Bastra.command` used to kill every listener on
 * the hard-coded port 6723 without ever asking what that process was. When the
 * daemon is stopped, misconfigured or unable to start, an unrelated local
 * service owns that port — and a double-clicked uninstaller then stopped it
 * while reporting it as the Bastra daemon.
 *
 * These tests run the real script end to end in a sealed environment:
 *   · HOME points at a temp dir (log file, LaunchAgents plist)
 *   · PATH is prefixed with stub `bastra` / `launchctl`, so nothing on this
 *     machine is ever unregistered or booted out
 *   · BASTRA_HTTP_PORT points at an ephemeral port the child picked itself,
 *     so the real daemon on 6723 is never a candidate
 *
 * Run: npx tsx --test packages/daemon/__tests__/finder-uninstaller-identity.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../distribution/Uninstall Bastra.command", import.meta.url));

/** A listener that reports the port it got, so no test has to guess a free one. */
const LISTENER_SRC = `
import { createServer } from "node:net";
const s = createServer(() => {});
s.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(s.address().port) + "\\n");
});
setInterval(() => {}, 1e9);
`;

interface Listener {
  child: ChildProcess;
  port: number;
  alive: () => boolean;
}

/** Starts the listener from `file` and waits for the port it bound. */
async function startListener(file: string): Promise<Listener> {
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("listener did not report a port")), 10_000);
    child.stdout!.on("data", (b: Buffer) => {
      const n = Number(String(b).trim());
      if (Number.isFinite(n) && n > 0) {
        clearTimeout(timer);
        resolve(n);
      }
    });
    child.once("error", reject);
  });
  return {
    child,
    port,
    alive: () => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      try {
        process.kill(child.pid!, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Sealed HOME + stub PATH; returns what the script printed. */
async function runUninstaller(dir: string, port: number): Promise<string> {
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  await mkdir(join(home, "Library", "Logs"), { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "bastra"), '#!/bin/sh\necho "  [stub bastra] $*"\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bin, "launchctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const r = spawnSync("/bin/bash", [SCRIPT], {
    // "y" confirms, "x" satisfies the final "press any key".
    input: "y\nx\n",
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BASTRA_HTTP_PORT: String(port),
    },
  });
  // The script tees its own output into the log; read that as well — the tee
  // runs in a process substitution, so the pipe can close before it flushes.
  let log = "";
  try {
    log = await readFile(join(home, "Library", "Logs", "bastra-uninstall.log"), "utf8");
  } catch {
    /* no log written */
  }
  return `${r.stdout ?? ""}${r.stderr ?? ""}${log}`;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-527-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** The script may need a moment to reap what it signalled. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 750));
}

test("#527 — an unrelated listener on the daemon port survives the Finder uninstaller", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "unrelated-service.mjs");
    await writeFile(file, LISTENER_SRC, "utf8");
    const listener = await startListener(file);
    try {
      const out = await runUninstaller(dir, listener.port);
      await settle();
      assert.equal(
        listener.alive(),
        true,
        `the uninstaller stopped a process it never identified as Bastra:\n${out}`,
      );
      assert.match(out, /NOT the Bastra daemon/);
      // …and it must say so in the summary rather than claiming a clean stop.
      assert.match(out, /daemon was NOT stopped/);
    } finally {
      listener.child.kill("SIGKILL");
    }
  });
});

test("#527 — a positively identified daemon on the configured port is still stopped", async () => {
  await withTempDir(async (dir) => {
    // The identity criterion is the daemon entry point on the command line —
    // the same one packages/daemon/src/cli/daemon-processes.ts matches on.
    const file = join(dir, "pkg", "daemon", "dist", "index.js");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, LISTENER_SRC, "utf8");
    const listener = await startListener(file);
    try {
      const out = await runUninstaller(dir, listener.port);
      await settle();
      assert.equal(listener.alive(), false, `the daemon was left running:\n${out}`);
      assert.match(out, /stopping the Bastra daemon/i);
    } finally {
      listener.child.kill("SIGKILL");
    }
  });
});

test("#527 — the uninstaller does not claim the installed package was removed", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "unrelated-service.mjs");
    await writeFile(file, LISTENER_SRC, "utf8");
    const listener = await startListener(file);
    try {
      const out = await runUninstaller(dir, listener.port);
      assert.doesNotMatch(out, /Bastra removed/);
      assert.match(out, /unregistered from every AI client/);
      assert.match(out, /package itself is still installed/);
    } finally {
      listener.child.kill("SIGKILL");
    }
  });
});
