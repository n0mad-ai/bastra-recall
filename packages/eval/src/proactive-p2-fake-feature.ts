/**
 * Stand-in feature checkout for the deterministic P2 characterization mode (#1649).
 *
 * `writeFeatureRoot` lays out the files the real P2 driver reads or imports from a
 * feature checkout; the imported daemon modules forward to the current `FakeWorld`.
 * `installProcessFakes` routes the driver's `spawn`, `execFileSync` and `fetch` to
 * in-process stand-ins (daemon, CLI, MCP forwarder, Git) instead of real processes
 * and sockets. Credentials, commit IDs and Git object IDs are counters or hashes of
 * fixed input, so two runs see the same identities.
 */
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { contact, handle, readCredentials, type Credential, type DaemonContext } from "./proactive-p2-fake-daemon.js";
import { bumpRevision, loadStore, saveStore } from "./proactive-p2-fake-store.js";

const FIXTURE_COMMIT = "c".repeat(40);
const WORLD = Symbol.for("bastra.p2-characterization.world");
const sha = (algorithm: string, value: string) => createHash(algorithm).update(value).digest("hex");

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal?: string): boolean;
}
interface Daemon {
  port: number;
  ctx: DaemonContext;
  env: NodeJS.ProcessEnv;
  booted: boolean;
}

/** All mutable stand-in state of one row: a fresh world per (case, repetition). */
export class FakeWorld {
  daemon: Daemon | undefined;
  /** What reached the stand-ins and when on the virtual clock: timing is part of the driver's behaviour. */
  readonly trace: Array<Record<string, unknown>> = [];
  readonly repos = new Map<string, { head: string; refs: Map<string, string>; commits: number }>();

  note(event: Record<string, unknown>) {
    this.trace.push({ at: Date.now(), ...event });
  }

  configFingerprint(env: NodeJS.ProcessEnv) {
    const root = env.BASTRA_MEASUREMENT_ROOT ?? "";
    const entries = Object.entries(env)
      .filter(([key]) => key.startsWith("BASTRA_"))
      .map(([key, value]) => `${key}=${String(value).split(root).join("<root>")}`)
      .sort();
    return sha("sha256", entries.join("\n"));
  }

  async mintTaskCredential(
    authPath: string,
    spec: Omit<Credential, "id" | "token_sha256" | "revoked">,
    replace?: string
  ) {
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    const credentials = readCredentials(authPath).map((c) => (c.id === replace ? { ...c, revoked: true } : c));
    const id = `credential-${credentials.length + 1}`;
    const token = `fixture-token-${credentials.length + 1}`;
    credentials.push({ ...spec, id, token_sha256: sha("sha256", token), revoked: false });
    writeFileSync(authPath, JSON.stringify({ credentials }), { mode: 0o600 });
    return { token, credential_id: id };
  }

  async revokeTaskCredential(authPath: string, id: string) {
    const credentials = readCredentials(authPath).map((c) => (c.id === id ? { ...c, revoked: true } : c));
    writeFileSync(authPath, JSON.stringify({ credentials }), { mode: 0o600 });
  }

  /** Explicit stopped-store recovery: keep the current bytes aside, restore the backup disarmed. */
  async recoverTaskStore(taskPath: string, actor: string) {
    const quarantine = `${taskPath}.quarantine-1`;
    writeFileSync(quarantine, readFileSync(taskPath), { mode: 0o600 });
    const store = JSON.parse(readFileSync(`${taskPath}.backup`, "utf8"));
    for (const task of store.tasks) {
      task.armed = false;
      bumpRevision(store, task, { op: "recover", actor });
    }
    writeFileSync(taskPath, JSON.stringify(store), { mode: 0o600 });
    return { quarantine, restored_from: `${taskPath}.backup`, warnings: [] };
  }

  /** One poll of every file/Git source: a changed value (including a returning one) is one event. */
  async observeTaskSources(ctx: { path: string; now: () => number }) {
    const store = loadStore(ctx.path);
    for (const source of store.sources) {
      const value =
        source.kind === "file"
          ? readFileSync(join(String(source.root), String(source.path)), "utf8")
          : this.repos.get(String(source.root))?.refs.get(String(source.ref));
      const valueSha = sha("sha256", JSON.stringify(value ?? null));
      if (store.source_state[source.id] === valueSha) continue;
      store.source_state[source.id] = valueSha;
      store.events.push({
        id: `event-${++store.counters.event}`,
        source_id: source.id,
        actor: String(source.producer_actor),
        owner_domains: source.owner_domains as string[],
        value_sha256: valueSha,
        observed_at: ctx.now(),
      });
    }
    saveStore(ctx.path, store);
  }

