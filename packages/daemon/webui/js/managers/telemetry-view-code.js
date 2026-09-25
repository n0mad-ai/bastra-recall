/**
 * #579 — code awareness, both halves. Split out of telemetry-view.js under
 * #601 once that file reached the size ceiling — this section is a coherent
 * unit on its own (one question, one report object) and was already set off
 * by its own heading comment there.
 *
 * The block half is the cost the Write/Edit lane pays without being asked; the
 * tool half is what an agent asked for on purpose. Wording mirrors the CLI
 * section (src/cli/log-stats-code.ts) and both read the same folds, so a figure
 * cannot appear in one readout and not the other.
 */
import { h, table, td, note, empty, h3, section, barCell, fmt, pct, ms } from "./telemetry-dom.js";

export const UNAVAILABLE_REASONS = {
  off_env: "switched off for the session",
  not_enabled: "repository not enabled",
  degraded: "graph refused — see bastra doctor",
  not_indexed: "never indexed",
  loading: "read in flight, call did not wait",
  cold: "on disk, not in memory yet",
};

export function renderCodeAwareness(ca) {
  const title = "Code awareness (experimental)";
  const question =
    "How often is the code graph asked, can it answer, and how current does the refresh keep it?";
  if (!ca) {
    return section(title, question, empty("no code-awareness events in this window — no tool call, no dependents block, no refresh"));
  }
  const a = ca.active;
  const b = ca.block;
  // #606. Older report objects have no `delivered` fold; an empty one keeps
  // every figure below readable as "nothing delivered" instead of throwing.
  const dl = a.delivered ?? {
    blocks: 0, dedupeHits: 0, byLane: [], byBasis: [],
    filesNamed: 0, tokensTotal: 0, tokensMedian: 0, p50: 0, p90: 0,
  };
  // Split from one 9-column table into two (#601): calls/answered/nothing
  // found/unavailable on one side, latency/reach on the other — the combined
  // table did not fit a tv-cols half at any width and overflowed into the
  // neighbouring "Graph refresh" table. Each table mirrors an existing
  // house pattern (bands table / latency-by-lane table) rather than a new one.
  const maxOk = Math.max(1, ...a.tools.map((t) => t.calls));
  const answerRows = a.tools.map((t) =>
    h("tr", null,
      td(t.tool),
      barCell(t.ok, maxOk),
      td(fmt(t.calls)),
      td(`${fmt(t.ok)} (${pct(t.ok, t.calls)})`, t.ok > 0 ? "ok" : null),
      td(fmt(t.noAnswer), "dim"),
      td(fmt(t.unavailable), t.unavailable > 0 ? null : "dim")),
  );
  const maxP50 = Math.max(1, ...a.tools.map((t) => t.p50));
  const latencyRows = a.tools.map((t) =>
    h("tr", null,
      td(t.tool),
      barCell(t.p50, maxP50),
      td(ms(t.p50)),
      td(ms(t.p90), "dim"),
      td(fmt(t.filesNamed), "dim")),
  );
  // #601: the value column used to be right-aligned in an otherwise near-empty
  // table, so it drifted far from its "tool" label with a wide dead gap
  // between them — `left` is the same class the session-start source table
  // uses for its own free-text column.
  const reasonRows = a.tools.flatMap((t) =>
    t.byUnavailableReason.map((r) =>
      h("tr", null, td(t.tool, "dim"), td(UNAVAILABLE_REASONS[r.key] ?? r.key, "left"), td(fmt(r.count))),
    ),
  );
  const kindRows = a.tools.flatMap((t) =>
    t.byKind.map((r) => h("tr", null, td(t.tool, "dim"), td(r.key, "left"), td(fmt(r.count)))),
  );
  const rf = a.refresh;
  const repoRows = a.repos.map((r) =>
    h("tr", null,
      // "left", not "id": a shortened repo path is short enough to read on
      // one line, unlike the long memory ids that class is usually for.
      td(r.repo, "left"),
      td(fmt(r.toolCalls)),
      td(fmt(r.refreshes), "dim"),
      td(r.externalTotal === null ? "—" : `${fmt(r.externalResolved)} / ${fmt(r.externalTotal)}`,
        r.externalTotal !== null && r.externalTotal > 0 && r.externalResolved === 0 ? "warn" : "dim")),
  );
  const brokenWorkspace = a.repos.some((r) => r.externalTotal > 0 && r.externalResolved === 0);
  // Matches TEMPORARY_TREE_LABEL in code-awareness-stats.ts: a throwaway tree
  // from the measurement harness is still listed below (nothing is hidden),
  // but it is not one of the user's own repositories, so it does not count
  // toward "N repositories active".
  const realRepoCount = a.repos.filter((r) => r.repo !== "(temporary tree)").length;

  // #601 follow-up: the figure row reuses the exact "tv-cols wide" grid the
  // table zone below uses — same two columns, same divider — so its middle
  // rule IS the table zone's column rule, not a pixel-matched copy of it.
  // Each half then holds its own two-tile "tv-figs" pair for the divider
  // between tiles 1/2 and 3/4. Below the shared stacking width both halves
  // simply drop to one full-width column, tile pairs still side by side.
  const fig = (k, v, sub, ok = false) =>
    h("div", null, h("div", { class: "tv-fig-k" }, k), h("div", { class: `tv-fig-v${ok ? " ok" : ""}` }, v), h("div", { class: "tv-fig-sub" }, sub));

  return section(
    title,
    question,
    h(
      "div",
      { class: "tv-cols wide" },
      h(
        "div",
        { class: "tv-figs center" },
        fig("tool calls", fmt(a.tools.reduce((n, t) => n + t.calls, 0)), `${realRepoCount} repositor${realRepoCount === 1 ? "y" : "ies"} active`),
        fig("answered", pct(a.tools.reduce((n, t) => n + t.ok, 0), a.tools.reduce((n, t) => n + t.calls, 0)), `${fmt(a.tools.reduce((n, t) => n + t.unavailable, 0))} unavailable`, true),
      ),
      h(
        "div",
        { class: "tv-figs center" },
        // #606: the headline figure is what Recall DELIVERED, because that is
        // the channel the change made; the injected-block cost below it is the
        // price. `active.delivered` and the hook_call fold count the same write
        // -lane blocks from two different rows, so they are shown as cost and
        // channel rather than added up.
        fig("delivered blocks", fmt(dl.blocks), `${fmt(b.codeTokensTotal)} tokens · ${pct(b.codeTokensTotal, b.hintTokensTotal)} of everything injected`),
        fig("followed by an edit", pct(b.blocksFollowed, b.blocksWithListed), `${fmt(b.blocksFollowed)} of ${fmt(b.blocksWithListed)} blocks`, b.blocksFollowed > 0),
      ),
    ),
    h(
      // #601: this section's left column alone needs more room than the
      // other sections' — two number-heavy tables, not one — so it gets a
      // wider stacking threshold than the tab-wide default; below that width
      // it stacks to one full-width column instead of squeezing both.
      "div",
      { class: "tv-cols wide" },
      h(
        "div",
        null,
        h3("Tools — find_code / find_affected_files"),
        answerRows.length
          ? table(["tool", "", "calls", "answered", "nothing found", "unavailable"], answerRows)
          : empty("no tool call in this window"),
        answerRows.length ? h3("Latency & reach") : null,
        answerRows.length ? table(["tool", "", "p50", "p90", "files named"], latencyRows) : null,
        kindRows.length ? h3("By lane (find_code) / basis (find_affected_files)") : null,
        kindRows.length ? table(["tool", "lane / basis", "calls"], kindRows, "snug") : null,
        reasonRows.length ? h3("Why the graph could not answer") : null,
        reasonRows.length ? table(["tool", "reason", "calls"], reasonRows, "snug") : null,
        note("`unavailable` is not an error and says nothing about whether the symbol exists — off, not indexed, still loading and refused are four different worlds and only `degraded` is a defect."),
      ),
      h(
        "div",
        null,
        h3("Graph refresh"),
        rf.started > 0 || rf.ok > 0
          ? table(
              ["", "runs"],
              [
                h("tr", null, td("started"), td(fmt(rf.started))),
                h("tr", null, td("ok"), td(fmt(rf.ok), rf.ok > 0 ? "ok" : null)),
                h("tr", null, td("failed"), td(fmt(rf.failed), rf.failed > 0 ? "warn" : "dim")),
                h("tr", null, td("locked · skipped · given up"), td(`${fmt(rf.locked)} · ${fmt(rf.skipped)} · ${fmt(rf.givenUp)}`, "dim")),
                h("tr", null, td("duration p50 / p90"), td(`${ms(rf.p50)} / ${ms(rf.p90)}`)),
              ],
            )
          : empty("no refresh run in this window"),
        rf.byReason.length ? note(`triggered by: ${rf.byReason.map((r) => `${r.key} ${fmt(r.count)}`).join(" · ")}`) : null,
        rf.failures.length ? note(`failures: ${rf.failures.map((r) => `${r.key} ${fmt(r.count)}`).join(" · ")}`, true) : null,
        h3("Repositories"),
        repoRows.length ? table(["repo", "tool calls", "refreshes", "external resolved / total"], repoRows) : empty("none"),
        brokenWorkspace
          ? note("A workspace repository resolved 0 of its external nodes — cross-package impact is not being found. Rebuild with `bastra code index`; if it stays 0, that is #582's id-format regression.", true)
          : null,
        h3("Delivered — the graph answer nobody asked for (#606)"),
        dl.blocks > 0 || dl.dedupeHits > 0
          ? table(
              ["", "value"],
              [
                h("tr", null, td("blocks injected"), td(fmt(dl.blocks), dl.blocks > 0 ? "ok" : null)),
                h("tr", null, td("already delivered this session"), td(fmt(dl.dedupeHits), "dim")),
                h("tr", null, td("by lane"), td(dl.byLane.length ? dl.byLane.map((r) => `${r.key} ${fmt(r.count)}`).join(" · ") : "—", "left")),
                h("tr", null, td("by basis"), td(dl.byBasis.length ? dl.byBasis.map((r) => `${r.key} ${fmt(r.count)}`).join(" · ") : "—", "left")),
                h("tr", null, td("cost"), td(`${fmt(dl.tokensTotal)} tokens · ${fmt(dl.tokensMedian)} median`)),
                h("tr", null, td("reach"), td(`${fmt(dl.filesNamed)} candidate file(s) named`)),
                h("tr", null, td("latency p50 / p90"), td(`${ms(dl.p50)} / ${ms(dl.p90)}`)),
              ],
            )
          : empty("no block was delivered in this window"),
        note("`whole_file` as a basis is not a failure — it is the honest answer when the change touches something outside every symbol (an import, top-level code). A run of them does mean the narrowing is not earning its keep."),
        h3("Injected blocks — the passive half (#579)"),
        b.withCodeBlock > 0 || b.withAppliesTo > 0
          ? table(
              ["", "value"],
              [
                h("tr", null, td("dependents block"), td(`${fmt(b.withCodeBlock)} of ${fmt(b.calls)} write/edit calls (${pct(b.withCodeBlock, b.calls)})`)),
                h("tr", null, td("cost"), td(`${fmt(b.codeTokensTotal)} tokens · ${fmt(b.codeTokensMedian)} median`)),
                h("tr", null, td("reach"), td(`${fmt(b.dependentsTotal)} dependants named · ${fmt(b.dependentsMedian)} median`)),
                h("tr", null, td("marked possibly out of date"), td(fmt(b.staleBlocks), b.staleBlocks > 0 ? "warn" : "dim")),
                h("tr", null, td("affects_files block"), td(`${fmt(b.withAppliesTo)} calls · ${fmt(b.appliesToTokensTotal)} tokens · ${fmt(b.appliesToCount)} memories`)),
              ],
            )
          : empty("no block was injected in this window"),
        note("Cost and reach, not value: `followed` means a later write in the same session touched a file the block named — evidence the list mattered, not proof it caused the edit. What code awareness SAVED needs the control arm in packages/eval/code-roi."),
      ),
    ),
  );
}
