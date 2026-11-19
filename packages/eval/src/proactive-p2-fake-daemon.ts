/**
 * Request handler of the stand-in daemon for the deterministic P2 characterization
 * mode (#1649). It answers the routes the P2 driver calls with reproducible data so
 * the driver's own behaviour can be pinned. It is NOT the feature: its answers carry
 * no evidence about the real daemon, and the fixture output says so.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  StoreUnavailable,
  bumpRevision,
  loadStore,
  madridInstant,
  reconcile,
  resetSlots,
  saveStore,
  type Store,
  type Task,
} from "./proactive-p2-fake-store.js";

export interface Credential {
  id: string;
  actor_id: string;
  domains: string[];
  role: "owner" | "agent";
  token_sha256: string;
  revoked: boolean;
}
export interface DaemonContext {
  taskPath: string;
  authPath: string;
  legacyToken: string;
  relay: boolean;
  now: () => number;
}
export interface Reply {
  status: number;
  data: unknown;
}
interface Call {
  ctx: DaemonContext;
  store: Store;
  actor: Credential;
  body: Record<string, any>;
  params: string[];
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const reply = (status: number, data: unknown): Reply => ({ status, data });
const deny = (status: number, code: string) => reply(status, { code });
const terminal = (task: Task) => task.state === "resolved" || task.state === "cancelled";
const visible = (actor: Credential, task: Task) =>
  (task.owner_domains as string[]).some((d) => actor.domains.includes(d));

export function readCredentials(authPath: string): Credential[] {
  return existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")).credentials : [];
}
function credentialFor(authPath: string, header: string | undefined) {
  const token = header?.replace(/^Bearer /, "");
  if (!token) return undefined;
  return readCredentials(authPath).find((c) => c.token_sha256 === sha256(token) && !c.revoked);
}

function schedule(body: Record<string, any>) {
  const requested = body.schedule ?? {};
  if (requested.kind !== "calendar") return requested;
  const instant = madridInstant(requested.local_time, requested.overlap);
  return instant && { ...requested, ...instant };
}
function createRefusal(actor: Credential, body: Record<string, any>) {
  if (["source", "approved", "actor"].some((key) => Object.hasOwn(body, key))) return deny(400, "unknown_field");
  if (!(body.owner_domains ?? []).every((d: string) => actor.domains.includes(d))) return deny(403, "domain_denied");
  const level = body.action_level ?? "notify";
  const agentArm = actor.role === "agent" && body.arm === true;
  if (agentArm && (level !== "notify" || body.origin?.kind !== "user-request")) return deny(403, "owner_required");
  return undefined;
}
function create({ store, actor, body, ctx }: Call): Reply {
  const refusal = createRefusal(actor, body);
  if (refusal) return refusal;
  const { idempotency_key: key, arm, ...request } = body;
  const requestSha = sha256(JSON.stringify({ arm, ...request }));
  const existing = store.tasks.find((t) => t.created_by === actor.actor_id && t.idempotency_key === key);
  if (existing)
    return existing.request_sha256 === requestSha ? reply(200, existing) : deny(409, "idempotency_conflict");
  const resolved = schedule(body);
  if (!resolved) return deny(400, "nonexistent_local_time");
  const now = ctx.now();
  const task: Task = {
    ...request,
    id: `task-${++store.counters.task}`,
    expected_revision: "",
    state: "pending",
    armed: arm === true,
    action_level: body.action_level ?? "notify",
    generation: 1,
    schedule: resolved,
    next_slot_index: 0,
    created_by: actor.actor_id,
    idempotency_key: key,
    request_sha256: requestSha,
    created_at: now,
    history: [],
  };
  resetSlots(task);
  bumpRevision(store, task, { op: "create", actor: actor.actor_id, at: now });
  store.tasks.push(task);
  saveStore(ctx.taskPath, store);
  return reply(200, task);
}

function findTask({ store, actor }: Call, id: string) {
  const task = store.tasks.find((t) => t.id === id);
  return task && visible(actor, task) ? task : undefined;
}
function patchTask(call: Call): Reply {
  const task = findTask(call, call.params[0]);
  if (!task) return deny(404, "not_found");
  if (task.expected_revision !== call.body.expected_revision || terminal(task)) return deny(409, "revision_conflict");
  const patch = call.body.patch ?? {};
  Object.assign(task, patch, { armed: false });
  if (patch.schedule) {
    task.generation++;
    task.state = "pending";
    delete task.snoozed_until;
    resetSlots(task);
  }
  bumpRevision(call.store, task, { op: "edit", actor: call.actor.actor_id, at: call.ctx.now(), patch });
  saveStore(call.ctx.taskPath, call.store);
  return reply(200, task);
}

type Operation = (call: Call, task: Task) => Reply | undefined;
const OWNER_ONLY = new Set(["review", "rearm"]);
const OPERATIONS: Record<string, Operation> = {
  review: (_call, task) => (terminal(task) ? deny(409, "terminal") : void (task.armed = true)),
  rearm: (_call, task) => {
    Object.assign(task, { state: "pending", armed: false, generation: task.generation + 1 });
    resetSlots(task);
  },
  acknowledge: ({ store, body, actor, ctx }, task) => {
    const occurrence = store.occurrences.find((o) => o.id === body.occurrence_id && o.task_id === task.id);
    if (!occurrence) return deny(404, "occurrence_not_found");
    occurrence.acknowledgement = { actor: actor.actor_id, at: ctx.now() };
    return undefined;
  },
  snooze: ({ body }, task) => void (task.snoozed_until = body.until),
  resolve: ({ store, actor, ctx }, task) => {
    task.state = "resolved";
    for (const o of store.occurrences.filter((o) => o.task_id === task.id && !o.resolution))
      o.resolution = { actor: actor.actor_id, at: ctx.now() };
  },
  cancel: (_call, task) => void (task.state = "cancelled"),
};
function operation(name: string): (call: Call) => Reply {
  return (call) => {
    if (OWNER_ONLY.has(name) && call.actor.role !== "owner") return deny(403, "owner_required");
    const task = findTask(call, call.body.id);
    if (!task) return deny(404, "not_found");
    if (task.expected_revision !== call.body.expected_revision) return deny(409, "revision_conflict");
    const refusal = OPERATIONS[name](call, task);
    if (refusal) return refusal;
    bumpRevision(call.store, task, { op: name, actor: call.actor.actor_id, at: call.ctx.now() });
    saveStore(call.ctx.taskPath, call.store);
    return reply(200, task);
  };
}

/** Cards for open occurrences; a budget below one card yields only an untargeted availability notice. */
function due({ store, actor, body, ctx }: Pick<Call, "store" | "actor" | "body" | "ctx">) {
  const open = store.occurrences.filter((o) => {
    const task = store.tasks.find((t) => t.id === o.task_id);
    return task && visible(actor, task) && !o.resolution && (body.include_acknowledged || !o.acknowledgement);
  });
  if ((body.max_bytes ?? 2048) < 512)
    return { cards: [{ kind: "availability", pending: open.length }], overflow: open.length, pending: open.length };
  const shown = open.slice(0, 3);
  for (const o of shown) o.attempts.push({ actor: actor.actor_id, session: body.session ?? null, at: ctx.now() });
  if (shown.length) saveStore(ctx.taskPath, store);
  return {
    cards: shown.map((o) => ({
      kind: "occurrence",
      task_id: o.task_id,
      occurrence_id: o.id,
      due_at: o.due_at,
      acknowledged: Boolean(o.acknowledgement),
    })),
    pending: open.length,
    coverage: "next-contact-only",
    relay: ctx.relay,
  };
}

