/**
 * The user-owned assistant-address runtime: the versioned code bundle, the
 * launcher the root-owned socket service starts, the published daemon
 * endpoint, the protocol migration of older installations, the launchd
 * probe, and retiring listeners from before the runtime watcher. Split out of
 * assistant-address.ts (#1532), which re-exports the public functions.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { withPathLock } from "./path-lock.js";
import { appRecordDatabasePath } from "./app-record-store.js";
import { shellQuote } from "./assistant-address-admin.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import { stableNodeBin } from "./cli/autostart.js";
import {
  assistantAddressOptions,
  atomic,
  companionPath,
  optional,
  ownHelper,
  type AssistantAddressOptions,
  type RuntimeProcess,
} from "./assistant-address-options.js";

/** Compatibility only: admitted Node slots for old Wait=false jobs. New paired
 * Wait=true jobs are bounded by launchd before process creation. */
const HELPER_SLOTS = 16;

const capture = (bin: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(bin, args, { timeout: 2000, env: { ...process.env, LC_ALL: "C" } }, (error, out) =>
      error ? reject(error) : resolve(out)
    )
  );
// Identity is uid, start time and exact command line, read in one ps call.
const inspect = async (pid: number): Promise<RuntimeProcess | null> => {
  try {
    const row = await capture("/bin/ps", ["-ww", "-p", String(pid), "-o", "uid=", "-o", "lstart=", "-o", "args="]),
      match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+([^\n]+)/.exec(row);
    return match ? { pid, uid: Number(match[1]), started: match[2], command: match[3] } : null;
  } catch {
    return null; /* exited before inspection */
  }
};
/** This user's processes listening on port 80, or null when there are none. */
async function portListeners(o: ReturnType<typeof assistantAddressOptions>): Promise<RuntimeProcess[] | null> {
  let output: string;
  try {
    output = await capture("/usr/sbin/lsof", ["-nP", "-t", "-a", "-u", o.uid, "-iTCP:80", "-sTCP:LISTEN"]);
  } catch (error) {
    if ((error as { code?: number | string }).code === 1) return null;
    throw error;
  }
  const processes: RuntimeProcess[] = [];
  for (const pid of new Set(
    output
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 1)
  )) {
    const p = await inspect(pid);
    if (p) processes.push(p);
  }
  return processes;
}
/** Only our exact versioned gateway command, owned by this user, is ours to retire. */
function ownedRuntimeProcess(o: ReturnType<typeof assistantAddressOptions>) {
  const node = o.runtimeNode ?? stableNodeBin(),
    prefix = join(o.runtimeDir, "versions") + sep;
  const prefixes = [node + " " + prefix, process.execPath + " " + prefix];
  return (p: RuntimeProcess) =>
    Number.isSafeInteger(p.pid) &&
    p.pid > 1 &&
    p.pid !== process.pid &&
    p.uid === Number(o.uid) &&
    p.uid === (process.getuid?.() ?? p.uid) &&
    prefixes.some(
      (prefix) =>
        p.command.startsWith(prefix) &&
        /^[a-f0-9]{64}[\/\\]assistant-address-gateway\.js --assistant-address-inetd(?: |$)/.test(
          p.command.slice(prefix.length)
        )
    );
}
/** The PID still names the same owned process: uid, command and start time unchanged. */
function sameRuntimeProcess(p: RuntimeProcess, now: RuntimeProcess | null, owned: (p: RuntimeProcess) => boolean) {
  return (
    !!now &&
    now.pid === p.pid &&
    owned(now) &&
    now.uid === p.uid &&
    now.command === p.command &&
    now.started === p.started
  );
}
/** Migrate listeners from before the runtime watcher existed. Only our exact
 * versioned gateway command, owned by this user and holding a listen socket,
 * can be retired. launchd keeps its socket; no privileged job is touched. */
