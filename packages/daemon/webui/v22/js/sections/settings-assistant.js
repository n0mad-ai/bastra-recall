// Name row of the agent group: the ordinary text field plus the state of the local address
// derived from the saved name (lower case: http://<name>/). Daemon text is shown as text only.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { store, retryAddress } from "./settings-model.js";

/** What the note says about the address of the saved name, or null while there is nothing to say. */
export function addressNote(saved, s) {
  if (!s || typeof s.name !== "string" || typeof saved !== "string" || !saved.trim()) return null;
  const name = saved.trim().toLowerCase(),
    url = `http://${name}/`;
  if (s.pending) return { text: t("st.addr.pending"), retry: false };
  if (s.ready && s.name === name && s.registeredName === name)
    return { text: t("st.addr.ready", { url }), retry: false };
  if (!s.systemSetupSupported)
    return { text: t("st.addr.manual", { url: `http://${s.name}.localhost/` }), retry: false };
  const reason = [s.warning, s.error].find((x) => typeof x === "string" && x) || "";
  return { text: `${t("st.addr.todo", { url })}${reason ? ` ${reason}` : ""}`, retry: true };
}

export function assistantNameCtl(e, ctl) {
  const text = h("span.st-addr__t", { "aria-live": "polite" });
  const retry = h("button.st-btn", { type: "button", text: t("st.addr.retry"), on: { click: () => retryAddress() } });
  const note = h("div.st-addr", null, text, retry);
  return {
    ...ctl,
    nodes: [...ctl.nodes, note],
    sync: () => {
      ctl.sync();
      const n = addressNote(e.value, store.address);
      note.hidden = !n;
      if (!n) return;
      text.textContent = n.text;
      retry.hidden = !n.retry;
      retry.disabled = store.busy;
    },
  };
}
