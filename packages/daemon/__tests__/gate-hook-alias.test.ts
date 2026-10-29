import { it } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("the published gate-hook bin alias forwards PreToolUse and prints the daemon deny", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-gate-alias-"));
  const payload = { hook_event_name: "PreToolUse", session_id: "gate-alias", tool_name: "Edit", tool_input: { file_path: "/fixture.ts" } };
  const response = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Load fixture-rule first" } });
  const requests: Array<{ method: string | undefined; url: string | undefined; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      res.end(response);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const alias = join(dir, "bastra-recall-gate-hook");
    // npm and Homebrew expose this extensionless symlink, rather than gate-hook.js.
    // npm test's pretest builds dist before this process-level regression runs.
    await symlink(fileURLToPath(new URL("../dist/gate-hook.js", import.meta.url)), alias);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [alias], {
        env: { ...process.env, BASTRA_DAEMON_URL: `http://127.0.0.1:${address.port}`, BASTRA_TELEMETRY: "off", BASTRA_HOOK_TIMEOUT_MS: "5000" },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, response, "the alias must run the hook and preserve the daemon decision");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "POST");
    assert.equal(requests[0]!.url, "/hook/gate");
    const forwarded = JSON.parse(requests[0]!.body).payload;
    for (const [key, value] of Object.entries(payload)) assert.deepEqual(forwarded[key], value);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
