// v22 shell data (js/data.js): the task list and the reports load together at
// page start. Both used to request their own task session without a cookie; the
// browser kept only the second cookie, so the first caller's CSRF token was
// refused and the unread report stayed out of the header ticker until the next
// 60 s poll. The fake server below follows src/task-ui-session.ts: a request
// without a known cookie opens a new session, a known cookie gets its own token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function shell() {
  const [dataSrc, modelSrc] = await Promise.all([
    readFile(new URL("../webui/v22/js/data.js", import.meta.url), "utf8"),
    readFile(new URL("../webui/v22/js/sections/tasks-reports-model.js", import.meta.url), "utf8"),
  ]);
  const sessions = new Map<string, string>(); // cookie → csrf
  let jar: string | null = null,
    n = 0,
    sessionCalls = 0;
  const tick = () => new Promise((r) => setTimeout(r, 1));
  const json = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });
  async function fetch(url: string, init: { headers?: Record<string, string>; body?: string } = {}) {
    const cookie = jar; // the cookie the browser sends is the one it held when the request left
    await tick();
    if (url === "/ui/tasks/session") {
      sessionCalls++;
      if (cookie && sessions.has(cookie)) return json(200, { csrf: sessions.get(cookie) });
      const id = `s${++n}`;
      sessions.set(id, `csrf-${id}`);
      await tick();
      jar = id; // Set-Cookie: the latest answer wins
      return json(200, { csrf: `csrf-${id}` });
    }
    if (!cookie || !sessions.has(cookie)) return json(401, {});
    if (init.headers?.["x-bastra-task-csrf"] !== sessions.get(cookie)) return json(403, {});
    if (url === "/ui/tasks/api/task_list") return json(200, { tasks: [] });
    if (url === "/ui/tasks/api/task_report_list")
      return json(200, {
        reports: [{ id: "r1", title: "Nachtbericht", origin: { client: "claude-code" }, created_at: 1 }],
      });
    return json(404, {});
  }
  const document = { documentElement: { dataset: { tasksEnabled: "true" } }, hidden: false };
  const source =
    modelSrc.replace(/^export /gm, "") +
    "\n" +
    dataSrc.replace(/^import .*$/gm, "").replace(/^export /gm, "") +
    "\n({ data, loadTasks, loadReports })";
  const m = runInNewContext(source, { fetch, document, JSON, Promise, setTimeout, Error, Array, Number });
  return { m, sessionCalls: () => sessionCalls, sessions };
}

test("tasks and reports loading together share one session: the unread report is there at once", async () => {
  const s = await shell();
  await Promise.all([s.m.loadTasks(), s.m.loadReports()]);
  assert.equal(s.m.data.reports.length, 1, "the report reaches the ticker data on the first load");
  assert.equal(s.m.data.reports[0].title, "Nachtbericht");
  assert.equal(s.sessionCalls(), 1, "one session request for both lists");
});

test("a replaced session (daemon restart, other module) is renewed once instead of dropping the list", async () => {
  const s = await shell();
  await s.m.loadReports();
  s.sessions.clear(); // daemon restart: every browser grant is gone
  s.m.data.reports = [];
  await s.m.loadReports();
  assert.equal(s.m.data.reports.length, 1);
});
