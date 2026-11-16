// Tasks area — right panel tabs (prototype tabTaskDetail / tabViewTask /
// tabTaskControl) and the status figures of the head. Every action of the
// old UI (webui/js/tasks.js) is reachable here: release, pause/resume, end
// series, snooze, done, cancel, back to review, edit text, validity,
// prepare + execute, acknowledge, reconcile, rollback, archives, controls —
// plus delete (task_delete), which the old board did not offer.
import { h, s } from "../dom.js";
import { t } from "../i18n.js";
import {
  S,
  emit,
  say,
  act,
  refresh,
  lifecycle,
  moveTo,
  review,
  controls,
  showProposal,
  loadArchive,
  byId,
  save,
  assign,
  openSource,
  liveTasks,
} from "./tasks-store.js";
import { vault } from "../views/vault-data.js";
import { calendarStyle, calendarStyles, PRO_STYLES } from "./tasks-styles.js";
import {
  api,
  mutate,
  fmtAt,
  localParts,
  calendarSchedule,
  failureReason,
  originLabel,
  canMove,
  isTerminal,
  dueAt,
  boardForm,
  boardPatch,
  holderOf,
  waitsView,
} from "./tasks-api.js";
import { toggle } from "./tasks-overlays.js";
import { loadingInline } from "./loading.js";

export const dueList = () => S.items.filter((x) => x.k === "due" && !x.t.archived);
export const awaitList = () => S.items.filter((x) => !x.t.archived && !isTerminal(x.t) && !x.t.armed);

/** Head pills: Funktion, Automatik, Fällig, Freigabe offen, Ausführung (real values from task_status). */
export function statusTiles() {
  const c = S.snap?.controls || {},
    rt = S.snap?.runtime || {},
    dN = dueList().length,
    aN = awaitList().length,
    line = "var(--line-45)";
  const on = !!c.enabled;
  return [
    {
      k: t("tk.st.fn"),
      v: on ? t("tk.on") : t("tk.off"),
      sub: c.muted ? t("tk.muted") : t("tk.audible"),
      color: on ? "var(--accent)" : "var(--muted)",
      tick: on ? "var(--accent)" : line,
    },
    {
      k: t("tk.st.auto"),
      v: !on ? t("tk.off") : rt.running ? t("tk.running") : t("tk.inactive"),
      sub: on && rt.next_tick ? t("tk.st.next", { at: fmtAt(rt.next_tick) }) : t("tk.st.noCheck"),
      tick: line,
    },
    {
      k: t("tk.st.due"),
      v: dN,
      sub: t("tk.st.dueSub"),
      color: dN ? "var(--amber)" : null,
      tick: dN ? "var(--amber)" : line,
    },
    {
      k: t("tk.st.await"),
      v: aN,
      sub: t("tk.st.awaitSub"),
      color: aN ? "var(--accent)" : null,
      tick: aN ? "var(--accent)" : line,
    },
    {
      k: t("tk.st.exec"),
      v: c.execution_stopped ? t("tk.stopped") : t("tk.active"),
      sub: c.execution_stopped ? t("tk.st.safe") : t("tk.st.execOn"),
      tick: line,
    },
  ];
}

const verification = (task) => {
  const v = task.verification;
  if (!v) return task.schedule?.kind === "event" ? t("tk.ver.waiting") : t("tk.ver.none");
  const reason = t(`tk.ver.r.${v.reason}`);
  return `${t(`tk.ver.o.${v.outcome}`)}${v.reason && reason !== `tk.ver.r.${v.reason}` ? ` (${reason})` : ""}, ${t("tk.ver.checked", { at: fmtAt(v.checked_at, task.timezone) })}`;
};
const reviewReason = (v) =>
  v === "Explicit owner review required"
    ? t("tk.review.explicit")
    : v === "Edited binding requires explicit owner review"
      ? t("tk.review.edited")
      : v;
