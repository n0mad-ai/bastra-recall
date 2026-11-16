// Tasks area — pop-overs over the calendar: "New task", due cards and the
// prepared change (proposal). While one is open the calendar is dimmed and
// blurred (DESIGN-SYSTEM › Pop-over-Fenster). Form fields are the ones the
// existing task API accepts (old UI compose dialog).
import { h } from "../dom.js";
import { loadingInline } from "./loading.js";
import { t } from "../i18n.js";
import { S, emit, say, act, select, create, executeProposal, byId, liveTasks } from "./tasks-store.js";
import { api, fmtAt, calendarSchedule, isTerminal, dueAt } from "./tasks-api.js";

const close = () => {
  S.compose = false;
  S.showDue = false;
  S.proposal = null;
  emit();
};

/** Segmented control (Auslöser, Stufe). */
function seg(opts, key) {
  return h(
    "div.tk-seg",
    null,
    opts.map(([v, lab]) =>
      h("button", {
        cls: S.F[key] === v ? "is-on" : "",
        text: lab,
        on: {
          click: () => {
            S.F = { ...S.F, [key]: v };
            emit();
          },
        },
      })
    )
  );
}
function field(lab, key, ph, { wide = false, list = null } = {}) {
  return h(
    "label.tk-f",
    { cls: wide ? "is-wide" : "" },
    lab,
    h("input.tk-in", {
      value: S.F[key],
      placeholder: ph,
      list,
      on: {
        input: (e) => {
          S.F[key] = e.target.value;
        },
      },
    })
  );
}
export function toggle(on, onClick, aria) {
  return h(
    "button.tk-sw",
    {
      cls: on ? "is-on" : "",
      "aria-label": aria || t("tk.toggle"),
      "aria-pressed": on ? "true" : "false",
      on: { click: onClick },
    },
    h("span.tk-sw__k")
  );
}

