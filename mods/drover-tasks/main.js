// Drover Tasks: the right-side attention panel. One row per task, grouped
// Needs you > Ready for review > Working > Ready. Type to filter; Enter adds a task.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover } from "gpui-base";
import { agents, terminals, run, theme, shared, setShared } from "herdr";
import { bind, isEnabled, whenLoaded, ready as cfgReady } from "./config.js";
import { GROUPS, projectOf, add, update, matches, sorted, attention, menuChange, FILTER_FIELDS, toggleFilter, clearFilters, matchesFilter, filterValues, searchFilters, filterChips } from "./store.js";
import { reviewLive, dotKind, liveStatuses, liveAgents } from "./runs.js";
import { load, loadRuns, loadProjects, loadConfig, spaceProject, sidebarSpace, save, edit, pick, openBoard, watchInbox, watchWakes, modSettings, loadMerged, watchRemote, retryRemote } from "./io.js";
import { READONLY_TIP } from "./remote.js";

const FOLD = "drover.tasks.fold";
// { field: [values] } per space (each sidebar follows its own Drover's project), "drover.tasks.filters" when no space is known. Never defaults to hiding anything.
const FILTERS = "drover.tasks.filters";
const filtersKey = () => { const sp = sidebarSpace(); return sp ? `${FILTERS}:${sp}` : FILTERS; };
const I = (name) => `mods/drover-tasks/icons/${name}.svg`;
const FIELD_ICON = { status: "circle-dot", agentStatus: "bot", priority: "signal", date: "calendar", assignee: "user", project: "folder", label: "tag", source: "arrow-up-right" };
// Project first, as the sidebar is mostly used to follow one project; Agent status is the Board's and stays out of this compact menu.
const FIELDS = ["project", "status", "priority", "label", "assignee", "date", "source"].map((id) => FILTER_FIELDS.find(([f]) => f === id));
const DOT = (t) => ({ needs: t.blocked, review: t.done, working: t.working, todo: t.idle });

