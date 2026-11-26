// Settings › "Account and devices" (#1198): the account, remote access, the active sessions and the
// sign-in locks of this computer. Local only: the daemon answers /ui/settings/devices* nowhere else.
// Requests go through the settings session like every other settings call (settings-model.js); the
// global fetch adds the sign-in CSRF header (auth-client.js).
import { addStrings, t } from "../i18n.js";
import { h, clear } from "../dom.js";
import { loadingInline } from "./loading.js";
import { settingsApi } from "./settings-model.js";
import en from "../i18n/devices-en.js";
import de from "../i18n/devices-de.js";

addStrings(en, de);

const BASE = "/ui/settings/devices";
const UA_MAX = 60;

const view = { data: null, error: "", busy: false };
let host = null;

const when = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : "—");
const short = (text) => (text.length > UA_MAX ? `${text.slice(0, UA_MAX - 1)}…` : text);

async function call(action, body) {
  view.busy = true;
  view.error = "";
  draw();
  try {
    const answer = await settingsApi(action ? `${BASE}/${action}` : BASE, action ? (body ?? {}) : undefined);
    if (!answer || !Array.isArray(answer.sessions) || !Array.isArray(answer.locks)) throw new Error("invalid answer");
    view.data = answer;
  } catch (err) {
    view.error = err instanceof Error ? err.message : String(err);
  }
  view.busy = false;
  draw();
}

const note = (text, key) => h("div.st-row__env", { text, ...(key ? { "data-k": key } : {}) });

function row(name, detail, ...controls) {
  return h(
    "div.st-row.st-row--client",
    null,
    h(
      "div.st-row__main",
      null,
      h("div.st-row__head", null, h("span.st-row__name", { text: name })),
      detail ? h("div.st-row__key", { text: detail }) : null
    ),
    h("div.st-row__ctl", null, controls)
  );
}

function button(key, text, action, body) {
  return h("button.st-btn", {
    type: "button",
    text,
    disabled: view.busy,
    "data-act": key,
    on: { click: () => void call(action, body) },
  });
}

function sessionRow(s) {
  const kind = t(s.kind === "device" ? "dev.kind.device" : "dev.kind.browser");
  const origin = t(s.origin === "public" ? "dev.origin.public" : "dev.origin.local");
  const name = s.label || (s.userAgent ? short(s.userAgent) : t("dev.unnamed"));
  const el = row(
    s.current ? `${name} · ${t("dev.current")}` : name,
    `${kind} · ${origin} · ${t("dev.lastSeen", { at: when(s.lastSeenAt) })} · ${t("dev.expires", { at: when(s.expiresAt) })}`,
    // The own session ends through the account menu (sign out), not from this list.
    s.current ? null : button("revoke", t("dev.revoke"), "revoke", { id: s.id })
  );
  if (s.current) el.classList.add("is-current");
  return el;
}

function lockRow(l) {
  let who;
  if (l.scope === "account") who = t("dev.lock.account");
  else if (l.source === "local") who = t("dev.lock.local");
  else if (l.source === "unknown-public") who = t("dev.lock.unknown");
  else who = t("dev.lock.source", { src: l.source ?? "?" });
  const state = l.lockedUntil > 0 ? t("dev.lock.until", { at: when(l.lockedUntil) }) : t("dev.lock.open");
  return row(who, `${state} · ${t("dev.lock.failures", { n: l.failures })}`);
}

function body(d) {
  const nodes = [];
  if (d.account === "none") {
    nodes.push(
      h(
        "div.st-row",
        null,
        h(
          "div.st-row__main",
          null,
          h("div.st-row__head", null, h("span.st-row__name", { text: t("dev.noAccount") })),
          h("p.st-row__desc", { text: t("dev.noAccount.d") })
        ),
        h("div.st-row__ctl", null, h("a.st-btn.st-btn--go", { href: "/ui/login", text: t("dev.createAccount") }))
      )
    );
  } else if (d.account === "present") {
    nodes.push(row(t("dev.account"), String(d.username ?? "")));
  } else {
    nodes.push(note(t(d.account === "damaged" ? "dev.damaged" : "dev.unavailable")));
  }
  nodes.push(
    row(
      t("dev.remote"),
      d.publicOrigin ? t("dev.remote.on", { url: d.publicOrigin }) : t("dev.remote.off"),
      d.publicOrigin ? button("remote-off", t("dev.remote.disable"), "remote-off") : null
    ),
    note(t("dev.remote.hint"))
  );
  if (d.account !== "present") return nodes;
  const others = d.sessions.filter((s) => !s.current);
  nodes.push(
    row(
      t("dev.sessions"),
      t("dev.sessions.n", { n: d.sessions.length }),
      others.length ? button("revoke-others", t("dev.revokeOthers"), "revoke-others") : null,
      d.sessions.some((s) => s.origin === "public")
        ? button("revoke-public", t("dev.revokePublic"), "revoke-public")
        : null
    ),
    ...d.sessions.map(sessionRow)
  );
  nodes.push(
    row(
      t("dev.locks"),
      d.locks.length ? t("dev.locks.n", { n: d.locks.length }) : t("dev.locks.none"),
      d.locks.length ? button("unlock", t("dev.unlock"), "unlock") : null
    ),
    ...d.locks.map(lockRow)
  );
  return nodes;
}

function draw() {
  if (!host) return;
  clear(host);
  if (view.error) {
    host.append(
      h(
        "div.st-state.is-err",
        null,
        h("span", { text: t("dev.err", { err: view.error }) }),
        h("button.st-btn", { type: "button", text: t("st.retry"), on: { click: () => void call() } })
      )
    );
  }
  if (view.data) host.append(...body(view.data));
  else if (!view.error) host.append(h("div.st-state", null, loadingInline(t("dev.loading"))));
}

/** The rows of the section; rebuilt with the settings page, so every build loads a fresh list. */
export function devicesBody() {
  host = h("div.st-dev");
  draw();
  void call();
  return host;
}
