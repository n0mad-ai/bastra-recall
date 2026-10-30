import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskMcp, dispatchTaskHttp, taskFailure, taskTools } from "../src/task-transport.js";
import { taskCliCall } from "../src/cli/tasks-cmd.js";
import { dispatchApiSurface, type ApiSurfaceCtx } from "../src/http-api-surface.js";
import { TASK_CRUD_OPERATIONS } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-transports-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000 };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const server = createServer((req, res) => { if (!dispatchTaskHttp(req, res, req.method!, req.url!, ctx)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const input = { idempotency_key: "fixture", original_request: "Check after seven days", goal: "Evaluate",
    resolution_condition: "Owner evaluation", schedule: { kind: "instant", at: 2000 }, timezone: "Europe/Madrid",
    scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"] };
  return { ctx, owner, agent, base, input, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
test("HTTP canonical routes, MCP and CLI share creation, revision and lifecycle semantics", async () => {
  const f = await fixture(); try {
    const auth = `Bearer ${f.owner.token}`;
    const resp = await fetch(`${f.base}/api/v1/tasks`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(f.input) });
    assert.equal(resp.status, 200); let row = await resp.json() as any;
    const mcp = await callTaskMcp("task_get", { id: row.id }, auth, f.ctx);
    assert.deepEqual(JSON.parse(mcp.content[0].text), row);
    assert.deepEqual(await taskCliCall("get", { id: row.id }, auth, f.base), row);
    row = await taskCliCall("review", { id: row.id, expected_revision: row.expected_revision }, auth, f.base) as any;
    assert.equal(row.armed, true);
    row = JSON.parse((await callTaskMcp("task_snooze", { id: row.id, expected_revision: row.expected_revision, until: 3000 }, auth, f.ctx)).content[0].text);
    assert.equal(row.state, "snoozed");
    row = await taskCliCall("resolve", { id: row.id, expected_revision: row.expected_revision }, auth, f.base) as any;
    assert.equal(row.state, "resolved"); assert.equal((await readTaskStore(f.ctx.path)).tasks.length, 1);
  } finally { await f.close(); }
});
test("all transports report common validation/unauthorized/forbidden/not-found/conflict codes", async () => {
  const f = await fixture(); try {
    const auth = `Bearer ${f.owner.token}`;
    const row = await taskCliCall("create", f.input, auth, f.base) as any;
    for (const [op, body, header, status, code] of [
      ["task_get", { actor: "owner" }, auth, 400, "validation"],
      ["task_get", { id: row.id }, "Bearer invalid", 401, "unauthorized"],
      ["task_review", { id: row.id, expected_revision: row.expected_revision }, `Bearer ${f.agent.token}`, 403, "forbidden"],
      ["task_get", { id: "missing" }, auth, 404, "not_found"],
      ["task_cancel", { id: row.id, expected_revision: "initial:999" }, auth, 409, "conflict"],
    ] as const) {
      const response = await fetch(`${f.base}/api/v1/${op}`, { method: "POST", headers: { Authorization: header, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, status); const result = await response.json() as any; assert.equal(result.code, code);
      const mcp = await callTaskMcp(op, body, header, f.ctx);
      assert.equal(mcp.isError, true); assert.deepEqual(JSON.parse(mcp.content[0].text), result);
      await assert.rejects(taskCliCall(op.slice(5), body, header, f.base), (e: any) => {
        assert.deepEqual(taskFailure(e).body, result); return true;
      });
    }
  } finally { await f.close(); }
});
test("loopback skip and legacy API token cannot authorize task routes; foreign Origin rejected", async () => {
  const server = createServer((req, res) => dispatchApiSurface(req, res, req.method!, req.url!, {
    server: { corsAllow: [], apiToken: "legacy", loopbackSkip: true },
  } as unknown as ApiSurfaceCtx));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const headers of [{}, { Authorization: "Bearer legacy" }] as Record<string, string>[]) assert.equal((await fetch(`${base}/api/v1/tasks`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/tasks`, { headers: { Origin: "https://evil.invalid" } })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("every CRUD operation has a canonical strict MCP definition", () => {
  assert.deepEqual(taskTools.map(t => t.name), [...TASK_CRUD_OPERATIONS]);
  for (const def of taskTools) assert.equal((def.inputSchema as any).additionalProperties, false);
});
test("malformed and oversized request bodies are non-retryable validation errors", async () => {
  const f = await fixture(); try {
    for (const body of ["{bad", JSON.stringify({ original_request: "a".repeat(256 * 1024 + 1) })]) {
      const response = await fetch(`${f.base}/api/v1/tasks`, { method: "POST", headers: { Authorization: `Bearer ${f.owner.token}`, "Content-Type": "application/json" }, body });
      assert.equal(response.status, 400); const error = await response.json() as any;
      assert.equal(error.code, "validation"); assert.equal(error.retryable, false);
    }
  } finally { await f.close(); }
});
test("unknown errors never expose raw filesystem codes", () => {
  const failure = taskFailure(Object.assign(new Error("invented private path"), { code: "ENOENT" }));
  assert.equal(failure.body.code, "unavailable"); assert.ok(!JSON.stringify(failure).includes("ENOENT"));
  assert.ok(!JSON.stringify(failure).includes("private path"));
});

test("task routes enforce the same local Host gate even with a valid mapped token",async()=>{
 const f=await fixture();try{const {request}=await import("node:http");for(const host of ["foreign.invalid","localhost.evil.invalid"]){const status=await new Promise<number>((resolve,reject)=>{const r=request(f.base+"/api/v1/tasks",{headers:{Host:host,Authorization:`Bearer ${f.owner.token}`}},res=>{res.resume();resolve(res.statusCode!);});r.on("error",reject);r.end();});assert.equal(status,403);}assert.equal((await fetch(f.base+"/api/v1/tasks",{headers:{Authorization:`Bearer ${f.owner.token}`}})).status,200);}finally{await f.close();}
});

test("#1331: agent MCP and HTTP conversational callers create commissioned notify armed", async () => {
  const f = await fixture();
  try {
    const auth = `Bearer ${f.agent.token}`;
    const origin = { kind: "user-request", client: "fixture", session: "confirmed-session", context: "User explicitly requested this reminder" };
    const result = await callTaskMcp("task_create", { ...f.input, origin }, auth, f.ctx);
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).armed, true);
    const http = await fetch(`${f.base}/api/v1/tasks`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ ...f.input, idempotency_key: "http-confirmed", goal: "HTTP reminder", origin }) });
    assert.equal(http.status, 200);
    assert.equal((await http.json() as any).armed, true);
  } finally { await f.close(); }
});
test("#1331: task_create tells agents to arm clear requested/confirmed notify without owner review", () => {
  const description = taskTools.find(t => t.name === "task_create")!.description;
  assert.match(description, /requested or confirmed.*arm=true/i);
  assert.match(description, /no (?:additional )?owner review/i);
  assert.doesNotMatch(description, /For user requests first confirm/);
});