function registerSource({ store, actor, body, ctx }: Call): Reply {
  if (!(body.owner_domains ?? []).every((d: string) => actor.domains.includes(d))) return deny(403, "domain_denied");
  store.sources = [...store.sources.filter((s) => s.id !== body.id), { ...body, id: body.id }];
  saveStore(ctx.taskPath, store);
  return reply(200, { source: body });
}
function submitEvent({ store, actor, body, ctx }: Call): Reply {
  const source = store.sources.find((s) => s.id === body.source_id);
  if (!source) return deny(404, "source_not_found");
  if (source.producer_actor !== actor.actor_id) return deny(403, "producer_mismatch");
  const valueSha = sha256(JSON.stringify(body.value));
  const existing = store.events.find((e) => e.source_id === body.source_id && e.dedup_key === body.dedup_key);
  if (existing) return existing.value_sha256 === valueSha ? reply(200, { event_id: existing.id }) : deny(409, "drift");
  const event = {
    id: `event-${++store.counters.event}`,
    source_id: source.id,
    dedup_key: body.dedup_key,
    actor: actor.actor_id,
    owner_domains: source.owner_domains as string[],
    value_sha256: valueSha,
    state_updated_at: body.state_updated_at,
    accepted_at: ctx.now(),
  };
  store.events.push(event);
  saveStore(ctx.taskPath, store);
  return reply(200, { event_id: event.id });
}

