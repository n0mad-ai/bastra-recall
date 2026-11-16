// Name row of the agent group: the ordinary text field plus the state of the local address the
// daemon derives from the saved name (http://<address>/). The UI does not derive the address itself;
// it shows the daemon's names, as text only.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { store, retryAddress } from "./settings-model.js";

/** http://<readable>/, plus the technical form when it differs (http://jürgen/ (http://xn--jrgen-kva/)). */
function addressText(name, readable) {
  const shown = readable || name;
  return shown === name ? `http://${name}/` : `http://${shown}/ (http://${name}/)`;
}

/** What the note says about the address of the saved name, or null while there is nothing to say. */
export function addressNote(saved, s) {
  if (!s || typeof saved !== "string" || !saved.trim()) return null;
  if (s.pending) return { text: t("st.addr.pending"), retry: false };
  const current = s.name ? addressText(s.name, s.readableName) : null;
  // The saved name derives no address: say so and which address (if any) still applies.
  if (!s.targetName)
    return { text: current ? t("st.addr.none", { url: current }) : t("st.addr.noneYet"), retry: false };
  return targetNote(s, addressText(s.targetName, s.targetReadableName));
}

function targetNote(s, url) {
  if (s.ready && s.name === s.targetName && s.registeredName === s.targetName)
    return { text: t("st.addr.ready", { url }), retry: false };
  if (!s.systemSetupSupported)
    return s.name
      ? { text: t("st.addr.manual", { url: `http://${s.readableName || s.name}.localhost/` }), retry: false }
      : null;
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
