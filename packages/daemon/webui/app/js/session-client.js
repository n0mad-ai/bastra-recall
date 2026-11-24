// One pending sign-in per cookie and CSRF space. The shell and Tasks area
// share a task cookie, while settings has its own endpoint and cookie.
export function jsonRequest(path, body, headers) {
  return fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
}

function sessionClient(path) {
  let current = null;
  let pending = null;

  async function open() {
    const response = await jsonRequest(path, {});
    const grant = { response };
    try {
      grant.body = await response.json();
    } catch (error) {
      grant.jsonError = error;
    }
    if (response.ok && typeof grant.body?.csrf === "string" && grant.body.csrf) current = grant;
    return grant;
  }

  function get() {
    if (current) return current;
    pending ??= open().finally(() => {
      pending = null;
    });
    return pending;
  }

  function invalidate(grant) {
    if (current === grant) current = null;
  }

  function renew(grant) {
    // A delayed rejection for the old grant must not invalidate a newer one.
    invalidate(grant);
    // get() shares the active sign-in and lets later calls retry after it fails.
    return get();
  }

  async function run(readCsrf, request, retry = true) {
    const send = (grant, canRetry) =>
      request(readCsrf(grant), {
        invalidate: () => invalidate(grant),
        renew: canRetry ? async () => send(await renew(grant), false) : null,
      });
    return send(await get(), retry);
  }

  return { run, current: () => current, invalidate };
}

export const taskSession = sessionClient("/ui/tasks/session");
export const settingsSession = sessionClient("/ui/settings/session");

export function taskRequest(name, input, csrf) {
  return jsonRequest(`/ui/tasks/api/task_${name}`, input, { "x-bastra-task-csrf": csrf });
}
