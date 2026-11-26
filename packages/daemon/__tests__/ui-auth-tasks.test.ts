/**
 * #1198 S5 — the Tasks browser session is bound to the web UI session: it works
 * through the tunnel with a valid UI session, ends with that session, and the
 * sign-in never grants Owner authority (the principal stays the local agent).
 */
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalTaskAgent } from "../src/task-auto-setup.js";
import {
  JSON_TYPE,
  PUBLIC_ORIGIN,
  call,
  cookieOf,
  createAccount,
  resetAuth,
  signIn,
  tunnel,
  withServer,
} from "./ui-auth-harness.js";

test("Tasks session through the tunnel follows the UI session", async () => {
  const root = await mkdtemp(join(tmpdir(), "ui-auth-tasks-"));
  const previous = { path: process.env.BASTRA_TASKS_PATH, token: process.env.BASTRA_TASK_TOKEN };
  process.env.BASTRA_TASKS_PATH = join(root, "tasks.json");
  delete process.env.BASTRA_TASK_TOKEN;
  try {
    resetAuth();
    await createAccount();
    await ensureLocalTaskAgent();
    await withServer(async (port) => {
      const ui = await signIn(port, "public");
      const write = (cookie: string, extra: Record<string, string> = {}) =>
        tunnel({ ...JSON_TYPE, origin: PUBLIC_ORIGIN, cookie, "x-bastra-csrf": ui.csrf, ...extra });
      const opened = await call(port, "POST", "/ui/tasks/session", write(ui.cookie), "{}");
      assert.equal(opened.status, 200, opened.body);
      assert.equal(opened.json().role, "agent", "never the Owner");
      assert.match(
        opened.headers["set-cookie"]![0]!,
        /^bastra_task_session=[^;]+; Secure; HttpOnly; SameSite=Strict; Path=\/ui\/tasks\/$/
      );
      const both = `${ui.cookie}; ${cookieOf(opened)}`;
      const taskCsrf = String(opened.json().csrf);
      const status = await call(
        port,
        "POST",
        "/ui/tasks/api/task_status",
        write(both, { "x-bastra-task-csrf": taskCsrf }),
        "{}"
      );
      assert.equal(status.status, 200, status.body);

      // A new UI session (another sign-in) does not inherit the old Tasks grant.
      const again = await signIn(port, "public");
      const mixed = `${again.cookie}; ${cookieOf(opened)}`;
      const stale = await call(
        port,
        "POST",
        "/ui/tasks/api/task_status",
        tunnel({
          ...JSON_TYPE,
          origin: PUBLIC_ORIGIN,
          cookie: mixed,
          "x-bastra-csrf": again.csrf,
          "x-bastra-task-csrf": taskCsrf,
        }),
        "{}"
      );
      assert.equal(stale.status, 401);

      // Logging out ends the UI session and with it the Tasks grant.
      assert.equal((await call(port, "POST", "/ui/auth/logout", write(ui.cookie), "{}")).status, 200);
      const after = await call(
        port,
        "POST",
        "/ui/tasks/api/task_status",
        write(both, { "x-bastra-task-csrf": taskCsrf }),
        "{}"
      );
      assert.equal(after.status, 401);
    });
  } finally {
    if (previous.path === undefined) delete process.env.BASTRA_TASKS_PATH;
    else process.env.BASTRA_TASKS_PATH = previous.path;
    if (previous.token !== undefined) process.env.BASTRA_TASK_TOKEN = previous.token;
  }
});