  git(args: string[]) {
    const [flag, dir, ...rest] = args;
    if (flag !== "-C") throw new Error(`unexpected git call: ${args.join(" ")}`);
    const command = rest.filter((arg, i) => arg !== "-c" && rest[i - 1] !== "-c");
    const repo = this.repos.get(dir);
    if (command[0] === "rev-parse") return repo ? repo.head : FIXTURE_COMMIT;
    if (command[0] === "init") this.repos.set(dir, { head: "", refs: new Map(), commits: 0 });
    else if (command[0] === "commit" && repo) repo.head = sha("sha1", `${++repo.commits}:${command.at(-1)}`);
    else if (command[0] === "update-ref" && repo) repo.refs.set(command[1], command[2]);
    else throw new Error(`unexpected git call: ${args.join(" ")}`);
    return "";
  }
}

const world = () => (globalThis as Record<symbol, FakeWorld>)[WORLD];
export function enterWorld(next: FakeWorld) {
  (globalThis as Record<symbol, FakeWorld>)[WORLD] = next;
}

/** Feature checkout layout the driver reads: design doc, lockfile, legacy store and daemon modules. */
export function writeFeatureRoot(base: string) {
  const feature = join(base, "feature");
  const dist = join(feature, "packages/daemon/dist");
  const legacy = join(base, "messung-a-p2c-20261011/packages/daemon/dist");
  mkdirSync(join(feature, "docs/design"), { recursive: true });
  mkdirSync(dist, { recursive: true });
  mkdirSync(legacy, { recursive: true });
  const stand = "// Deterministic P2 characterization stand-in (#1649); not feature code.\n";
  const forward = (names: string[]) =>
    stand +
    `const world = () => globalThis[Symbol.for(${JSON.stringify(WORLD.description)})];\n` +
    names.map((n) => `export const ${n} = (...args) => world().${n}(...args);\n`).join("");
  writeFileSync(join(feature, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(feature, "package-lock.json"), "{}\n");
  writeFileSync(join(feature, "docs/design/proactive-tasks.md"), "# Stand-in design for P2 characterization\n");
  writeFileSync(join(legacy, "task-store.js"), stand);
  writeFileSync(join(dist, "daemon-spawn-env.js"), forward(["configFingerprint"]));
  writeFileSync(join(dist, "task-auth.js"), forward(["mintTaskCredential", "revokeTaskCredential"]));
  writeFileSync(join(dist, "task-store.js"), forward(["recoverTaskStore"]));
  writeFileSync(join(dist, "task-events.js"), forward(["observeTaskSources"]));
  for (const entry of ["index.js", "cli.js", "mcp-forwarder.js"]) writeFileSync(join(dist, entry), stand);
  return feature;
}

function fakeChild(name: string): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
  }) as FakeChild;
  child.kill = (signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    world().note({ kill: name, signal });
    setTimeout(() => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    });
    return true;
  };
  return child;
}
function exit(child: FakeChild, code: number) {
  setTimeout(() => {
    child.exitCode = code;
    child.emit("exit", code, null);
  });
}

function daemonContext(env: NodeJS.ProcessEnv): DaemonContext {
  const clockPath = env.BASTRA_MEASUREMENT_NOW_PATH;
  return {
    taskPath: env.BASTRA_TASKS_PATH!,
    authPath: join(String(env.BASTRA_TASKS_PATH), "../task-auth.json"),
    legacyToken: env.BASTRA_API_TOKEN!,
    relay: env.BASTRA_PENDING_RELAY === "1",
    now: () => (clockPath ? Number(readFileSync(clockPath, "utf8")) : Date.now()),
  };
}

/** Daemon: boots on the next virtual tick, then fires due tasks at start and every 60s. */
function startDaemon(env: NodeJS.ProcessEnv) {
  const child = fakeChild("daemon");
  const daemon: Daemon = { port: Number(env.BASTRA_HTTP_PORT), ctx: daemonContext(env), env, booted: false };
  world().daemon = daemon;
  const poll = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    world().note({ daemon: "poll" });
    contact(daemon.ctx);
    setTimeout(poll, 60000);
  };
  setTimeout(() => {
    daemon.booted = true;
    poll();
  });
  child.on("exit", () => {
    if (world().daemon === daemon) world().daemon = undefined;
  });
  return child;
}