function authorizationOf(task) {
  const snap = S.snap || {};
  if (task.authorization) return task.authorization;
  const rows = (snap.authorizations || []).filter((a) => a.task_id === task.id),
    row = rows.at(-1);
  if (row?.authorization) return { ...row.authorization, decision: row.decision, revoked_at: row.revoked_at };
  return (snap.proposals || []).filter((p) => p.task_id === task.id && p.authorization).at(-1)?.authorization;
}
const authLabel = (a) =>
  a.revoked_at !== undefined ? t("tk.auth.revoked") : a.decision === "deny" ? t("tk.auth.denied") : t("tk.auth.ok");
const recurText = (r) => {
  if (!r) return "";
  const days = r.kind === "calendar" ? r.interval : r.interval / 86400000;
  const every =
    days === 1
      ? t("tk.rec.daily")
      : days === 7
        ? t("tk.rec.weekly")
        : days % 7 === 0
          ? t("tk.rec.weeks", { n: days / 7 })
          : t("tk.rec.days", { n: days });
  return r.count ? t("tk.rec.count", { every, n: r.count }) : every;
};

function btn(label, fn, { pri = false, off = false, danger = false } = {}) {
  return h("button.tk-btn", {
    cls: [pri ? "is-pri" : "", danger ? "is-danger" : ""].join(" "),
    text: label,
    disabled: off ? true : null,
    on: { click: off ? null : fn },
  });
}