const ROUTES: Array<[string, RegExp, (call: Call) => Reply]> = [
  [
    "GET",
    /^\/api\/v1\/tasks$/,
    ({ store, actor }) => reply(200, { tasks: store.tasks.filter((t) => visible(actor, t)) }),
  ],
  [
    "GET",
    /^\/api\/v1\/tasks\/([^/]+)$/,
    (call) => {
      const task = findTask(call, call.params[0]);
      return task ? reply(200, task) : deny(404, "not_found");
    },
  ],
  ["PATCH", /^\/api\/v1\/tasks\/([^/]+)$/, patchTask],
  ["POST", /^\/api\/v1\/tasks$/, create],
  ["POST", /^\/api\/v1\/task_create$/, create],
  ["POST", /^\/api\/v1\/task_due$/, (call) => reply(200, due(call))],
  ["POST", /^\/api\/v1\/tasks\/sources$/, registerSource],
  ["POST", /^\/api\/v1\/tasks\/events$/, submitEvent],
  ["POST", /^\/api\/v1\/tasks\/reconcile$/, () => reply(200, { reconciled: true })],
  ...Object.keys(OPERATIONS).map((name): [string, RegExp, (call: Call) => Reply] => [
    "POST",
    new RegExp(`^/api/v1/task_${name}$`),
    operation(name),
  ]),
];

/** Loads the store and fires due tasks for an authorised contact; a 503 reply when the store is unreadable. */
export function contact(ctx: DaemonContext): Store | Reply {
  try {
    const store = loadStore(ctx.taskPath);
    if (reconcile(store, ctx.now())) saveStore(ctx.taskPath, store);
    return store;
  } catch (error) {
    if (error instanceof StoreUnavailable) return deny(503, error.code);
    throw error;
  }
}

function legacyHealth(ctx: DaemonContext, headers: Record<string, string>): Reply {
  if (headers.Authorization !== `Bearer ${ctx.legacyToken}`) return deny(401, "unauthenticated");
  const actor = credentialFor(ctx.authPath, headers["x-bastra-task-authorization"]);
  if (!actor) return reply(200, { ok: true });
  const store = contact(ctx);
  if (!("tasks" in store)) return reply(200, { ok: true });
  return reply(200, { ok: true, proactive_due: due({ store, actor, body: {}, ctx }) });
}

export function handle(
  ctx: DaemonContext,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Record<string, any> = {}
): Reply {
  if (path === "/api/v1/health") return legacyHealth(ctx, headers);
  if (headers.Origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(headers.Origin))
    return deny(403, "origin_denied");
  const actor = credentialFor(ctx.authPath, headers.Authorization);
  if (!actor) return deny(401, "unauthenticated");
  const route = ROUTES.find(([m, pattern]) => m === method && pattern.test(path));
  if (!route) return deny(404, "no_route");
  const store = contact(ctx);
  if (!("tasks" in store)) return store;
  return route[2]({ ctx, store, actor, body, params: path.match(route[1])!.slice(1) });
}
