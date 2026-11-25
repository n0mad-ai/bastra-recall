// Actions on an unwritten memory (graph kind "ghost") in the vault cards:
//   write — queue it on the care list (vault-care.md, POST /ui/annotate kind
//           "write"); an assistant writes the missing note later
//   skill — the link names an assistant skill, not a missing note
//           (POST /ui/skills, as `bastra skills add`); the graph is reloaded
//           so the node leaves the unwritten ones
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { loadGraph } from "../data.js";

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!r?.ok) throw new Error(`${url} → ${r?.status ?? 0}`);
}

/** Whether the care list already holds an open "write" flag for this id. */
async function queued(id) {
  try {
    const r = await fetch("/ui/annotations", { credentials: "same-origin" });
    const b = r.ok ? await r.json() : null;
    const list = Array.isArray(b?.annotations) ? b.annotations : [];
    return list.some((a) => a && a.id === id && a.kind === "write" && !a.done);
  } catch {
    return false;
  }
}

/**
 * The ghost card's action row plus its status line. `button(cls, key, click)`
 * builds a card action button (chrome.js actionButton).
 */
export function ghostActions(m, button) {
  const status = h("p.vcard__gnote", { hidden: true, role: "status" });
  const done = (b, key) => {
    b.textContent = t(key);
    b.disabled = true;
    b.classList.add("is-done");
  };
  const run = (url, body, okKey, after) => async (e) => {
    const b = e.currentTarget;
    if (b.disabled) return;
    b.disabled = true;
    status.hidden = true;
    try {
      await post(url, body);
      done(b, okKey);
      after?.();
    } catch {
      b.disabled = false;
      status.textContent = t("vv.ghost.fail");
      status.hidden = false;
    }
  };
  const write = button(
    "vcard__gw",
    "vv.ghost.write",
    run("/ui/annotate", { id: m.id, kind: "write", note: "" }, "vv.ghost.queued")
  );
  const skill = button("vcard__gs", "vv.ghost.skill", run("/ui/skills", { id: m.id }, "vv.ghost.skilled", loadGraph));
  write.title = t("vv.ghost.writeT");
  skill.title = t("vv.ghost.skillT");
  queued(m.id).then((q) => {
    if (q && !write.disabled) done(write, "vv.ghost.queued");
  });
  return [status, h("div.vcard__acts.is-ghost", null, write, skill)];
}