/** Inline form under the actions (replaces the old UI's prompt() dialogs). */
function editForm(x) {
  const task = x.t,
    kind = S.edit?.kind,
    cancel = () => {
      S.edit = null;
      emit();
    };
  const row = (...kids) => h("div.tk-edit", null, ...kids, btn(t("tk.cancel"), cancel));
  if (kind === "goal") {
    // Text, area (scope.name) and the board fields in one form; only changed values are sent.
    const v = (S.edit.v ??= { goal: task.goal, area: task.scope?.name ?? "", ...boardForm(task, liveTasks()) });
    const inp = (key, ph) =>
      h("input.tk-in", {
        value: v[key],
        placeholder: ph || "",
        on: {
          input: (e) => {
            v[key] = e.target.value;
          },
        },
      });
    const seg = (opts, key) =>
      h(
        "div.tk-seg",
        null,
        opts.map(([o, lab]) =>
          h("button", {
            cls: v[key] === o ? "is-on" : "",
            text: lab,
            on: {
              click: () => {
                v[key] = o;
                emit();
              },
            },
          })
        )
      );
    const lab = (txt, el) => h("label.tk-f.is-wide", null, txt, el);
    return row(
      lab(t("tk.edit.goal"), inp("goal")),
      lab(t("tk.f.domain"), inp("area")),
      lab(
        t("tk.f.waits"),
        h("input.tk-in", {
          value: v.waits,
          placeholder: t("tk.f.waitsPh"),
          list: "tk-goals-e",
          on: {
            input: (e) => {
              v.waits = e.target.value;
            },
          },
        })
      ),
      h(
        "datalist",
        { id: "tk-goals-e" },
        liveTasks()
          .filter((o) => o.id !== task.id && !isTerminal(o))
          .map((o) => h("option", { value: o.goal }))
      ),
      h(
        "div.tk-f.is-wide",
        null,
        t("tk.f.assignee"),
        seg(
          [
            ["", t("tk.who.auto")],
            ["user", t("tk.who.user")],
            ["recall", t("tk.who.recall")],
          ],
          "assignee"
        )
      ),
      h(
        "div.tk-f.is-wide",
        null,
        t("tk.f.source"),
        seg(
          [
            ["", t("tk.src.none")],
            ["mail", `✉ ${t("tk.src.mail")}`],
            ["memory", `◆ ${t("tk.src.memory")}`],
          ],
          "srcKind"
        )
      ),
      v.srcKind
        ? lab(t("tk.f.srcRef"), inp("srcRef", v.srcKind === "mail" ? t("tk.f.srcRefMail") : t("tk.f.srcRefMem")))
        : null,
      lab(
        t("tk.f.note"),
        h("textarea.tk-in.tk-ta", {
          text: v.note,
          placeholder: t("tk.f.notePh"),
          on: {
            input: (e) => {
              v.note = e.target.value;
            },
          },
        })
      ),
      btn(
        t("tk.save"),
        () => {
          const goal = v.goal.trim(),
            area = v.area.trim();
          if (!goal) return say(t("tk.err.goal"), "error");
          let patch;
          try {
            patch = boardPatch(task, v, liveTasks());
          } catch (e) {
            return say(e.message, "error");
          }
          if (goal !== task.goal) patch.goal = goal;
          if (area && area !== task.scope?.name) patch.scope = { kind: task.scope?.kind || "personal", name: area };
          if (!Object.keys(patch).length) {
            S.edit = null;
            emit();
            return;
          }
          S.edit = null;
          act(async () => {
            await mutate(task.id, "edit", { patch });
            return t("tk.msg.updated");
          });
        },
        { pri: true }
      )
    );
  }
  if (kind === "expires") {
    const inp = h("input.tk-in", {
      value: task.expires_at === undefined ? "" : localParts(task.expires_at, task.timezone).slice(0, 16),
      placeholder: t("tk.f.whenLocalPh"),
    });
    return row(
      h("label.tk-f.is-wide", null, t("tk.edit.expires", { tz: task.timezone }), inp),
      btn(
        t("tk.save"),
        () => {
          let at = null;
          try {
            if (inp.value.trim()) at = calendarSchedule(inp.value.trim(), task.timezone).schedule.at;
          } catch (e) {
            return say(e.message, "error");
          }
          S.edit = null;
          act(async () => {
            await mutate(task.id, "edit", { patch: { expires_at: at } });
            return t("tk.msg.updated");
          });
        },
        { pri: true }
      )
    );
  }
  if (kind === "snooze") {
    const def = new Date(Date.now() + 864e5);
    def.setHours(9, 0, 0, 0);
    const inp = h("input.tk-in", {
      value: localParts(def.getTime(), task.timezone).slice(0, 16),
      placeholder: t("tk.f.whenLocalPh"),
    });
    return row(
      h("label.tk-f.is-wide", null, t("tk.edit.snooze", { tz: task.timezone }), inp),
      btn(
        t("tk.act.snooze"),
        () => {
          let at;
          try {
            at = calendarSchedule(inp.value.trim(), task.timezone).schedule.at;
          } catch (e) {
            return say(e.message, "error");
          }
          S.edit = null;
          act(async () => {
            await mutate(task.id, "snooze", { until: at });
            return t("tk.msg.snoozed", { at: fmtAt(at, task.timezone) });
          });
        },
        { pri: true }
      )
    );
  }
  if (kind === "prepare") {
    const adapters = S.snap?.adapters || [];
    const target = h("input.tk-in", {
      value: adapters[0]?.id || "",
      placeholder: t("tk.prep.target"),
      list: "tk-targets",
    });
    const payload = h("textarea.tk-in.tk-ta", { placeholder: t("tk.prep.payload") });
    return row(
      h(
        "datalist",
        { id: "tk-targets" },
        adapters.map((a) => h("option", { value: a.id }))
      ),
      h("label.tk-f.is-wide", null, t("tk.prep.target"), target),
      h("label.tk-f.is-wide", null, t("tk.prep.payload"), payload),
      btn(
        t("tk.act.prepare"),
        async () => {
          if (!target.value.trim()) return say(t("tk.err.validation"), "error");
          try {
            const cur = await api("get", { id: task.id });
            S.edit = null;
            await showProposal(
              await api("prepare", {
                id: task.id,
                expected_revision: cur.expected_revision,
                target_id: target.value.trim(),
                payload: payload.value,
              })
            );
            refresh();
          } catch (e) {
            say(e.message, "error");
          }
        },
        { pri: true }
      )
    );
  }
  return null;
}

/** Source fact: ✉ mail (reference only — mail is Pro) or ◆ memory, a link into the memory browser when the vault knows it. */
function sourceView(x) {
  const src = x.t.source,
    mem = src.kind === "memory",
    node = mem ? vault()?.byId.get(src.ref) : null;
  const text = `${mem ? "◆" : "✉"} ${mem ? t("tk.src.memory") : t("tk.src.mail")} · ${node?.title || src.ref}`;
  return node
    ? h("button.tk-dt__link", {
        text,
        title: src.ref,
        on: { click: (e) => openSource(x, e.currentTarget.getBoundingClientRect()) },
      })
    : text;
}

