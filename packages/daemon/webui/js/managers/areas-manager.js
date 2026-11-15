/** Areas manager (#216) — create / rename / delete the vault's top-level
 *  areas from the map. Mutations run against POST /ui/areas (folder moves,
 *  delete = vault trash, never destructive); after ≥1 successful mutation the
 *  page reloads on close, because the graph is loaded exactly once at boot.
 *
 *  @param {object} deps
 *  @param {HTMLElement} deps.modal    the #areas-modal container
 *  @param {HTMLElement} deps.opener   the topbar button that opens it */

import { fetchAreas, postArea } from "../graph-data.js";

const $ = (sel) => document.querySelector(sel);

export function createAreasManager({ modal, opener }) {
  const listEl = $("#areas-list");
  const statusEl = $("#areas-status");
  const createNameEl = $("#areas-create-name");
  let busy = false;
  let mutated = false; // ≥1 successful mutation → reload on close
  let confirmDelete = null; // "kind:name" armed for the second delete click

  function setStatus(text, cls = "") {
    statusEl.textContent = text;
    statusEl.className = cls;
  }

  async function mutate(payload, okText) {
    if (busy) return false;
    busy = true;
    setStatus("working…");
    try {
      await postArea(payload);
      mutated = true;
      setStatus(okText, "ok");
      await render();
      return true;
    } catch (err) {
      setStatus(err.message, "err");
      return false;
    } finally {
      busy = false;
    }
  }

  function row(area) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = area.name;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = area.kind === "project" ? "project" : "folder";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${area.count}`;
    li.append(name, kind, count);
    if (area.reserved) {
      const lock = document.createElement("span");
      lock.className = "lock";
      lock.textContent = "system";
      li.append(lock);
      return li;
    }

    const rename = document.createElement("button");
    rename.className = "area-act";
    rename.textContent = "rename";
    rename.addEventListener("click", () => {
      // inline rename: swap the name span for an input, Enter commits, Esc cancels
      const input = document.createElement("input");
      input.type = "text";
      input.className = "area-rename";
      input.value = area.name;
      name.replaceWith(input);
      input.focus();
      input.select();
      const done = () => input.replaceWith(name);
      input.addEventListener("keydown", async (ev) => {
        if (ev.key === "Escape") return done();
        if (ev.key !== "Enter") return;
        const newName = input.value.trim();
        if (!newName || newName === area.name) return done();
        await mutate(
          { action: "rename", kind: area.kind, name: area.name, newName },
          `✓ renamed ${area.name} → ${newName}`
        );
      });
      input.addEventListener("blur", done);
    });

    const del = document.createElement("button");
    del.className = "area-act danger";
    del.textContent = "delete";
    del.addEventListener("click", async () => {
      const key = `${area.kind}:${area.name}`;
      if (confirmDelete !== key) {
        // two-click confirm — no blocking dialogs in the map
        confirmDelete = key;
        del.textContent = "sure? → trash";
        setStatus(`click again to move "${area.name}" into the vault trash`, "");
        return;
      }
      confirmDelete = null;
      await mutate({ action: "delete", kind: area.kind, name: area.name }, `✓ ${area.name} moved to trash`);
    });

    li.append(rename, del);
    return li;
  }

  async function render() {
    confirmDelete = null;
    let areas;
    try {
      areas = await fetchAreas();
    } catch (err) {
      setStatus(err.message, "err");
      return;
    }
    listEl.innerHTML = "";
    for (const a of areas) listEl.append(row(a));
  }

  $("#areas-create").addEventListener("click", async () => {
    const name = createNameEl.value.trim();
    if (!name) return;
    const ok = await mutate(
      { action: "create", name },
      `✓ created ${name} — it appears on the map with its first memory`
    );
    if (ok) createNameEl.value = "";
  });
  createNameEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") $("#areas-create").click();
  });

  function open() {
    modal.hidden = false;
    setStatus("");
    document.addEventListener("keydown", onKey);
    render();
  }

  function close() {
    modal.hidden = true;
    document.removeEventListener("keydown", onKey);
    // the graph is loaded once at boot — a reload is the established refresh
    if (mutated) location.reload();
  }

  function onKey(ev) {
    if (ev.key === "Escape" && !modal.querySelector(".area-rename")) close();
  }

  opener.addEventListener("click", open);
  $("#areas-close").addEventListener("click", close);
  modal.addEventListener("pointerdown", (ev) => {
    if (ev.target === modal) close();
  });

  return { open };
}
