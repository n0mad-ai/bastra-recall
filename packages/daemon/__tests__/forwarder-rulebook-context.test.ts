import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";

test("forwarder ignores a foreign inherited Codex thread and does not equate missing statusline with missing hooks", async t => {
  let headers: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    headers = req.headers; req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/hook/session-context" ? { context: "Invented rulebook context." } : { body: "Invented rule body." }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${port}`;
  process.env.CODEX_THREAD_ID = "fixture-codex-thread";
  const { callDaemon, maybeSessionContextItem } = await import("../src/mcp-forwarder-calls.js");
  await callDaemon("load_memory", { id: "fixture-rule" });
  assert.equal(headers["x-bastra-cc-session"], undefined);
  assert.equal(headers["x-bastra-agent-id"], undefined);
  const context = await maybeSessionContextItem();
  assert.match(context?.text ?? "", /Codex CLI 0\.162\.1/);
  assert.doesNotMatch(context?.text ?? "", /advisory here/);
  assert.equal(await maybeSessionContextItem(), null, "first-call context/notice remains one-shot");
});

 test("fix2: Claude statusline wins over inherited Codex environment", async t => {
  const { liveStatusline }=await import("../src/mcp-forwarder-statusline.js");
  const { callDaemon }=await import("../src/mcp-forwarder-calls.js");
  const old=liveStatusline.cc_session_id;
  liveStatusline.cc_session_id="own-claude-session";
  const fetchBefore=globalThis.fetch;
  globalThis.fetch=async (_url,opts)=>{
    const headers=opts?.headers as Record<string,string>;
    assert.equal(headers["x-bastra-cc-session"],"own-claude-session");
    assert.equal(headers["x-bastra-agent-id"],undefined);
    return new Response('{}',{status:200});
  };
  try {await callDaemon("load_memory",{id:"fixture"});}
  finally {globalThis.fetch=fetchBefore;liveStatusline.cc_session_id=old;}
});