function detail(x) {
  const task = x.t,
    term = isTerminal(task),
    fail = failureReason(task, S.snap || {}),
    awaiting = !term && !task.armed && !task.archived;
  const facts = [[t("tk.fact.status"), task.paused ? t("tk.paused") : t(`tk.state.${task.state}`)]];
  if (task.expires_at !== undefined)
    facts.push([t("tk.fact.valid"), `${fmtAt(task.expires_at, task.timezone)} (${task.timezone})`]);
  facts.push(
    [t("tk.fact.due"), x.at ? `${fmtAt(dueAt(task), task.timezone)} (${task.timezone})` : t("tk.onEvent")],
    [t("tk.fact.origin"), originLabel(task)],
    [t("tk.fact.request"), task.original_request],
    [t("tk.fact.level"), t(`tk.lvl.${task.action_level}`)],
    [t("tk.fact.next"), fmtAt(task.next_check_at, task.timezone)],
    [t("tk.fact.last"), fmtAt((task.deliveries || []).at(-1)?.last_attempt, task.timezone)]
  );
  if (task.scope?.name) facts.push([t("tk.fact.area"), task.scope.name]);
  const hold = holderOf(task, x.k);
  facts.push([
    t("tk.fact.holder"),
    `${hold.who === "user" ? t("tk.who.user") : t("tk.who.recall")}${hold.set ? "" : ` · ${t("tk.who.derived")}`}`,
    hold.who === "user" ? "is-acc" : "",
  ]);
  const waits = waitsView(task, liveTasks());
  if (waits.length)
    facts.push([
      t("tk.fact.waits"),
      `⧗ ${waits.map((w) => w.text + (w.done ? " ✓" : "")).join(" · ")}`,
      waits.some((w) => !w.done) ? "is-amb" : "",
    ]);
  if (task.source) facts.push([t("tk.fact.source"), sourceView(x)]);
  if (task.agent_note) facts.push([t("tk.fact.note"), task.agent_note]);
  if (task.recurrence) facts.push([t("tk.fact.recur"), recurText(task.recurrence)]);
  const auth = authorizationOf(task);
  if (auth)
    facts.push([
      t("tk.fact.chat"),
      `${authLabel(auth)} · ${auth.program ?? ""} · ${t("tk.session")} ${auth.session_id ?? ""} · ${fmtAt(auth.at)} · ${auth.write_origin ?? ""}: ${auth.user_request ?? ""}`,
    ]);
  if ((task.deliveries || []).at(-1)?.acknowledged)
    facts.push([t("tk.fact.seen"), term ? t("tk.seenThen") : t("tk.seenOpen")]);
  if (awaiting) facts.push([t("tk.fact.release"), t("tk.awaiting"), "is-acc"]);
  if (fail) facts.push([t("tk.fact.reason"), fail, "is-amb"]);

  const acts = [];
  if (!task.archived) {
    if (term) acts.push(btn(t("tk.act.rearm"), () => lifecycle(x, "rearm")));
    else {
      acts.push(
        btn(task.paused ? t("tk.act.resume") : t("tk.act.pause"), () => lifecycle(x, task.paused ? "resume" : "pause"))
      );
      if (task.recurrence) acts.push(btn(t("tk.act.endSeries"), () => lifecycle(x, "end_series")));
      acts.push(btn(t("tk.act.snooze"), () => moveTo(x, "snoozed")));
      if (canMove(task, "done")) acts.push(btn(t("tk.act.done"), () => moveTo(x, "done")));
      acts.push(btn(t("tk.act.cancel"), () => moveTo(x, "failed")));
      const holder = holderOf(task, x.k).who;
      acts.push(
        holder === "user"
          ? btn(t("tk.act.toRecall"), () => assign(x, "recall"))
          : btn(t("tk.act.take"), () => assign(x, "user"))
      );
      acts.push(
        btn(t("tk.act.edit"), () => {
          S.edit = { id: x.id, kind: "goal" };
          emit();
        })
      );
      acts.push(
        btn(t("tk.act.validity"), () => {
          S.edit = { id: x.id, kind: "expires" };
          emit();
        })
      );
      if (task.action_level !== "notify")
        acts.push(
          btn(
            t("tk.act.prepare"),
            () => {
              S.edit = { id: x.id, kind: "prepare" };
              emit();
            },
            { off: !task.armed }
          )
        );
    }
  }
  acts.push(
    btn(
      t("tk.act.delete"),
      () =>
        act(async () => {
          const cur = task.archived ? task : await api("get", { id: task.id });
          await api("delete", {
            id: task.id,
            expected_revision: cur.expected_revision,
            ...(task.archived && task.archive_id ? { archive_id: task.archive_id } : {}),
          });
          if (task.archived) S.cold = S.cold.filter((c) => c.id !== task.id);
          S.sel = null;
          return t("tk.msg.deleted");
        }),
      { danger: true }
    )
  );

  const tech = [];
  if (task.origin)
    tech.push(
      t("tk.tech.origin", { client: task.origin.client, session: task.origin.session, context: task.origin.context })
    );
  if (task.budget)
    tech.push(
      t("tk.tech.budget", {
        poll: task.budget.poll_interval_ms / 1000,
        timeout: task.budget.timeout_ms,
        bytes: task.budget.max_source_bytes,
      })
    );
  tech.push(t("tk.tech.verify", { v: verification(task) }));
  if (task.last_failure) tech.push(t("tk.tech.failure", { m: task.last_failure.message || task.last_failure.code }));
  if (task.review_reason) tech.push(reviewReason(task.review_reason));

  const stCls = task.state === "due" ? "is-amb" : term ? "is-mut" : "is-acc";
  return h(
    "div.tk-dt",
    null,
    h("span.tk-dt__k", {
      cls: stCls,
      text: `${t("tk.dt.kicker")} · ${(task.paused ? t("tk.paused") : t(`tk.state.${task.state}`)).toUpperCase()}`,
    }),
    h("h2.tk-dt__t", { text: task.goal }),
    awaiting
      ? h(
          "div.tk-dt__await",
          null,
          h("span", { text: t("tk.awaitingLong") }),
          btn(t("tk.act.arm"), () => review(x), { pri: true })
        )
      : null,
    h(
      "div.tk-dt__facts",
      null,
      facts.map(([k, v, c]) => [
        h("span.tk-dt__fk", { text: k }),
        typeof v === "string"
          ? h("span.tk-dt__fv", { cls: c || "", text: v })
          : h("span.tk-dt__fv", { cls: c || "" }, v),
      ])
    ),
    task.archived ? h("p.tk-dt__note", { text: t("tk.archivedNote") }) : null,
    !task.archived && task.action_level !== "notify" && !task.armed && !term
      ? h("p.tk-dt__note", { text: t("tk.prepNeedsArm") })
      : null,
    h("div.tk-dt__acts", null, acts),
    S.edit && S.edit.id === x.id ? editForm(x) : null,
    h(
      "button.tk-dt__tech",
      {
        on: {
          click: () => {
            S.tech = !S.tech;
            emit();
          },
        },
      },
      h("span", { text: t("tk.tech") }),
      h("span", { text: S.tech ? "▾" : "▸" })
    ),
    S.tech
      ? h(
          "div.tk-dt__techb",
          null,
          tech.map((l) => h("span", { text: l })),
          task.archived ? h("pre.tk-prop__pre", { text: JSON.stringify(task.history, null, 2) }) : null
        )
      : null
  );
}