function compose() {
  const F = S.F;
  return h(
    "div.tk-pop.tk-pop--compose",
    { role: "dialog", "aria-label": t("tk.f.title") },
    h(
      "div.tk-pop__h",
      null,
      h("span.tk-pop__t", { text: t("tk.f.title") }),
      h("span.tk-pop__s", { text: t("tk.f.orAsk") }),
      h("button.tk-pop__x", { text: t("tk.close"), on: { click: close } })
    ),
    h(
      "div.tk-form",
      null,
      field(t("tk.f.goal"), "goal", t("tk.f.goalPh"), { wide: true }),
      h(
        "div.tk-f.is-wide",
        null,
        t("tk.f.timing"),
        seg(
          [
            ["after", t("tk.f.after")],
            ["when", t("tk.f.local")],
          ],
          "timing"
        )
      ),
      field(t("tk.f.when"), "when", t("tk.f.whenPh")),
      field(t("tk.f.tz"), "tz", "Europe/Berlin"),
      field(t("tk.f.domain"), "domain", "personal"),
      h(
        "div.tk-f.is-wide",
        null,
        t("tk.f.level"),
        seg(
          [
            ["notify", t("tk.lvl.notify")],
            ["prepare", t("tk.lvl.prepare")],
            ["execute", t("tk.lvl.execute")],
          ],
          "level"
        )
      ),
      field(t("tk.f.every"), "every", t("tk.f.everyPh")),
      field(t("tk.f.count"), "count", "3"),
      field(t("tk.f.expires"), "expires", t("tk.f.expiresPh")),
      field(t("tk.f.waits"), "waits", t("tk.f.waitsPh"), { wide: true, list: "tk-goals" }),
      h(
        "datalist",
        { id: "tk-goals" },
        liveTasks()
          .filter((x) => !isTerminal(x))
          .map((x) => h("option", { value: x.goal }))
      ),
      h(
        "div.tk-f",
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
        "div.tk-f",
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
      F.srcKind
        ? field(t("tk.f.srcRef"), "srcRef", F.srcKind === "mail" ? t("tk.f.srcRefMail") : t("tk.f.srcRefMem"), {
            wide: true,
          })
        : null,
      field(t("tk.f.note"), "note", t("tk.f.notePh"), { wide: true })
    ),
    h(
      "div.tk-pop__foot",
      null,
      toggle(
        F.arm,
        () => {
          S.F = { ...S.F, arm: !S.F.arm };
          emit();
        },
        t("tk.f.arm")
      ),
      h("span.tk-pop__sw", { text: t("tk.f.arm") }),
      h("span.tk-pop__note", { text: F.arm ? t("tk.f.armOn") : t("tk.f.armOff") }),
      h("button.tk-btn.is-pri.tk-pop__go", { text: t("tk.f.create"), on: { click: () => create() } })
    )
  );
}

const whyNow = (c) =>
  typeof c.why_now === "string" && c.why_now.startsWith("Registered condition")
    ? t("tk.why.registered")
    : c.why_now || t("tk.why.default");
const OUT = (k) => t(`tk.outcome.${k}`);

/** One due card (old UI task_due dialog), including reconsideration choices. */
function dueCard(c) {
  if (c.kind === "availability")
    return h(
      "div.tk-due__c",
      null,
      h("p.tk-due__why", { text: `${c.summary ?? ""} ${c.detail_command ?? ""}`.trim() })
    );
  const ack = async () =>
    act(async () => {
      const tk = await api("get", { id: c.task_id });
      await api("acknowledge", { id: tk.id, expected_revision: tk.expected_revision, occurrence_id: c.occurrence_id });
      c.acknowledged = true;
      return t("tk.msg.seen");
    });
  const x = byId(c.task_id);
  const parts = [
    h("span.tk-due__g", { text: c.goal }),
    h("span.tk-due__m", {
      text: `${fmtAt(c.due_at, c.timezone)} ${c.timezone ?? ""} · ${c.acknowledged ? t("tk.due.seen") : t("tk.due.unseen")}`,
    }),
    c.action_outcome
      ? h("p.tk-due__why", {
          text: t("tk.due.outcome", {
            o: OUT(c.action_outcome.receipt_outcome ?? c.action_outcome.state),
            hint: c.action_outcome.review_hint ?? "",
            intent: c.action_outcome.intent_id ?? "",
          }),
        })
      : null,
    h("p.tk-due__why", { text: whyNow(c) }),
    c.compact ? h("p.tk-due__why", { text: t("tk.due.compact", { cmd: c.detail_command ?? "" }) }) : null,
  ];
  const rc = c.reconsideration,
    acts = [
      h("button.tk-btn.is-sm", { cls: c.acknowledged ? "is-dim" : "", text: t("tk.due.markSeen"), on: { click: ack } }),
      x
        ? h("button.tk-btn.is-sm.is-link", {
            text: t("tk.due.details"),
            on: {
              click: () => {
                S.showDue = false;
                select(x.id);
              },
            },
          })
        : null,
    ];
  if (rc && rc.decision) {
    parts.push(
      h("p.tk-due__why", {
        text: t("tk.due.rc", {
          opt: rc.decision.option,
          reason: rc.decision.reason,
          old: rc.old_premise,
          nu: rc.new_premise ?? "—",
          alt: (rc.decision.alternatives || []).join(", "),
        }),
      })
    );
    const pick = (choice, extra = {}) =>
      act(async () => {
        const tk = await api("get", { id: c.task_id });
        await api("reconsider", {
          id: tk.id,
          expected_revision: tk.expected_revision,
          occurrence_id: c.occurrence_id,
          choice,
          ...extra,
        });
        S.showDue = false;
        return t("tk.msg.choice");
      });
    const until = h("input.tk-in.is-sm", { placeholder: t("tk.f.whenLocalPh") });
    const opt = h("input.tk-in.is-sm", { placeholder: t("tk.rc.option") }),
      why = h("input.tk-in.is-sm", { placeholder: t("tk.rc.reason") }),
      body = h("input.tk-in.is-sm", { placeholder: t("tk.rc.body") });
    acts.push(
      h("button.tk-btn.is-sm", { text: t("tk.rc.keep"), on: { click: () => pick("keep") } }),
      h("button.tk-btn.is-sm", { text: t("tk.rc.stop"), on: { click: () => pick("stop") } })
    );
    parts.push(
      h(
        "div.tk-due__rc",
        null,
        until,
        h("button.tk-btn.is-sm", {
          text: t("tk.rc.snooze"),
          on: {
            click: () => {
              let at;
              try {
                at = calendarSchedule(until.value.trim(), c.timezone || "UTC").schedule.at;
              } catch (e) {
                say(e.message, "error");
                return;
              }
              pick("snooze", { until: at });
            },
          },
        })
      ),
      h(
        "div.tk-due__rc",
        null,
        opt,
        why,
        body,
        h("button.tk-btn.is-sm", {
          text: t("tk.rc.change"),
          on: {
            click: async () => {
              if (!opt.value.trim() || !why.value.trim()) {
                say(t("tk.err.validation"), "error");
                return;
              }
              const tk = await api("get", { id: c.task_id }).catch((e) => {
                say(e.message, "error");
                return null;
              });
              if (!tk) return;
              pick("change", {
                change: {
                  idempotency_key: crypto.randomUUID(),
                  expected_memory_revision: tk.decision?.revision,
                  option: opt.value.trim(),
                  reason: why.value.trim(),
                  body: body.value,
                },
              });
            },
          },
        })
      )
    );
  }
  return h("div.tk-due__c", null, parts, h("div.tk-due__acts", null, acts));
}

// The delivery endpoint may withhold cards until the next retry. The status
// snapshot still contains the actual due tasks: show those, without inventing
// an occurrence or acknowledgement action for an undelivered card.
const pendingTasks = () => {
  const delivered = new Set((S.due || []).map((c) => c.task_id));
  return S.items.filter((x) => x.k === "due" && !x.t.archived && !delivered.has(x.t.id));
};
function due() {
  const cards = S.due || [];
  const pending = pendingTasks();
  const count = cards.filter((c) => c.kind !== "availability").length + pending.length;
  return h(
    "div.tk-pop.tk-pop--due",
    { role: "dialog", "aria-label": t("tk.due.title") },
    h(
      "div.tk-pop__h.is-row",
      null,
      h("span.tk-pop__k", { text: t("tk.due.title") }),
      S.dueBusy
        ? h("span.tk-pop__n", null, loadingInline(t("tk.loading")))
        : h("span.tk-pop__n", { text: t("tk.due.ready", { n: count }) }),
      h("button.tk-pop__x", { text: t("tk.close"), on: { click: close } })
    ),
    h(
      "div.tk-due",
      null,
      cards.map(dueCard),
      pending.map((x) =>
        h(
          "div.tk-due__c",
          null,
          h("span.tk-due__g", { text: x.t.goal }),
          h("span.tk-due__m", { text: fmtAt(dueAt(x.t), x.t.timezone) }),
          h(
            "div.tk-due__acts",
            null,
            h("button.tk-btn.is-sm.is-link", {
              text: t("tk.due.details"),
              on: {
                click: () => {
                  S.showDue = false;
                  select(x.id);
                },
              },
            })
          )
        )
      ),
      !S.dueBusy && S.duePending
        ? h("p.tk-due__none", { text: t("tk.due.pending", { n: S.duePending, b: S.dueBlocked }) })
        : !S.dueBusy && !count && !cards.length
          ? h("p.tk-due__none", { text: t("tk.due.none") })
          : null
    )
  );
}

function authText(a) {
  const lab =
    a.revoked_at !== undefined ? t("tk.auth.revoked") : a.decision === "deny" ? t("tk.auth.denied") : t("tk.auth.ok");
  return `${lab} · ${a.program ?? ""} · ${t("tk.session")} ${a.session_id ?? ""} · ${fmtAt(a.at)} · ${a.write_origin ?? ""}: ${a.user_request ?? ""}`;
}

/** Prepared change: exact before/after, execute (old UI showProposal). */
function proposal() {
  const d = S.proposal,
    p = d.proposal,
    stale = p.status === "stale";
  const auth =
    (Array.isArray(d.authorizations) && d.authorizations.at(-1)?.authorization
      ? {
          ...d.authorizations.at(-1).authorization,
          decision: d.authorizations.at(-1).decision,
          revoked_at: d.authorizations.at(-1).revoked_at,
        }
      : null) ||
    d.authorization ||
    p.authorization;
  const canRun = !stale && d.approved === true && (!d.binding_status || d.binding_status === "current");
  return h(
    "div.tk-pop.tk-pop--prop",
    { role: "dialog", "aria-label": t("tk.prop.title") },
    h(
      "div.tk-pop__h",
      null,
      h("span.tk-pop__t", { text: stale ? t("tk.prop.stale") : d.task_goal || t("tk.prop.task", { id: p.task_id }) }),
      h("button.tk-pop__x", { text: t("tk.close"), on: { click: close } })
    ),
    stale
      ? h("p.tk-prop__p", { text: t("tk.prop.staleText") })
      : [
          h("p.tk-prop__p", { text: t("tk.prop.exact") }),
          h(
            "div.tk-prop__cols",
            null,
            h(
              "div",
              null,
              h("span.tk-prop__k", { text: t("tk.prop.before") }),
              h("pre.tk-prop__pre", { text: d.preview?.before ?? t("tk.prop.beforeNone") })
            ),
            h(
              "div",
              null,
              h("span.tk-prop__k", { text: t("tk.prop.after") }),
              h("pre.tk-prop__pre", { text: d.preview?.after ?? p.payload ?? "" })
            )
          ),
          auth ? h("p.tk-prop__p", { text: authText(auth) }) : null,
          canRun ? null : h("p.tk-prop__p.is-warn", { text: t("tk.prop.missing") }),
          S.propNote ? h("p.tk-prop__p.is-ok", { text: S.propNote }) : null,
        ],
    stale
      ? null
      : h(
          "div.tk-pop__foot",
          null,
          h("button.tk-btn.is-pri.tk-pop__go", {
            text: t("tk.prop.run"),
            disabled: canRun ? null : true,
            on: {
              click: (e) => {
                e.currentTarget.disabled = true;
                executeProposal();
              },
            },
          })
        )
  );
}

export function overlays() {
  const open = S.compose || S.showDue || !!S.proposal;
  if (!open) return [];
  return [h("div.tk-dim", { on: { click: close } }), S.proposal ? proposal() : S.compose ? compose() : due()];
}

/** Keep the dimmer and dialog themselves mounted across polling/weather/
 * resize updates. Only meaningful changes update their content, so the entry
 * animation does not restart and unrelated refreshes do not steal input. */
export function overlayRenderer(host) {
  let kind = "",
    key = "";
  return () => {
    const next = S.proposal ? "proposal" : S.compose ? "compose" : S.showDue ? "due" : "";
    const sig = JSON.stringify(
      next === "proposal"
        ? [S.proposal, S.propNote]
        : // Text inputs already own their live values. Including them here would
          // rebuild the form on the first poll after typing, despite no UI change.
          next === "compose"
          ? [
              S.F.timing,
              S.F.level,
              S.F.arm,
              S.F.assignee,
              S.F.srcKind,
              liveTasks()
                .filter((x) => !isTerminal(x))
                .map((x) => x.goal),
            ]
          : next === "due"
            ? [
                S.due,
                S.dueBusy,
                S.duePending,
                S.dueBlocked,
                pendingTasks().map((x) => [x.id, x.t.goal, dueAt(x.t), x.t.timezone]),
              ]
            : null
    );
    if (next === kind && sig === key) return;
    if (next !== kind) host.replaceChildren(...overlays());
    else if (next) {
      const current = host.querySelector(".tk-pop"),
        fresh = overlays()[1];
      const scroll = current.scrollTop,
        active = document.activeElement;
      const inputs = [...current.querySelectorAll("input,textarea")],
        index = inputs.indexOf(active);
      const field = index < 0 ? null : { value: active.value, start: active.selectionStart, end: active.selectionEnd };
      current.replaceChildren(...fresh.childNodes);
      current.scrollTop = scroll;
      if (field) {
        const input = current.querySelectorAll("input,textarea")[index];
        if (input) {
          input.value = field.value;
          input.focus({ preventScroll: true });
          input.setSelectionRange(field.start, field.end);
        }
      }
    }
    kind = next;
    key = sig;
  };
}