export default class Tasks extends View {
  init(_props, cx) {
    this.query = "";
    bind({ shared, modSettings });
    whenLoaded("drover-tasks", cx);
    // The CLI consumers (inbox and wakeup delivery) keep running while the screen is off (decision G2: off is screen only).
    watchInbox(cx);
    watchWakes(cx);
    this.pop = null; // "filter" while the filter popover is open
    this.filterView = null; // the field whose values the popover shows (null: the field list)
    this.fsearch = InputState.new({ placeholder: "Filter by field or value…" });
    this.fsearch.on("change", (_e, cx) => { this.filterView = null; cx.notify(); });
    this.input = InputState.new({ placeholder: "Filter, or Enter to add" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => {
      if (save(add(load(), { title: this.query, column: "todo" }))) { this.input.set_value(""); this.query = ""; }
      cx.notify();
    });
  }

  filters() { const f = shared(filtersKey()); return f && typeof f === "object" && !Array.isArray(f) ? f : {}; }
  setFilters(next) { setShared(filtersKey(), next); }
  spaceProject() { const id = spaceProject(); return id && loadProjects().some((p) => p.id === id) ? id : null; }
  toggleSpace() { const id = this.spaceProject(); if (id) this.setFilters(toggleFilter(this.filters(), "project", id)); }

  // Popover reports every open change; a stale close from the previous popover is ignored.
  setPop(key, open, cx) {
    const next = menuChange(this.pop, key, open);
    if (next !== this.pop) {
      this.pop = next; this.filterView = null;
      if (this.fsearch.value()) this.fsearch.set_value("");
    }
    cx.notify();
  }

  filterCtx() {
    return { now: Date.now(), projects: loadProjects(), runs: loadRuns(), config: loadConfig(), tasks: load(), agentsByAddress: liveAgents(agents(), terminals()) };
  }

  // A live agent takes the click (focus it); such a row also gets a pencil that opens the editor.
  hasLiveAgent(task) { return Boolean(task.agent) && agents().some((a) => a.address === task.agent); }
  open(task) {
    if (task.remote) return edit(task.id, undefined, undefined, undefined, undefined, task); // another machine's card: the read-only view, never an agent focus
    if (this.hasLiveAgent(task)) run("agent.focus", { terminal: task.agent });
    else edit(task.id);
  }
  editTask(id) { edit(id); }

  render(cx) {
    const t = theme();
    if (!isEnabled("drover-tasks")) return div(); // off, or still loading its settings: // off draws nothing (the column stays: cmd-alt-b is bound in keys.json, see drover-tabs)
    if (!this.remoteOn) { this.remoteOn = true; watchRemote(cx, () => isEnabled("drover-tasks")); } // reads each remote-bound project every 15 s while the panel is on
    const merged = loadMerged();
    const live = liveAgents(agents(), terminals());
    const fold = shared(FOLD) ?? {};
    const statuses = liveStatuses(agents(), terminals());
    const alive = new Set(terminals().map((x) => x.address));
    const runs = loadRuns();
    const filters = this.filters();
    const fctx = this.filterCtx();
    const filterCount = Object.values(filters).reduce((n, v) => n + v.length, 0);
    const rows = sorted(merged.tasks.filter((x) => matchesFilter(x, filters, fctx) && matches(x, this.query)))
      .map((task) => ({ task, at: attention(task, live) }))
      .filter((r) => r.at);
    const icon = (id, text, tip, action) => div().id(id).w(22).h(22).flex_none().flex().items_center().justify_center()
      .rounded(5).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(text);

    // Review + an agent still working/running: blue fill with a yellow ring. Other dots unchanged.
    const dot = (task, at) => dotKind(at.group, reviewLive(task, runs, statuses, alive)) === "review-live"
      ? div().w(9).h(9).flex_none().rounded(5).bg(t.working).border_2().border_color(t.done)
      : div().w(7).h(7).flex_none().rounded(4).bg(DOT(t)[at.group]);
    const projects = loadProjects();
    const off = (id, text) => div().id(id).w(22).h(22).flex_none().flex().items_center().justify_center().rounded(5).text_size(12).text_color(t.dim).opacity(0.5).tooltip(READONLY_TIP).child(text);
    const stale = (task) => Boolean(task.remote) && merged.remotes.some((r) => r.localId === task.project && r.state !== "fresh");
    const row = ({ task, at }) => h_flex().id(`task-${task.id}`).min_h(40).px(8).py(4).gap(8).items_center().rounded(7).when(stale(task), (el) => el.opacity(0.55))
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.open(task))
      .child(dot(task, at))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).child(task.title))
        .child(div().truncate().text_size(10.5).text_color(t.dim)
          .child([task.id, task.priority, projectOf(task, projects)?.name, task.remote?.machine, at.reason, ...task.tags.map((g) => `#${g}`)].filter(Boolean).join(" · "))))
      .when(this.hasLiveAgent(task), (el) => el.child(icon(`edit-${task.id}`, "✎", "Edit task", () => this.editTask(task.id))))
      .when(at.group === "todo", (el) => el.child(task.remote ? off(`ro-start-${task.id}`, "▶") : icon(`start-${task.id}`, "▶", "Start", () => pick(task.id))))
      .when(at.group === "review", (el) => el.child(task.remote ? off(`ro-done-${task.id}`, "✓") : icon(`done-${task.id}`, "✓", "Done", () => save(update(load(), task.id, { column: "done" })))));

    const group = ([id, name]) => {
      const items = rows.filter((r) => r.at.group === id);
      if (!items.length) return null;
      return v_flex().gap(1)
        .child(h_flex().id(`g-${id}`).h(24).px(8).gap(6).items_center().cursor_pointer()
          .on_click(() => setShared(FOLD, { ...fold, [id]: !fold[id] }))
          .child(div().text_size(11).text_color(t.muted).font_medium().child(`${fold[id] ? "▸" : "▾"} ${name}`))
          .child(div().text_size(11).text_color(t.dim).child(String(items.length))))
        .when(!fold[id], (el) => el.children(items.map(row)));
    };

    const mrow = (id, iconName, text, { right, chevron, check, action }) => h_flex().id(id).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(div().w(14).h(14).flex_none().flex().items_center().justify_center().text_color(check ? t.foreground : t.muted)
        .when(Boolean(iconName), (el) => el.child(svg(I(iconName)).size(14))))
      .child(div().flex_1().min_w(0).truncate().whitespace_nowrap().child(text))
      .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).whitespace_nowrap().child(right)))
      .when(Boolean(chevron), (el) => el.child(svg(I("chevron-right")).size(13).text_color(t.dim)));
    const valueRow = (field, v) => {
      const on = (filters[field] ?? []).includes(v.value);
      return mrow(`fr-${field}-${v.value}`, on ? "check" : null, v.label, { check: on, action: (cx) => { this.setFilters(toggleFilter(filters, field, v.value)); cx.notify(); } });
    };
    const filterMenu = () => {
      const q = this.fsearch.value().trim();
      const found = searchFilters(q, fctx);
      const fields = FIELDS.filter(([id]) => found.fields.some(([f]) => f === id));
      const values = found.values.filter((v) => FIELDS.some(([f]) => f === v.field));
      const sub = this.filterView ? FIELDS.find(([id]) => id === this.filterView) : null;
      const space = sub?.[0] === "project" ? this.spaceProject() : null;
      const spaceOn = space && (filters.project ?? []).includes(space);
      const none = (text) => div().px(8).h(30).flex().items_center().text_size(12.5).text_color(t.dim).child(text);
      return v_flex().id("filter-menu").w(260).max_h(420).mt(4).p(4).rounded(10).bg(t.popover).border_1().border_color(t.input).text_size(12.5).text_color(t.foreground)
        .child(h_flex().h(34).px(8).gap(8).items_center()
          .child(svg(I("search")).size(14).text_color(t.dim))
          .child(Input.new(this.fsearch).flex_1().h(28).border_0().bg(t.popover).text_size(12.5)))
        .child(div().h(1).bg(t.border))
        .child(v_flex().id("filter-body").gap(1).py(4).overflow_y_scrollbar()
          .when(Boolean(sub), (el) => el
            .child(mrow("fr-back", "chevron-left", sub[1], { action: (cx) => { this.filterView = null; cx.notify(); } }))
            .child(div().h(1).my(4).bg(t.border))
            .when(Boolean(space), (m) => m.child(mrow("fr-space", "folder", `This space: ${loadProjects().find((p) => p.id === space)?.name ?? space}`, { check: spaceOn, action: (cx) => { this.toggleSpace(); cx.notify(); } })))
            .children(filterValues(sub[0], fctx).map((v) => valueRow(sub[0], v)))
            .when(filterValues(sub[0], fctx).length === 0, (m) => m.child(none("Nothing to filter on yet"))))
          .when(!sub, (el) => el
            .children(fields.map(([id, label]) => mrow(`fr-${id}`, FIELD_ICON[id], label, { chevron: true, right: filters[id]?.length ? String(filters[id].length) : null, action: (cx) => { this.filterView = id; cx.notify(); } })))
            .children(values.map((v) => valueRow(v.field, { ...v, label: `${v.fieldLabel}: ${v.label}` })))
            .when(fields.length === 0 && values.length === 0, (m) => m.child(none("No match")))))
        .when(filterCount > 0, (el) => el.child(div().h(1).bg(t.border)).child(v_flex().pt(4)
          .child(mrow("fr-clear", "x", "Clear filters", { action: (cx) => { this.setFilters(clearFilters()); cx.notify(); } }))));
    };
    const chipsRow = () => h_flex().id("filter-chips").px(8).pb(6).gap(4).items_center().flex_wrap()
      .children(filterChips(filters, fctx).map((c) => h_flex().id(`chip-${c.field}-${c.value}`).h(22).px(7).gap(4).items_center().rounded_full().bg(t.hover)
        .text_size(11).whitespace_nowrap().cursor_pointer().hover((s) => s.bg(t.selected))
        .on_click((_e, cx) => { this.setFilters(toggleFilter(filters, c.field, c.value)); cx.notify(); })
        .child(svg(I(FIELD_ICON[c.field] ?? "tag")).size(11).text_color(t.dim)).child(div().child(c.label)).child(svg(I("x")).size(11).text_color(t.muted)))
      ).child(div().id("chips-clear").h(22).px(7).flex().items_center().rounded_full().text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.setFilters(clearFilters()); cx.notify(); }).child("Clear"));
    const open = this.pop === "filter";
    const filterBtn = Popover.new("pop-filter").anchor("top_right").open(open).on_open_change((v, cx) => this.setPop("filter", v, cx))
      .trigger(h_flex().id("filter").h(22).px(5).gap(3).flex_none().items_center().rounded(5).text_size(11).cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground))
        .text_color(open || filterCount > 0 ? t.foreground : t.muted).when(open, (el) => el.bg(t.raised))
        .child(svg(I("list-filter")).size(14)).when(filterCount > 0, (el) => el.child(div().child(String(filterCount)))))
      .content(filterMenu());

    const banners = merged.remotes.filter((r) => r.banner).map((r) => h_flex().id(`banner-${r.localId}`).mx(8).mb(6).px(8).min_h(28).gap(6).items_center().rounded(7).bg(t.hover).text_size(11.5)
      .text_color(r.state === "never" ? t.muted : t.blocked)
      .child(div().flex_1().min_w(0).child(`${r.name}: ${r.banner}`))
      .child(div().id(`retry-${r.localId}`).h(22).px(8).flex().items_center().flex_none().rounded(6).bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); retryRemote(r.machine, r.projectId, cx); }).child("Retry")));
    const empty = merged.tasks.length === 0 ? "No tasks. Type a title and press Enter." : rows.length === 0 ? (filterCount > 0 ? "Nothing matches this filter." : "Nothing to show.") : null;
    return v_flex().id("root").size_full().bg(t.chrome).text_color(t.foreground)
      .child(h_flex().h(34).px(10).items_center().gap(6)
        .child(div().flex_1().text_size(12.5).font_semibold().child("Tasks"))
        .child(filterBtn)
        .child(icon("board", svg("mods/drover-tasks/board.svg").size(14), "Board", () => openBoard()))
        .child(icon("new", "+", "New", () => edit(null))))
      .child(div().px(8).pb(6).child(Input.new(this.input).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12)))
      .when(filterCount > 0, (el) => el.child(chipsRow()))
      .children(banners)
      .child(empty
        ? div().p(12).text_size(12).text_color(t.dim).child(empty)
        : v_flex().id("groups").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(8).gap(6).children(GROUPS.map(group).filter(Boolean)));
  }
}