export function detailTab(body) {
  const x = S.sel ? byId(S.sel) : null;
  body.append(
    h("div.tk-pn", null, x ? detail(x) : h("p.tk-pn__empty", { text: S.error && !S.snap ? S.error : t("tk.dt.none") }))
  );
}

export function viewTab(body) {
  const ICONS = { ledger: "M4 5h16v15H4ZM4 10h16M9 5v15M14 5v15", ...Object.fromEntries(PRO_STYLES) };
  const active = calendarStyle(S.style) ? S.style : "ledger";
  // Registered styles first (ledger + whatever a Pro build added), then the Pro styles not available here.
  const reg = calendarStyles(),
    ids = [...reg.map((x) => x.id), ...PRO_STYLES.map(([id]) => id).filter((id) => !calendarStyle(id))];
  const row = (id) => {
    const st = calendarStyle(id),
      avail = !!st,
      on = avail && active === id,
      pro = !st || st.pro;
    const name = st?.labelKey ? t(st.labelKey) : t(`tk.style.${id}`),
      desc = st?.descKey ? t(st.descKey) : t(`tk.style.${id}.d`);
    return h(
      "button.tk-style",
      {
        cls: [on ? "is-on" : "", avail ? "" : "is-locked"].join(" "),
        "data-lsel": on ? "1" : null,
        on: {
          click: () => {
            if (!avail) {
              say(t("tk.proHint"));
              return;
            }
            S.style = id;
            save();
            emit();
          },
        },
      },
      h(
        "span.tk-style__ic",
        null,
        s("svg", { viewBox: "0 0 24 24" }, s("path", { d: st?.icon || ICONS[id] || ICONS.ledger }))
      ),
      h(
        "span.tk-style__txt",
        null,
        h(
          "span.tk-style__n",
          null,
          h("span", { text: name }),
          pro ? h("span.tk-badge.is-pro", { text: t("tk.proSoon") }) : h("span.tk-badge", { text: t("tk.std") })
        ),
        h("span.tk-style__d", { text: desc })
      )
    );
  };
  body.append(
    h(
      "div.tk-pn",
      null,
      h(
        "div.tk-pn__h",
        null,
        h("span.tk-pn__t", { text: t("tk.view.title") }),
        h("span.tk-pn__tag", { text: t("tk.kicker") })
      ),
      h("p.tk-pn__p", { text: t("tk.view.text") }),
      h("div.tk-styles", null, ids.map(row))
    )
  );
}

