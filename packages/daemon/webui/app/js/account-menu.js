// Account entry in the header (#1198): signed-in name with sign-out, sign-out everywhere and password change,
// or — while no account exists and setup is allowed here — a quiet "create account" link.
// Everything is shown only when GET /ui/auth/state says so; writes get their CSRF header from js/auth-client.js.
import { h, clear } from "./dom.js";
import { t } from "./i18n.js";
import { authState, refreshAuthState } from "./auth-client.js";
import { dialog, btn, status, setStatus } from "./sections/dialogs.js";

async function post(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data: data && typeof data === "object" ? data : {} };
  } catch {
    return { status: 0, data: {} };
  }
}

function passwordMessage({ status: code, data }) {
  if (code === 401) return t("auth.pwchange.wrong");
  if (code === 400 && data.error === "invalid-password")
    return t(
      ["too-short", "too-long", "not-text"].includes(data.problem) ? `auth.pw.${data.problem}` : "auth.pw.invalid"
    );
  return code === 0 ? t("auth.err.network") : t("auth.err.generic");
}

function passwordForm(st, back) {
  const input = (id, label, autocomplete) => {
    const el = h("input.dlg-in", { id: `acct-${id}`, type: "password", autocomplete, required: true });
    return { el, row: h("div.acct__field", null, h("label", { for: `acct-${id}`, text: label }), el) };
  };
  const current = input("current", t("auth.pwchange.current"), "current-password");
  const next = input("next", t("auth.pwchange.next"), "new-password");
  const again = input("again", t("auth.pwchange.repeat"), "new-password");
  const submit = h("button.dlg-btn.is-primary", { type: "submit", text: t("auth.pwchange.submit") });
  const form = h(
    "form.acct__form",
    { novalidate: true },
    current.row,
    next.row,
    again.row,
    h("p.dlg__hint", { text: t("auth.setup.hint") }),
    h("div.dlg__foot", null, btn(t("auth.pwchange.cancel"), back), submit)
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    if (next.el.value !== again.el.value) return setStatus(st, t("auth.setup.mismatch"), "err");
    submit.disabled = true;
    setStatus(st, t("auth.working"), "busy");
    const answer = await post("/ui/auth/password", { current: current.el.value, next: next.el.value });
    submit.disabled = false;
    if (answer.status !== 200) return setStatus(st, passwordMessage(answer), "err");
    await refreshAuthState(); // the change started a new session: new CSRF value
    for (const f of [current, next, again]) f.el.value = "";
    setStatus(st, t("auth.pwchange.done"), "ok");
  });
  return form;
}

function openAccount(state) {
  const st = status();
  const { body, close } = dialog({ kicker: t("auth.menu.kicker"), title: t("auth.menu.title") });
  const leave = async (path) => {
    const answer = await post(path);
    if (answer.status === 200) location.assign("/ui/login");
    else setStatus(st, answer.status === 0 ? t("auth.err.network") : t("auth.err.generic"), "err");
  };
  function overview() {
    clear(body).append(
      h("p.dlg__text", { text: t("auth.menu.signedInAs", { name: state.username ?? "" }) }),
      h(
        "div.dlg__row",
        null,
        btn(t("auth.menu.password"), () => {
          setStatus(st, "");
          clear(body).append(passwordForm(st, overview), st);
        }),
        btn(t("auth.menu.logout"), () => leave("/ui/auth/logout"), "is-primary")
      ),
      h(
        "div.dlg__row",
        null,
        btn(t("auth.menu.logoutAll"), () => leave("/ui/auth/logout-all"), "is-danger")
      ),
      h("p.dlg__hint", { text: t("auth.menu.logoutAllHint") }),
      st
    );
  }
  overview();
  return close;
}

/** The header slot; stays empty until the state says there is something to show. */
export function mountAccount() {
  const slot = h("span.acct");
  authState().then((state) => {
    if (!state) return;
    if (state.authenticated === true) {
      slot.append(
        h("button.acct__btn", {
          type: "button",
          "aria-haspopup": "dialog",
          title: t("auth.menu.open"),
          text: typeof state.username === "string" ? state.username : t("auth.menu.open"),
          on: { click: () => openAccount(state) },
        })
      );
    } else if (state.account === "none" && state.setupAllowed === true) {
      slot.append(
        h("a.acct__btn.acct__btn--quiet", {
          href: "/ui/login",
          title: t("auth.menu.setupTitle"),
          text: t("auth.menu.setup"),
        })
      );
    }
  });
  return slot;
}
