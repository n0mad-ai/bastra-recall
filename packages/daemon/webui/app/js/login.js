// Sign-in and first-account page (login.html). Contract: HTTP-Vertrag der Anmeldung (#1198):
//   GET  /ui/auth/state   → { account: none | present | damaged, authenticated, setupAllowed, ... }
//   POST /ui/auth/login   { username, password, remember } → 200 | 401 | 409 | 429 | 503
//   POST /ui/auth/setup   { username, password }           → 200 | 400 | 403 | 409
// Needs no session, so it talks to fetch directly (no CSRF header, no 401 redirect).
import { h, clear } from "./dom.js";
import { t } from "./i18n.js";

const root = document.getElementById("login");

const unsafeChar = (c) => c === "\\" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127;

/** The page to return to after signing in: a relative /ui/ path or /ui/. */
function nextPath() {
  const raw = new URLSearchParams(location.search).get("next");
  const fallback = "/ui/";
  if (typeof raw !== "string" || !raw.startsWith("/ui/") || raw.includes("//") || [...raw].some(unsafeChar))
    return fallback;
  try {
    const url = new URL(raw, location.origin);
    const path = `${url.pathname}${url.search}${url.hash}`;
    const ok = url.origin === location.origin && url.pathname.startsWith("/ui/") && !path.includes("//");
    // never back to the sign-in page itself: an authenticated visitor would loop there
    return ok && url.pathname !== "/ui/login" && !url.pathname.startsWith("/ui/auth/") ? path : fallback;
  } catch {
    return fallback;
  }
}

async function post(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data: data && typeof data === "object" ? data : {} };
  } catch {
    return { status: 0, data: {} };
  }
}

function waitText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 90) return t("auth.wait.seconds", { n: Math.ceil(seconds) });
  if (seconds < 5400) return t("auth.wait.minutes", { n: Math.ceil(seconds / 60) });
  return t("auth.wait.hours", { n: Math.ceil(seconds / 3600) });
}

function field(id, label, props) {
  const input = h("input.dlg-in.auth__in", { id, name: id, required: true, ...props });
  return { input, row: h("div.auth__field", null, h("label.auth__label", { for: id, text: label }), input) };
}

/** The card: kicker and title on top, children, and one live region for messages. */
function card(title, ...children) {
  const status = h("p.dlg__status.auth__status", { role: "status", "aria-live": "polite" });
  const say = (text, kind = "err") => {
    status.className = `dlg__status auth__status${text ? " is-" + kind : ""}`;
    status.textContent = text;
  };
  clear(root).append(
    h(
      "div.dlg__box.auth__box",
      null,
      h(
        "div.dlg__head",
        null,
        h("div.dlg__hl", null, h("span.dlg__kicker", { text: t("auth.kicker") }), h("h1.dlg__title", { text: title }))
      ),
      h("div.dlg__body", null, ...children, status)
    )
  );
  return say;
}

function submitButton(text) {
  return h("button.dlg-btn.is-primary.auth__submit", { type: "submit", text });
}

/** Runs one request with the button locked; `handle` turns the answer into a message or a redirect. */
function guarded(button, say, request, handle) {
  return async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = t("auth.working");
    say("");
    const outcome = handle(await request());
    if (outcome === "left") return;
    if (outcome) say(outcome);
    button.disabled = false;
    button.textContent = label;
  };
}

function loginMessage({ status, data }) {
  if (status === 401) return t("auth.err.invalid");
  if (status === 429) {
    const time = waitText(data.retryAfterSeconds);
    const busy = data.error === "busy";
    if (!time) return t(busy ? "auth.err.busyNow" : "auth.err.lockedNow");
    return t(busy ? "auth.err.busy" : "auth.err.locked", { time });
  }
  if (status === 503) return t("auth.err.damaged");
  if (status === 0) return t("auth.err.network");
  return t("auth.err.generic");
}