export function controlTab(body) {
  const snap = S.snap;
  if (!snap) {
    body.append(
      h(
        "div.tk-pn",
        null,
        S.error ? h("p.tk-pn__empty", { text: S.error }) : h("p.tk-pn__empty", null, loadingInline(t("tk.loading")))
      )
    );
    return;
  }
  const c = snap.controls || {},
    rt = snap.runtime || {},
    b = snap.budgets,
    cap = snap.capacity || {};
  const rows = [
    [t("tk.ctl.fn"), t("tk.ctl.fnD"), !!c.enabled, () => controls({ enabled: !c.enabled })],
    [t("tk.ctl.audible"), t("tk.ctl.audibleD"), !c.muted, () => controls({ muted: !c.muted })],
    [
      t("tk.ctl.exec"),
      t("tk.ctl.execD"),
      !c.execution_stopped,
      () => controls({ execution_stopped: !c.execution_stopped }),
    ],
  ];
  const sec = (k, ...kids) => [h("div.tk-pn__sec", { text: k }), h("div.tk-pn__lines", null, ...kids)];
  const line = (txt, cls) => h("span", { cls: cls || "", text: txt });
  body.append(
    h(
      "div.tk-pn",
      null,
      h(
        "div.tk-pn__h",
        null,
        h("span.tk-pn__t", { text: t("tk.ctl.title") }),
        h("span.tk-pn__tag.is-mut", {
          text: `${t("tk.st.fn")} ${c.enabled ? t("tk.on") : t("tk.off")} · ${c.muted ? t("tk.muted") : t("tk.audible")}`,
        })
      ),
      h("p.tk-pn__p", {
        text: t("tk.ctl.status", {
          auto: !c.enabled ? t("tk.off") : rt.running ? t("tk.running") : t("tk.inactive"),
          next: c.enabled ? fmtAt(rt.next_tick || undefined) : t("tk.none2"),
          err: rt.last_error || t("tk.none3"),
          backoff: rt.backoff_ms || 0,
          exec: c.execution_stopped ? t("tk.ctl.execStopped") : t("tk.active"),
        }),
      }),
      h(
        "div.tk-ctl",
        null,
        rows.map(([n, d, on, fn]) =>
          h(
            "div.tk-ctl__r",
            null,
            h("span.tk-ctl__txt", null, h("span.tk-ctl__n", { text: n }), h("span.tk-ctl__d", { text: d })),
            toggle(on, fn, n)
          )
        )
      ),
      sec(
        t("tk.ctl.budgets"),
        b
          ? line(
              t("tk.ctl.budgetLine", {
                n: b.max_assessments_per_turn,
                s: b.source_turn_ms / 1000,
                poll: b.poll_ms / 1000,
              })
            )
          : null,
        b ? line(t("tk.ctl.memLine", { mib: b.snapshot_bytes / 1048576 })) : null,
        line(
          t("tk.ctl.capLine", {
            i: cap.intents ?? 0,
            il: cap.intent_limit ?? 0,
            r: cap.receipts ?? 0,
            rl: cap.receipt_limit ?? 0,
            rev: cap.review_required ?? 0,
          }),
          "is-mut"
        )
      ),
      (snap.intents || []).length || (snap.receipts || []).length
        ? sec(
            t("tk.ctl.effects"),
            (snap.intents || []).map((i) =>
              h(
                "div.tk-pn__row",
                null,
                line(
                  `${i.state === "unknown" ? t("tk.intent.unknown") : i.state === "pending" ? t("tk.intent.pending") : t("tk.intent.done")} · ${i.target_id ?? ""} · ${fmtAt(i.at)}`
                ),
                i.state === "pending" || i.temp_cleanup_pending
                  ? btn(t("tk.act.reconcile"), () =>
                      act(async () => {
                        const r = await api("intent_reconcile", { intent_id: i.id });
                        return r.state === "unknown" ? t("tk.msg.reconcileUnknown") : t("tk.msg.reconciled");
                      })
                    )
                  : null
              )
            ),
            (snap.receipts || []).map((r) =>
              h(
                "div.tk-pn__row",
                null,
                line(
                  `${t("tk.receipt")} ${String(r.id).slice(0, 12)} · ${r.outcome === "unknown" ? t("tk.intent.unknown") : r.outcome === "reconciled" ? t("tk.outcome.reconciled") : t("tk.outcome.succeeded")} · ${r.target_id ?? ""} · ${fmtAt(r.at)}`
                ),
                r.rollback_available
                  ? btn(t("tk.act.rollback"), async () => {
                      try {
                        await showProposal(await api("rollback_prepare", { receipt_id: r.id }));
                      } catch (e) {
                        say(e.message, "error");
                      }
                    })
                  : null
              )
            )
          )
        : null,
      sec(
        t("tk.ctl.sources"),
        line(t("tk.ctl.trust")),
        (snap.sources || []).map((x) =>
          line(
            t("tk.ctl.source", { id: x.id, on: x.enabled ? t("tk.on") : t("tk.off"), rev: x.revision }),
            x.enabled ? "" : "is-mut"
          )
        ),
        (snap.adapters || []).map((x) =>
          line(
            t("tk.ctl.adapter", { id: x.id, on: x.enabled ? t("tk.active") : t("tk.off"), a: x.adapter }),
            x.enabled ? "" : "is-mut"
          )
        ),
        (snap.proposals || []).map((p) =>
          btn(
            t("tk.ctl.proposal", {
              id: String(p.id).slice(0, 12),
              st: p.binding_current ? t(`tk.prop.st.${p.status}`) : t("tk.prop.st.outdated"),
            }),
            async () => {
              try {
                await showProposal(await api("proposal", { proposal_id: p.id }));
              } catch (e) {
                say(e.message, "error");
              }
            }
          )
        )
      ),
      (snap.archives || []).length
        ? sec(
            t("tk.ctl.archive"),
            (snap.archives || []).map((a) =>
              btn(t("tk.ctl.archiveBtn", { at: fmtAt(a.at), n: a.task_count }), () => loadArchive(a.id))
            ),
            S.cold.length
              ? btn(t("tk.ctl.archiveHide"), () => {
                  S.cold = [];
                  refresh();
                })
              : null
          )
        : null,
      h(
        "div.tk-pn__foot",
        null,
        btn(t("tk.refresh"), () => act(async () => t("tk.msg.refreshed", { at: new Date().toLocaleTimeString() })))
      )
    )
  );
}
