import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { checkArtifacts, discoverGetRoutes, discoverPostTools, generatedArtifacts, generateDocuments, personalizedAction } from "../scripts/generate-openapi.js";
import { TASK_HTTP_ROUTES, matchTaskHttpRoute } from "../src/task-http-routes.js";
import { taskTools } from "../src/task-transport.js";

test("generator is byte deterministic and the checked-in artifacts have no drift", () => {
  const artifacts = generatedArtifacts();
  assert.deepEqual(generatedArtifacts(), artifacts);
  assert.deepEqual(checkArtifacts(artifacts), []);
  for (const content of Object.values(artifacts)) {
    const doc = JSON.parse(content.replace(/^#.*\n/, ""));
    const ids = Object.values(doc.paths).flatMap((methods: any) => Object.values(methods).map((op: any) => op.operationId));
    assert.equal(new Set(ids).size, ids.length, "operationIds must be globally unique");
    assert.equal(doc.openapi, "3.0.3");
  }
});
test("drift gate catches edited and missing artifacts", () => {
  const artifacts = generatedArtifacts();
  assert.deepEqual(checkArtifacts(artifacts, () => "hand edit"), Object.keys(artifacts));
  assert.deepEqual(checkArtifacts(artifacts, () => { throw new Error("missing"); }), Object.keys(artifacts));
});
test("actual dispatcher branches determine coverage and shared tool schemas determine requests", () => {
  const { api, action } = generateDocuments();
  for (const name of discoverPostTools().keys()) assert.ok(api.paths[`/${name}`]?.post, name);
  for (const path of discoverGetRoutes().keys()) assert.ok(api.paths[path]?.get, path);
  for (const tool of taskTools) assert.ok(api.paths[`/${tool.name}`]?.post, tool.name);
  for (const route of TASK_HTTP_ROUTES) {
    assert.ok(api.paths[route.path]?.[route.method.toLowerCase()], route.path);
    assert.deepEqual(matchTaskHttpRoute(route.method, `/api/v1${route.path.replace("{id}", "test-1")}`), {
      operation: route.operation, ...(route.path.includes("{id}") ? { id: "test-1" } : {}),
    });
  }
  assert.deepEqual(matchTaskHttpRoute("GET", "/api/v1/tasks/"), { operation: "task_list" });
  assert.equal(matchTaskHttpRoute("GET", "/api/v1/tasks/invalid%20id"), undefined);
  assert.equal(matchTaskHttpRoute("DELETE", "/api/v1/tasks/test"), undefined);
  const findDocument: any = api.paths["/find_document"]?.post;
  assert.equal(findDocument.requestBody.content["application/json"].schema.properties.k.maximum, 5);
  assert.deepEqual(findDocument.requestBody.content["application/json"].schema.required, ["query"]);
  assert.deepEqual(findDocument.responses["401"], { $ref: "#/components/responses/Error401" });
  assert.ok(action.paths["/recall"]?.post);
  assert.ok(action.paths["/edit_memory"]?.post);
  assert.ok(action.paths["/floors"]?.get);
  assert.ok(!Object.keys(action.paths).some(path => path.startsWith("/task")));
  assert.equal(action.components.securitySchemes.taskCredential, undefined);
  const taskGet: any = api.paths["/tasks/{id}"]?.get;
  assert.deepEqual(taskGet.parameters.map((parameter: any) => parameter.name), ["id"]);
  assert.equal(taskGet.requestBody, undefined);
});
test("new routes or changed schemas cannot silently keep the old artifacts", () => {
  const postSource = readFileSync(new URL("../src/http-api-routes.ts", import.meta.url), "utf8");
  assert.throws(() => generateDocuments({ postSource: postSource.replace('case "recall":', 'case "new_unmapped_tool":\ncase "recall":') }), /no input schema/);
  const getSource = readFileSync(new URL("../src/http-api-surface.ts", import.meta.url), "utf8");
  const { api } = generateDocuments({ getSource: getSource.replace('u.pathname === "/api/v1/health"', 'u.pathname === "/api/v1/new_health"') });
  assert.ok(api.paths["/new_health"]?.get);
  assert.equal(api.paths["/health"], undefined);
  assert.notDeepEqual(api, generateDocuments().api);
  assert.throws(() => discoverPostTools("// dispatcher disappeared"), /No HTTP dispatcher/);
  assert.throws(() => discoverGetRoutes("// routing disappeared"), /No HTTP GET/);
});

test("a personalized GPT Action accepts the user's public HTTPS address without changing defaults", () => {
  const defaults = generatedArtifacts();
  const action = personalizedAction("https://my-recall.example.com/api/v1/");
  assert.deepEqual(action.servers, [{ url: "https://my-recall.example.com/api/v1" }]);
  assert.deepEqual(generatedArtifacts(), defaults);
  assert.deepEqual(action.paths, generateDocuments().action.paths);
});

test("GET discovery rejects unfamiliar pathname guards even when known routes remain", () => {
  const known = 'if (u.pathname === "/api/v1/health") {}';
  for (const guard of [
    'u.pathname.startsWith("/api/v1/new")',
    'u.pathname === NEW_ROUTE',
    '"/api/v1/new" === u.pathname',
    'u.pathname == "/api/v1/new"',
    'u.pathname === "/api/v1/new" && enabled',
  ]) {
    assert.throws(() => discoverGetRoutes(`${known} if (${guard}) {}`), /Unsupported HTTP GET pathname guard/, guard);
  }
});
