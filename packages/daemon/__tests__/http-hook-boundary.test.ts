import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHookRecall, type HookRecallDeps } from "../src/http-hook-routes.js";
import { MAX_BODY_BYTES } from "../src/http-util.js";

// Exercise the real handler without a server, sockets, timers or a live vault.
function respond(raw: string, sse: boolean, deps = {} as HookRecallDeps) {
  const req = Object.assign(new EventEmitter(), {
    headers: { accept: sse ? "text/event-stream" : "application/json" },
    socket: { destroyed: false },
  });
  const headers: Record<string, string> = {};
  let output = "";
  let status = 0;
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const res = {
    headersSent: false,
    destroyed: false,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
    },
    write(chunk: string) {
      output += chunk;
    },
    end(chunk = "") {
      output += chunk;
      finish();
    },
  };
  handleHookRecall(
    req as IncomingMessage,
    res as unknown as ServerResponse,
    0,
    deps.vault,
    deps.search,
    deps.telemetry
  );
  req.emit("data", Buffer.from(raw));
  req.emit("end");
  return ended.then(() => ({ status, headers, output }));
}

for (const sse of [false, true]) {
  for (const [name, raw, error] of [
    ["missing query", "{}", "query is required"],
    ["blank query", '{"query":"  "}', "query is required"],
    ["non-string query", '{"query":4}', "query is required"],
    ["invalid JSON", "{", "invalid JSON body"],
    ["oversized body", "x".repeat(MAX_BODY_BYTES + 1), "body too large:"],
  ]) {
    test(`hook boundary: ${sse ? "SSE" : "JSON"} ${name}`, async () => {
      const response = await respond(raw!, sse);
      assert.equal(response.status, sse ? 200 : 400);
      assert.match(response.headers["Content-Type"]!, sse ? /text\/event-stream/ : /application\/json/);
      assert.ok(response.output.includes(error!));
      if (sse) assert.equal((response.output.match(/event: error/g) ?? []).length, 1);
      assert.ok(!response.output.includes("event: done"));
    });
  }

  test(`hook boundary: ${sse ? "SSE" : "JSON"} pipeline failure`, async () => {
    const deps = {
      telemetry: {
        rotateTurn() {
          throw new Error("retrieval failed");
        },
      },
    } as unknown as HookRecallDeps;
    const response = await respond('{"query":"valid query","tool_name":"UserPromptSubmit"}', sse, deps);
    assert.equal(response.status, sse ? 200 : 400);
    assert.ok(response.output.includes("retrieval failed"));
    assert.ok(!response.output.includes("event: done"));
  });
}
