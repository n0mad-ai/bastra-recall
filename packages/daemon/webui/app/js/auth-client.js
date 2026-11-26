// Account state and the two rules every /ui request shares (#1198):
//  - a write carries the CSRF value of the signed-in session as X-Bastra-CSRF;
//  - 401 { error: "auth-required" } sends the page to the sign-in once, 403 { error: "csrf" } reloads the
//    state and repeats the request once.
// Installed over fetch when this module loads, so no call site has to know about it.
const STATE_URL = "/ui/auth/state";
// The sign-in routes themselves have no session yet, and a 401 there means "wrong password".
const OUTSIDE = new Set([STATE_URL, "/ui/auth/login", "/ui/auth/setup", "/ui/login"]);
const READS = new Set(["GET", "HEAD"]);

let rawFetch = null;
let stateRequest = null;
let leaving = false;

async function loadState() {
  try {
    const r = await rawFetch(STATE_URL, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return null;
    const body = await r.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** GET /ui/auth/state, shared by every caller; null when the server did not answer sensibly. */
export function authState() {
  stateRequest ??= loadState();
  return stateRequest;
}

export function refreshAuthState() {
  stateRequest = loadState();
  return stateRequest;
}

/** The current page as a sign-in return address; only /ui/ pages qualify, anything else returns to /ui/. */
function returnPath(loc) {
  const here = `${loc.pathname}${loc.search}${loc.hash}`;
  return here.startsWith("/ui/") ? here : "/ui/";
}

function toLogin(loc) {
  if (leaving) return;
  leaving = true;
  loc.assign(`/ui/login?next=${encodeURIComponent(returnPath(loc))}`);
}

async function errorCode(response) {
  try {
    const body = await response.clone().json();
    return typeof body?.error === "string" ? body.error : "";
  } catch {
    return "";
  }
}

export function installAuthFetch(target = globalThis) {
  rawFetch = target.fetch.bind(target);
  target.fetch = async function authFetch(input, init) {
    const path = typeof input === "string" ? input.split(/[?#]/)[0] : "";
    if (!path.startsWith("/ui/") || OUTSIDE.has(path)) return rawFetch(input, init);
    const write = !READS.has((init?.method ?? "GET").toUpperCase());
    const send = async (state) => {
      if (!write || typeof state?.csrf !== "string") return rawFetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set("X-Bastra-CSRF", state.csrf);
      return rawFetch(input, { ...init, headers });
    };
    let response = await send(write ? await authState() : null);
    const code = response.status === 401 || response.status === 403 ? await errorCode(response) : "";
    if (code === "auth-required") toLogin(target.location);
    else if (code === "csrf" && write) response = await send(await refreshAuthState());
    return response;
  };
}

installAuthFetch();