const CLI_ROUTES: Record<string, (input: Record<string, unknown>) => [string, string]> = {
  create: () => ["POST", "/api/v1/task_create"],
  get: (input) => ["GET", `/api/v1/tasks/${input.id}`],
  list: () => ["GET", "/api/v1/tasks"],
  review: () => ["POST", "/api/v1/task_review"],
};
function request(via: string, env: NodeJS.ProcessEnv, route: [string, string], body: Record<string, unknown>) {
  const daemon = world().daemon;
  const headers = { Authorization: `Bearer ${env.BASTRA_TASK_TOKEN}` };
  const r = daemon?.booted
    ? handle(daemon.ctx, route[0], route[1], headers, route[0] === "GET" ? undefined : body)
    : { status: 503, data: { code: "daemon_unreachable" } };
  world().note({ via, method: route[0], path: route[1], status: r.status });
  return r;
}

function startCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = fakeChild("cli");
  setTimeout(() => {
    if (args[0] === "drafts" && args[1] === "purge") {
      child.stdout.end("purged pending drafts\n");
      return exit(child, 0);
    }
    const input = JSON.parse(readFileSync(args[3], "utf8"));
    const r = request("cli", env, CLI_ROUTES[args[1]](input), input);
    if (r.status === 200) child.stdout.end(JSON.stringify(r.data));
    else child.stderr.end(`${JSON.stringify(r.data)}\n`);
    exit(child, r.status === 200 ? 0 : 1);
  });
  return child;
}

const MCP_ROUTES: Record<string, (input: Record<string, unknown>) => [string, string]> = {
  task_create: CLI_ROUTES.create,
  task_get: CLI_ROUTES.get,
  task_list: CLI_ROUTES.list,
  task_review: CLI_ROUTES.review,
};
function mcpResult(env: NodeJS.ProcessEnv, message: Record<string, any>) {
  if (message.method === "initialize") return { protocolVersion: "2025-03-26", capabilities: {} };
  const args = message.params.arguments;
  const r = request("mcp", env, MCP_ROUTES[message.params.name](args), args);
  return { content: [{ type: "text", text: JSON.stringify(r.data) }], isError: r.status !== 200 };
}
function startMcp(env: NodeJS.ProcessEnv) {
  const child = fakeChild("mcp");
  let pending = "";
  child.stdin.on("data", (chunk) => {
    pending += chunk;
    for (let n = pending.indexOf("\n"); n >= 0; n = pending.indexOf("\n")) {
      const message = JSON.parse(pending.slice(0, n));
      pending = pending.slice(n + 1);
      if (message.id === undefined) continue;
      setTimeout(() =>
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: mcpResult(env, message) }) + "\n")
      );
    }
  });
  return child;
}

function startStandIn(entry: string, args: string[], env: NodeJS.ProcessEnv) {
  const name = basename(entry);
  world().note({ spawn: name, args });
  if (name === "index.js") return startDaemon(env);
  if (name === "cli.js") return startCli(args, env);
  if (name === "mcp-forwarder.js") return startMcp(env);
  throw new Error(`unexpected child process: ${name}`);
}

async function fakeFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const target = new URL(url);
  const daemon = world().daemon;
  const path = target.pathname;
  const method = init.method ?? "GET";
  if (target.hostname !== "127.0.0.1" || !daemon?.booted || Number(target.port) !== daemon.port) {
    world().note({ via: "http", method, path, refused: true });
    throw new TypeError("fetch failed");
  }
  const r =
    path === "/health"
      ? {
          status: 200,
          data: { build_revision: FIXTURE_COMMIT, config_fingerprint: world().configFingerprint(daemon.env) },
        }
      : handle(daemon.ctx, method, path, init.headers ?? {}, init.body ? JSON.parse(init.body) : undefined);
  world().note({ via: "http", method, path, status: r.status });
  const body = JSON.stringify(r.data);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(body) };
}

/**
 * Route the driver's child processes and Git calls inside `base` and all HTTP to the
 * stand-ins. Other callers (the TypeScript loader) keep the real functions. Child process only.
 */
export function installProcessFakes(base: string) {
  const { spawn, execFileSync } = childProcess;
  const inside = (path: unknown) => typeof path === "string" && path.startsWith(base);
  Object.assign(childProcess, {
    spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) =>
      inside(args?.[0]) ? startStandIn(args[0], args.slice(1), options.env) : spawn(command, args, options),
    execFileSync: (command: string, args: string[], options: object) =>
      command === "git" && args?.[0] === "-C" && inside(args[1])
        ? world().git(args)
        : execFileSync(command, args, options),
  });
  syncBuiltinESMExports();
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
}