async function retireLegacyAssistantHelpers(o: ReturnType<typeof assistantAddressOptions>) {
  if (!(await ownHelper(o))) return;
  if (o.platform !== "darwin" && !o.runtimeProcesses) return;
  const processes = o.runtimeProcesses ? await o.runtimeProcesses() : await portListeners(o);
  if (processes === null) return;
  const reinspect =
    o.runtimeProcess ??
    (o.runtimeProcesses
      ? async (pid: number) => (await o.runtimeProcesses!()).find((p) => p.pid === pid) ?? null
      : inspect);
  const owned = ownedRuntimeProcess(o);
  for (const p of processes) {
    if (!owned(p)) continue;
    // Revalidate right before the signal: the PID may belong to another process by now (#1335).
    const now = await reinspect(p.pid);
    if (!sameRuntimeProcess(p, now, owned)) continue;
    try {
      (
        o.retireRuntime ??
        ((pid) => {
          process.kill(pid, "SIGTERM");
        })
      )(p.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
async function assistantRuntimeBundle(o: ReturnType<typeof assistantAddressOptions>) {
  const source = o.runtimeSourceDir ?? dirname(fileURLToPath(import.meta.url));
  const files = [
    "assistant-address-bootstrap.js",
    "assistant-address-gateway.js",
    "local-account-access.js",
    "assistant-address-name.js",
    "assistant-address-files.js",
    "http-auth.js",
    "runtime-settings.js",
  ];
  const contents = await Promise.all(
    files.map(async (name) => {
      const path =
        name === "runtime-settings.js" && !o.runtimeSourceDir
          ? fileURLToPath(import.meta.resolve("@bastra-recall/core/runtime-settings"))
          : join(source, name);
      const text = await readFile(path, "utf8");
      // The private launchd runtime has no node_modules; retain the shared reader
      // implementation and resolve the gateway's exact package subpath locally.
      return [
        name,
        name === "assistant-address-gateway.js"
          ? text.replace(/(["'])@bastra-recall\/core\/runtime-settings\1/g, '"./runtime-settings.js"')
          : text,
      ] as const;
    })
  );
  const digest = createHash("sha256")
    .update(contents.map(([n, c]) => n + "\n" + c).join("\n"))
    .digest("hex");
  return { contents, digest };
}
export async function ensureAssistantAddressRuntime(options: AssistantAddressOptions = {}): Promise<void> {
  const o = assistantAddressOptions(options),
    { contents, digest } = await assistantRuntimeBundle(o);
  const version = join(o.runtimeDir, "versions", digest);
  await mkdir(version, { recursive: true, mode: 0o700 });
  for (const [name, content] of contents)
    if ((await optional(join(version, name))) !== content) await atomic(join(version, name), content);
  await atomic(join(version, "package.json"), '{"type":"module"}\n');
  await atomic(join(o.runtimeDir, "managed"), `bastra-assistant-address:${o.uid}\n`);
  const node = o.runtimeNode ?? stableNodeBin(),
    bootstrap = join(o.runtimeDir, "bootstrap.js");
  await atomic(bootstrap, contents.find(([name]) => name === "assistant-address-bootstrap.js")![1]);
  const errorBody = "Bastra-Adresse nicht verfügbar. Bitte bastra address setup --yes ausführen.\n";
  const failure = `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(errorBody)}\r\nConnection: close\r\n\r\n${errorBody}`;
  const command = [node, bootstrap, "--assistant-address-bootstrap", "--runtime-dir", o.runtimeDir]
    .map(shellQuote)
    .join(" ");
  await atomic(join(o.runtimeDir, "package.json"), '{"type":"module"}\n');
  const path = join(o.runtimeDir, "current.json");
  await withPathLock(
    path,
    async () => {
      const previous = await optional(path).then((raw) => {
        try {
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      });
      const endpoint =
        options.daemonUrl || resolveDaemonEndpoint().configured
          ? o.daemonUrl
          : previous?.protocol === 2
            ? previous.daemonUrl
            : o.daemonUrl;
      await atomic(
        path,
        JSON.stringify({
          protocol: 2,
          generation: randomUUID(),
          version: digest,
          settingsPath: o.settingsPath,
          databasePath: appRecordDatabasePath(o.settingsPath),
          hostsPath: o.hostsPath,
          daemonUrl: endpoint,
          owner: o.uid,
        }) + "\n"
      );
    },
    { strictLocal: true }
  );
  const busyBody = "Bastra-Adresse gerade ausgelastet. Bitte gleich erneut versuchen.\n";
  const busy = `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(busyBody)}\r\nRetry-After: 1\r\nConnection: close\r\n\r\n${busyBody}`;
  const slots = join(o.runtimeDir, "slots");
  await mkdir(slots, { recursive: true, mode: 0o700 });
  // Wait=false starts one helper per accepted connection. Each helper holds one of
  // HELPER_SLOTS kernel file locks, released by the kernel when it exits (#1335).
  const slot = `slot() { if [ -x /usr/bin/lockf ]; then /usr/bin/lockf -s -k -t 0 "$1" ${command}; elif [ -x /usr/bin/flock ]; then /usr/bin/flock -n -E 75 "$1" ${command}; else ${command}; fi; }\ni=0; rc=75\nwhile [ "$rc" -eq 75 ] && [ "$i" -lt ${HELPER_SLOTS} ]; do slot ${shellQuote(slots)}/"$i"; rc=$?; i=$((i+1)); done\nif [ "$rc" -eq 75 ]; then respond ${shellQuote(busy)}; exit 1; fi`;
  await atomic(
    join(o.runtimeDir, "launch.sh"),
    `#!/bin/sh\n# Socket protocol 2: accepted connections; legacy Wait=true uses the bootstrap compatibility path.\nrespond() { /usr/bin/printf %s "$1"; }\nfail() { respond ${shellQuote(failure)}; }\nif [ "\${BASTRA_ASSISTANT_ADDRESS_PROTOCOL:-2}" != 2 ] || [ ! -x ${shellQuote(node)} ] || [ ! -r ${shellQuote(bootstrap)} ]; then fail; exit 1; fi\nif [ "\${BASTRA_ASSISTANT_ADDRESS_LISTEN:-0}" = 1 ]; then exec ${command}; fi\n${slot}\nif [ "$rc" -ne 0 ]; then fail; fi\nexit "$rc"\n`
  );
  await retireLegacyAssistantHelpers(o);
}
export async function refreshAssistantAddressRuntime(options: AssistantAddressOptions = {}): Promise<void> {
  const o = assistantAddressOptions(options);
  if ((await optional(join(o.runtimeDir, "managed"))) === `bastra-assistant-address:${o.uid}\n`)
    await ensureAssistantAddressRuntime(o);
}
/** Old updaters cannot call new update hooks. A new daemon boot repairs
 * their user-owned launcher and refreshes changed runtime code before publishing its endpoint. The root-owned
 * Wait=true job remains valid through bootstrap's listening-socket compatibility. */
export async function migrateAssistantAddressRuntime(options: AssistantAddressOptions = {}): Promise<void> {
  const o = assistantAddressOptions(options);
  if ((await optional(join(o.runtimeDir, "managed"))) !== `bastra-assistant-address:${o.uid}\n`) return;
  await withPathLock(
    join(o.runtimeDir, "protocol-migration"),
    async () => {
      const launcher = await optional(join(o.runtimeDir, "launch.sh"));
      if (launcher === null) return; // Missing installations are repaired explicitly by address setup.
      const current = await optional(join(o.runtimeDir, "current.json"));
      const backup = join(o.runtimeDir, "protocol-1-backup.json"),
        complete = join(o.runtimeDir, "protocol-2-migrated");
      const previousBackup = await optional(backup);
      let protocol: unknown, version: unknown, databasePath: unknown;
      try {
        const installed = current ? JSON.parse(current) : null;
        protocol = installed?.protocol;
        version = installed?.version;
        databasePath = installed?.databasePath;
      } catch {
        /* incomplete old publication */
      }
      if (
        protocol === 2 &&
        launcher.includes("# Socket protocol 2:") &&
        (previousBackup === null || (await optional(complete)) === "2\n")
      ) {
        const bundle = await assistantRuntimeBundle(o);
        if (version !== bundle.digest || databasePath !== appRecordDatabasePath(o.settingsPath)) {
          await ownHelper(o);
          await ensureAssistantAddressRuntime(o);
        }
        return;
      }
      await ownHelper(o); // Never migrate a runtime associated with a foreign service.
      if (previousBackup === null) await atomic(backup, JSON.stringify({ launcher, current }) + "\n");
      // Code and state become durable before the launcher rename. An interruption
      // before that rename leaves the old pinned launcher usable; a retry resumes.
      await ensureAssistantAddressRuntime(o);
      await atomic(complete, "2\n"); // Retirement must complete before a retry may skip migration.
    },
    { strictLocal: true }
  );
}
/** Publish the endpoint and selected DB of an already managed runtime; never recopy code from an old daemon. */
export async function publishAssistantAddressEndpoint(options: AssistantAddressOptions = {}): Promise<void> {
  const o = assistantAddressOptions(options);
  if ((await optional(join(o.runtimeDir, "managed"))) !== `bastra-assistant-address:${o.uid}\n`) return;
  const path = join(o.runtimeDir, "current.json");
  await withPathLock(
    path,
    async () => {
      const raw = await optional(path);
      if (!raw) return;
      const current = JSON.parse(raw),
        databasePath = appRecordDatabasePath(o.settingsPath);
      if (
        current.protocol !== 2 ||
        !current.version ||
        (current.daemonUrl === o.daemonUrl && current.databasePath === databasePath)
      )
        return;
      await atomic(
        path,
        JSON.stringify({ ...current, generation: randomUUID(), daemonUrl: o.daemonUrl, databasePath }) + "\n"
      );
    },
    { strictLocal: true }
  );
}
export async function assistantHelperLoaded(
  o: ReturnType<typeof assistantAddressOptions>,
  includeCompanion = false
): Promise<boolean | null> {
  if (o.helperLoaded) return o.helperLoaded();
  if (o.runAdmin) return null; // Test/injected IO never inspects the live launchd domain.
  if (o.platform !== "darwin") return null;
  const labels = [`ai.n0mad.bastra-recall.address.${o.uid}`];
  if (
    includeCompanion ||
    (await optional(companionPath(o))) !== null ||
    (await optional(o.helperPath))?.includes("<key>BASTRA_ASSISTANT_ADDRESS_BOUND</key><string>2</string>")
  )
    labels.push(`ai.n0mad.bastra-recall.address.${o.uid}.ipv6`);
  const loaded = await Promise.all(
    labels.map(
      (label) =>
        new Promise<boolean | null>((resolve) =>
          execFile("/bin/launchctl", ["print", `system/${label}`], { timeout: 1500 }, (error, _out, stderr) => {
            if (!error) resolve(true);
            else resolve(/Could not find service|service not found/i.test(stderr) ? false : null);
          })
        )
    )
  );
  return loaded.includes(false) ? false : loaded.includes(null) ? null : true;
}