function showLogin(notice = "") {
  const user = field("username", t("auth.username"), {
    type: "text",
    autocomplete: "username",
    autocapitalize: "none",
    spellcheck: "false",
  });
  const pass = field("password", t("auth.password"), { type: "password", autocomplete: "current-password" });
  const remember = h("input", { id: "remember", name: "remember", type: "checkbox", cls: "auth__check" });
  const submit = submitButton(t("auth.submit"));
  const form = h(
    "form.auth__form",
    { novalidate: true },
    user.row,
    pass.row,
    h("div.auth__remember", null, remember, h("label", { for: "remember", text: t("auth.remember") })),
    submit
  );
  const say = card(t("auth.title"), form);
  if (notice) say(notice);
  form.addEventListener(
    "submit",
    guarded(
      submit,
      say,
      () =>
        post("/ui/auth/login", { username: user.input.value, password: pass.input.value, remember: remember.checked }),
      (answer) => {
        if (answer.status === 200) {
          location.replace(nextPath());
          return "left";
        }
        if (answer.status === 409) {
          start();
          return "left";
        }
        return loginMessage(answer);
      }
    )
  );
  user.input.focus();
}

function setupMessage({ status, data }) {
  if (status === 400 && data.error === "invalid-password") {
    const known = ["too-short", "too-long", "not-text"].includes(data.problem);
    return t(known ? `auth.pw.${data.problem}` : "auth.pw.invalid");
  }
  if (status === 400) return t("auth.setup.badUsername");
  if (status === 0) return t("auth.err.network");
  return t("auth.err.generic");
}

function showSetup() {
  const user = field("username", t("auth.username"), {
    type: "text",
    autocomplete: "username",
    autocapitalize: "none",
    spellcheck: "false",
  });
  const pass = field("password", t("auth.password"), { type: "password", autocomplete: "new-password" });
  const again = field("password2", t("auth.setup.repeat"), { type: "password", autocomplete: "new-password" });
  const submit = submitButton(t("auth.setup.submit"));
  const form = h(
    "form.auth__form",
    { novalidate: true },
    user.row,
    pass.row,
    again.row,
    h("p.dlg__hint", { text: t("auth.setup.hint") }),
    submit
  );
  const say = card(t("auth.setup.title"), h("p.dlg__text", { text: t("auth.setup.text") }), form);
  form.addEventListener(
    "submit",
    guarded(
      submit,
      say,
      async () =>
        pass.input.value === again.input.value
          ? post("/ui/auth/setup", { username: user.input.value, password: pass.input.value })
          : { mismatch: true },
      (answer) => {
        if (answer.mismatch) return t("auth.setup.mismatch");
        if (answer.status === 200) {
          location.replace(nextPath());
          return "left";
        }
        if (answer.status === 409) {
          start(t("auth.setup.exists"));
          return "left";
        }
        return setupMessage(answer);
      }
    )
  );
  user.input.focus();
}

function showNotice(title, text, retry) {
  const children = [h("p.dlg__text", { role: "alert", text })];
  if (retry)
    children.push(
      h("button.dlg-btn.auth__submit", { type: "button", text: t("auth.retry"), on: { click: () => start() } })
    );
  card(title, ...children);
}

async function start(notice = "") {
  document.title = "Recall";
  let state = null;
  try {
    const r = await fetch("/ui/auth/state", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) state = await r.json();
  } catch {
    /* shown as "not reachable" below */
  }
  if (!state || typeof state !== "object") return showNotice(t("auth.title"), t("auth.err.network"), true);
  if (state.authenticated === true) return location.replace(nextPath());
  if (state.account === "damaged") return showNotice(t("auth.title"), t("auth.err.damaged"), false);
  if (state.account === "none")
    return state.setupAllowed === true
      ? showSetup()
      : showNotice(t("auth.setup.remoteTitle"), t("auth.setup.remoteText"), false);
  showLogin(notice);
}

clear(root).append(h("p.dlg__status.auth__loading", { text: t("auth.loading") }));
start();
