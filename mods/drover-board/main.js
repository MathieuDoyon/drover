// Drover Board: Backlog / Ready / In progress / Review / Blocked / Done.
// Mouse: drag a card up/down to sort it, onto another column to move it, ‹ › move a card, ▶ starts an agent or squad, click edits.
// Keys (click the board first): arrows select, shift+left/right move, enter edit, n new, s start.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover } from "gpui-base";
import { agents, terminals, theme, shared } from "herdr";
import { liveAgents, liveStatuses, slotSnapshot, slotLine } from "./runs.js";
import { COLUMNS, STATUS_ICON, projectOf, shiftVisible, reorder, matches, sorted, updatedAgo, clampText, sortCards, archiveDone, SORT_MODES, SCOPES, inScope, checklistProgress, ringGlyph, menuChange, FILTER_FIELDS, toggleFilter, clearFilters, matchesFilter, filterValues, searchFilters, filterChips, assigneeText } from "./store.js";
import { load, loadProjects, loadRuns, loadConfig, save, edit, pick, openUrl, watchInbox, modSettings, loadMerged, watchRemote, retryRemote, dismissNeed, remoteSend, remoteWriteState, takeRemoteOutcomes } from "./io.js";
import { offTip, controlState, statusLine, moveOp, shiftOp, outcomeText } from "./remote-write-ui.js";
import { DISMISS_KEY, bannerKey, visibleBanners, statusHidden } from "./dismiss.js";
import { READONLY_TIP } from "./remote.js";
import { bind, cfg, isEnabled, whenLoaded } from "./config.js";
import { gated } from "./ui.js";

// Line icons (lucide, stroke currentColor), resolved from the Herdr home like drover-todos'.
const I = (name) => `mods/drover-board/icons/${name}.svg`;
const STATUS_SVG = { backlog: "circle-dashed", todo: "circle", doing: "circle-dot", review: "circle-check", blocked: "circle-slash", done: "circle-check-big" };
const FIELD_ICON = { status: "circle-dot", agentStatus: "bot", priority: "signal", date: "calendar", assignee: "user", project: "folder", label: "tag", source: "arrow-up-right" };

const PRIORITY_COLOR = (t) => ({ P0: t.blocked, P1: t.done, P2: t.muted, P3: t.dim });

// Card footer left side: the saved assignee's name, then the live agent's status ("Stray Roundup · t3q done"); a gone terminal shows only when nothing is saved.
const footerText = (x, status, cfg) => {
  const name = assigneeText(x.assignee, cfg);
  const live = status && status !== "gone" ? `${x.agent} ${status}` : "";
  if (name) return live ? `${name} · ${live}` : name;
  return status ? `● ${x.agent} ${status}` : "";
};

export default class Board extends View {
  init(_props, cx) {
    this.query = "";
    bind({ shared, modSettings });
    whenLoaded("drover-board", cx);
    // The CLI inbox consumer keeps running while the screen is off (decision G2: off is screen only, the drover CLI stays).
    watchInbox(cx);
    this.selected = null;
    this.drag = null; // id of the card pressed; release on a card drops before it, on a column drops last
    this.over = null; // where a drop would land now: { col, before } (before null: last). Only while dragging.
    this.pop = null; // the open popover: "col:<id>" (column "…" menu) or "scope"; Popover owns press, Esc and outside click
    this.confirm = false; // that menu shows "Archive N cards? Confirm / Cancel"
    this.sort = {}; // column id -> "manual" | "priority" | "newest" (view only)
    this.collapsed = new Set();
    this.scope = "all"; // top bar "All issues" preset, applied on top of the text filter
    this.filters = {}; // Multi-field filter menu state: { field: [values] }, in memory
    this.filterView = null; // the field whose values the filter popover shows (null: the field list)
    this.fsearch = InputState.new({ placeholder: "Filter by field or value…" });
    this.fsearch.on("change", (_e, cx) => { this.filterView = null; cx.notify(); });
    // Key events from a text field bubble to the root: while a filter field has focus the single-key shortcuts must only type.
    this.typing = new Set();
    this.trackTyping(this.fsearch);
    this.confirmIds = []; // the Done cards the open "Archive N cards?" row counted
    this.view = "board"; // "board" | "list"
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Filter: words, #tag, p1" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.trackTyping(this.input);
  }

  // Focus adds the field, blur removes it; the board ignores its keys while any field is focused.
  trackTyping(f) { f.on("focus", () => this.typing.add(f)); f.on("blur", () => this.typing.delete(f)); }

  // Every column with the cards that pass the scope, filter and search.
  // `rs` is the render's snapshot (render() builds it once); event handlers pass none and read fresh.
  allColumns(rs) {
    const projects = rs?.projects ?? loadProjects();
    const ctx = rs?.fctx ?? this.filterCtx(projects);
    const shown = sorted((rs?.merged ?? loadMerged()).tasks.filter((x) => !x.archived && inScope(x, this.scope, projects) && matchesFilter(x, this.filters, ctx) && matches(x, this.query)));
    const dflt = rs?.dflt ?? cfg("drover-board", "default_sort");
    return COLUMNS.map(([id, name]) => ({ id, name, cards: sortCards(shown.filter((x) => x.column === id), this.sort[id] ?? dflt) }));
  }

  // The columns on screen: those in visible_columns (Drover Config). Hiding is screen only: the tasks and the drover CLI keep all 6.
  columns(rs) {
    const visible = rs?.visible ?? this.visibleIds();
    return (rs?.all ?? this.allColumns(rs)).filter((col) => visible.includes(col.id));
  }

  visibleIds() { return cfg("drover-board", "visible_columns"); }

  // Cards a hidden column keeps out of sight, under the current scope, filter and search. Shown in the header so nothing hides silently.
  hiddenCount(rs) {
    const visible = rs?.visible ?? this.visibleIds();
    return (rs?.all ?? this.allColumns(rs)).filter((col) => !visible.includes(col.id)).reduce((n, col) => n + col.cards.length, 0);
  }

  // Where New puts a card: Ready, or the first visible column when Ready is hidden (a new card must show).
  newColumn() {
    const visible = this.visibleIds();
    return visible.includes("todo") ? "todo" : COLUMNS.find(([id]) => visible.includes(id))[0];
  }

  filterCtx(projects = loadProjects()) {
    return { now: Date.now(), projects, runs: loadRuns(), config: loadConfig(), tasks: load(), agentsByAddress: liveAgents(agents(), terminals()) };
  }

  // Popover reports every open change; the archive confirmation never outlives its menu.
  setPop(key, open, cx) {
    const next = menuChange(this.pop, key, open);
    if (next !== this.pop) {
      this.pop = next; this.confirm = false; this.confirmIds = [];
      this.filterView = null;
      if (this.fsearch.value()) this.fsearch.set_value("");
      if (next !== "filter") this.typing.delete(this.fsearch); // the popover unmounted its field: no blur may come
    }
    cx.notify();
  }

  dismissPops() { this.pop = null; this.confirm = false; this.confirmIds = []; this.filterView = null; this.typing.delete(this.fsearch); }

  // Collapsed columns hide their cards, so a selection inside one would act on invisible cards.
  collapse(id, cx) {
    this.collapsed.add(id);
    if (loadMerged().tasks.find((x) => x.id === this.selected)?.column === id) this.selected = null;
    cx.notify();
  }

  // Pointer moved over a card or a column body during a drag: remember the landing spot, redraw only on change.
  aim(col, before, cx) {
    if (!this.drag || (this.over?.col === col && this.over.before === before)) return;
    this.over = { col, before };
    cx.notify();
  }

  drop(col, beforeId, cx) {
    const id = this.drag; this.drag = null; this.over = null;
    const rc = id ? loadMerged().tasks.find((x) => x.id === id && x.remote) : null;
    if (rc) { const op = this.wstate(rc, "move").on ? moveOp(rc, col) : null; if (op) this.rsend(rc.project, op, cx); } // a remote card moves through the remote's inbox, to the column only
    else if (id && id !== beforeId) save(reorder(load(), id, col, beforeId));
    cx.notify();
  }

  // Remote write controls (T-MWHVWR8TIJB): the state comes from io.js, the ops from remote-write-ui.js; remote-write.js builds the request.
  wstate(card, op) { return controlState(remoteWriteState(card.project), op); }
  async rsend(localId, op, cx) { const o = await remoteSend(localId, op, cx); this.msg = outcomeText(o); cx.notify(); return o; }
  remoteScopeId(merged = loadMerged()) { return this.scope.startsWith("project:") && merged.remotes.find((r) => `project:${r.localId}` === this.scope)?.localId || null; }
  // A new card on a remote project: the read-only card view opens in "new" mode (Save sends an add).
  newRemote(column, localId) {
    const r = loadMerged().remotes.find((x) => x.localId === localId);
    edit(null, column, undefined, undefined, undefined, { new: true, id: "", title: "", desc: "", column, priority: "P2", tags: [], notes: [], project: localId, remote: { machine: r?.machine ?? "" } });
  }
  // The "New" / "+" control: local scope opens the editor, a remote scope sends an add when writes are on, else it is off with the reason.
  addControl(id, mk, localColumn, rs) {
    const rid = this.remoteScopeId(rs?.merged);
    if (!rid) return mk(null, () => edit(null, localColumn));
    const w = rs ? rs.gateOf(rid, "add") : controlState(remoteWriteState(rid), "add");
    return mk(w.on ? null : w.tip, w.on ? () => this.newRemote(localColumn, rid) : null);
  }

  isRemote(id) { return Boolean(loadMerged().tasks.find((x) => x.id === id)?.remote); }
  // The remote project the scope shows, if any: New is off there (the project lives on another machine).
  remoteScope(merged = loadMerged()) { return this.scope.startsWith("project:") && merged.remotes.some((r) => `project:${r.localId}` === this.scope); }

  key(e, cx) {
    if (this.typing.size) return; // typing in a filter field: no stop_propagation, the key must reach the field
    const cols = this.columns().filter((col) => !this.collapsed.has(col.id));
    let c = cols.findIndex((col) => col.cards.some((x) => x.id === this.selected));
    let r = c < 0 ? -1 : cols[c].cards.findIndex((x) => x.id === this.selected);
    const card = c < 0 ? null : cols[c].cards[r];
    const k = e.key;
    if (k === "n") { const rid = this.remoteScopeId(); return rid ? (controlState(remoteWriteState(rid), "add").on ? this.newRemote(this.newColumn(), rid) : undefined) : edit(null, this.newColumn()); }
    if (c < 0) { this.selected = cols.find((col) => col.cards.length)?.cards[0]?.id ?? null; return cx.notify(); }
    if (e.modifiers.shift && (k === "left" || k === "right") && card.remote) { const op = this.wstate(card, "move").on ? shiftOp(card, this.visibleIds(), k === "left" ? -1 : 1) : null; if (op) this.rsend(card.project, op, cx); return; }
    if (e.modifiers.shift && (k === "left" || k === "right")) save(shiftVisible(load(), card.id, k === "left" ? -1 : 1, this.visibleIds()));
    else if (k === "enter") return edit(card.id, undefined, undefined, undefined, undefined, card.remote ? card : undefined);
    else if (k === "s") return card.remote ? undefined : pick(card.id);
    else if (k === "up" || k === "down") r = Math.max(0, Math.min(cols[c].cards.length - 1, r + (k === "up" ? -1 : 1)));
    else if (k === "left" || k === "right") {
      const step = k === "left" ? -1 : 1;
      for (let i = c + step; i >= 0 && i < cols.length; i += step) if (cols[i].cards.length) { c = i; r = Math.min(r, cols[i].cards.length - 1); break; }
    } else return;
    if (!(e.modifiers.shift && (k === "left" || k === "right"))) this.selected = cols[c].cards[r]?.id ?? this.selected;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    { const g = gated("drover-board"); if (g) return g; } // the board has no work of its own: no timer, no fetch
    if (!this.remoteOn) { this.remoteOn = true; watchRemote(cx, () => isEnabled("drover-board")); } // only while the screen is on: reads each remote-bound project every 15 s
    const live = liveAgents(agents(), terminals());
    const icon = (id, name, action, size = 13) => div().id(id).w(22).h(22).flex().items_center().justify_center().rounded(5)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.dismissPops(); action(cx); }).child(svg(I(name)).size(size));

    // A disabled control on a remote card: dim, no action, the tooltip says why.
    const off = (id, name, tip = READONLY_TIP) => div().id(id).w(22).h(22).flex().items_center().justify_center().rounded(5).text_color(t.dim).opacity(0.5).tooltip(tip).child(svg(I(name)).size(13));
    for (const o of takeRemoteOutcomes()) this.msg = outcomeText(o); // a result that arrived after the wait
    const merged = loadMerged();
    const dismissedMap = shared(DISMISS_KEY) ?? {};
    const staleNow = (x) => merged.remotes.some((r) => r.localId === x.project && r.state !== "fresh");
    const projects = loadProjects();
    // One snapshot per render (T-MWL7FAABO29): every shared read the render needs happens here, once; nothing inside a card or column closure reads shared state.
    // It lives only in this call. The write gate of a remote project is display-only and computed once per project (it reads the projects, the cache and the pending list).
    const gates = new Map();
    const gateOf = (pid, op) => { const k = `${pid}|${op}`; if (!gates.has(k)) gates.set(k, controlState(remoteWriteState(pid), op)); return gates.get(k); };
    const rs = { projects, merged, fctx: this.filterCtx(projects), visible: this.visibleIds(), dflt: cfg("drover-board", "default_sort"), gateOf };
    rs.all = this.allColumns(rs);
    const cfg_ = rs.fctx.config;
    const hidden = this.hiddenCount(rs);
    const cols = this.columns(rs);
    const card = (x, ci) => {
      const agent = x.agent ? live.get(x.agent) : null;
      const status = x.agent ? (agent?.status ?? "gone") : null;
      const project = projectOf(x, projects);
      const pill = (key, text, color, iconName) => h_flex().id(`${key}-${x.id}`).px(8).h(20).gap(4).items_center().rounded_full().bg(t.hover)
        .text_size(11).text_color(color).when(Boolean(iconName), (el) => el.child(svg(I(iconName)).size(11))).child(text);
      const ago = updatedAgo(x.updated);
      const ro = Boolean(x.remote); // a card of a project on another machine
      const w = ro ? gateOf(x.project, "move") : null; // its write controls: on when the remote is reachable, updated and not frozen
      const shift = (dir) => ro ? (w.on ? icon(`${dir < 0 ? "l" : "r"}-${x.id}`, dir < 0 ? "chevron-left" : "chevron-right", (cx) => { const op = shiftOp(x, this.visibleIds(), dir); if (op) this.rsend(x.project, op, cx); }) : off(`${dir < 0 ? "l" : "r"}-${x.id}`, dir < 0 ? "chevron-left" : "chevron-right", w.tip))
        : icon(`${dir < 0 ? "l" : "r"}-${x.id}`, dir < 0 ? "chevron-left" : "chevron-right", () => save(shiftVisible(load(), x.id, dir, this.visibleIds())));
      const dim = ro && staleNow(x) ? 0.55 : 1;
      const prog = checklistProgress(x.desc);
      return v_flex().id(`card-${x.id}`).p(12).gap(8).rounded(12).bg(t.background).cursor_pointer()
        .border_1().border_color(this.selected === x.id ? t.accent : t.border)
        .hover((s) => s.border_color(t.input))
        .relative().opacity(this.drag === x.id ? 0.4 : dim)
        .on_mouse_move((_e, cx) => { if (this.drag) { cx.stop_propagation(); this.aim(x.column, x.id, cx); } })
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (!ro || w.on) this.drag = x.id; })
        .when(this.over?.before === x.id && this.drag !== x.id, (el) => el.child(div().absolute().top_0().left_0().right_0().h(2).rounded(1).bg(t.accent)))
        .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.drop(x.column, x.id, cx); })
        .on_click((_e, cx) => { this.selected = x.id; this.handle.focus(); edit(x.id, undefined, undefined, undefined, undefined, ro ? x : undefined); cx.notify(); })
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(div().text_color(t.dim).child(x.id))
          .child(div().flex_1())
          .child(div().text_color(PRIORITY_COLOR(t)[x.priority]).child(x.priority)))
        // gpui-kit has no line_clamp: the title is cut to ~2 lines of text and the box is capped as a guard.
        .child(div().text_size(13.5).max_h(38).overflow_hidden().child(clampText(x.title, 72)))
        .child(h_flex().gap(6).items_center().flex_wrap()
          .when(Boolean(project), (el) => el.child(pill("p", project.name, t.muted, "folder")))
          .when(ro, (el) => el.child(pill("m", x.remote.machine, t.accent, "arrow-up-right")))
          .children(x.tags.slice(0, 2).map((g) => pill(`g-${g}`, `#${g}`, t.accent)))
          .child(div().flex_1())
          .when(Boolean(x.source?.url), (el) => el.child(icon(`o-${x.id}`, "arrow-up-right", () => openUrl(x.source.url))))
          .when(ci > 0, (el) => el.child(shift(-1)))
          .when(!x.agent && x.column !== "done", (el) => el.child(ro ? off(`s-${x.id}`, "play", offTip(x.remote?.machine)) : icon(`s-${x.id}`, "play",  () => pick(x.id))))
          .when(ci < rs.visible.length - 1, (el) => el.child(shift(1))))
        .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().text_color(status && status !== "gone" ? (t[status] ?? t.blocked) : t.dim).child(ro ? (x.agentText ?? "") : footerText(x, status, cfg_)))
          .child(div().flex_none().child(ago))
          .when(prog.total > 0, (el) => el.child(div().flex_none().text_color(prog.done === prog.total ? t.done : t.muted).child(`${ringGlyph(prog.done, prog.total)} ${prog.done}/${prog.total}`))));
    };

    // Slot line: only for a LOCAL project scope, from local tasks and runs (never the filtered columns or remote merged cards). One snapshot, outside every closure.
    const slotText = (() => {
      const id = this.scope.startsWith("project:") ? this.scope.slice(8) : null;
      if (!id || !projects.some((p) => p.id === id) || this.remoteScope(merged)) return "";
      const state = liveStatuses(agents(), terminals()), alive = new Set(terminals().map((x) => x.address));
      const snap = slotSnapshot(rs.fctx.runs, rs.fctx.tasks, state, alive);
      return slotLine(snap.byProject.get(id), snap.limit);
    })();
    const scopeLabel = SCOPES.find(([id]) => id === this.scope)?.[1] ?? projects.find((p) => `project:${p.id}` === this.scope)?.name ?? "All issues";
    const topBtn = (id, text, action, active = false) => div().id(id).h(28).px(10).flex().items_center().rounded(7).text_size(12)
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.hover)).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.dismissPops(); action(cx); }).child(text);
    // Popover menus: compact rows (32px, 13px text, no wrapping), a left icon slot, dim chevron or hint on the right.
    const POP_W = 280;
    const menuBox = (id, w) => v_flex().id(id).w(w).p(4).rounded(10).bg(t.popover).border_1().border_color(t.input).text_size(13).text_color(t.foreground);
    const sep = () => div().h(1).my(4).bg(t.border);
    const mrow = (id, iconName, text, { right, chevron, check, color, action }) => h_flex().id(id).h(32).px(10).gap(10).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(div().w(15).h(15).flex_none().flex().items_center().justify_center().text_color(check ? t.foreground : t.muted)
        .when(Boolean(iconName), (el) => el.child(svg(I(iconName)).size(15))))
      .child(div().flex_1().min_w(0).truncate().whitespace_nowrap().text_color(color ?? t.foreground).child(text))
      .when(Boolean(right), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).whitespace_nowrap().child(right)))
      .when(Boolean(chevron), (el) => el.child(svg(I("chevron-right")).size(14).text_color(t.dim)));
    const scopeItem = (id, label, iconName) => mrow(`scope-${id}`, this.scope === id ? "check" : iconName, label, { check: this.scope === id, action: (cx) => { this.scope = id; this.dismissPops(); cx.notify(); } });
    const fctx = rs.fctx;
    const filterCount = Object.values(this.filters).reduce((n, v) => n + v.length, 0);
    const valueRow = (field, v) => {
      const on = (this.filters[field] ?? []).includes(v.value);
      return mrow(`fr-${field}-${v.value}`, on ? "check" : null, v.label, { check: on, action: (cx) => { this.filters = toggleFilter(this.filters, field, v.value); cx.notify(); } });
    };
    const filterMenu = () => {
      const q = this.fsearch.value().trim();
      const found = searchFilters(q, fctx);
      const sub = this.filterView ? FILTER_FIELDS.find(([id]) => id === this.filterView) : null;
      return menuBox("filter-menu", POP_W).max_h(460)
        .child(h_flex().h(36).px(10).gap(8).items_center()
          .child(svg(I("search")).size(15).text_color(t.dim))
          .child(Input.new(this.fsearch).flex_1().h(30).border_0().bg(t.popover).text_size(13)))
        .child(div().h(1).bg(t.border))
        .child(v_flex().id("filter-body").gap(1).py(4).overflow_y_scrollbar()
          .when(Boolean(sub), (el) => el
            .child(mrow("fr-back", "chevron-left", sub[1], { color: t.muted, action: (cx) => { this.filterView = null; cx.notify(); } }))
            .child(sep())
            .children(filterValues(sub[0], fctx).map((v) => valueRow(sub[0], v)))
            .when(filterValues(sub[0], fctx).length === 0, (m) => m.child(div().px(10).h(32).flex().items_center().text_size(13).text_color(t.dim).child("Nothing to filter on yet"))))
          .when(!sub, (el) => el
            .children(found.fields.map(([id, label]) => mrow(`fr-${id}`, FIELD_ICON[id], label, { chevron: true, right: this.filters[id]?.length ? String(this.filters[id].length) : null, action: (cx) => { this.filterView = id; cx.notify(); } })))
            .children(found.values.map((v) => valueRow(v.field, { ...v, label: `${v.fieldLabel}: ${v.label}` })))
            .when(found.fields.length === 0 && found.values.length === 0, (m) => m.child(div().px(10).h(32).flex().items_center().text_size(13).text_color(t.dim).child("No match")))))
        .child(div().h(1).bg(t.border))
        .child(v_flex().pt(4)
          .when(filterCount > 0, (el) => el.child(mrow("fr-clear", "x", "Clear filters", { action: (cx) => { this.filters = clearFilters(); cx.notify(); } })))
          .child(mrow("fr-advanced", "list-filter", "Switch to advanced filter", { action: () => { this.dismissPops(); this.input.focus(); } })));
    };
    const chipsRow = () => h_flex().id("filter-chips").px(12).pb(8).gap(6).items_center().flex_wrap()
      .children(filterChips(this.filters, fctx).map((c) => h_flex().id(`chip-${c.field}-${c.value}`).h(24).px(8).gap(6).items_center().rounded_full().bg(t.hover)
        .text_size(11.5).whitespace_nowrap().cursor_pointer().hover((s) => s.bg(t.selected))
        .on_click((_e, cx) => { this.filters = toggleFilter(this.filters, c.field, c.value); cx.notify(); })
        .child(svg(I(FIELD_ICON[c.field] ?? "tag")).size(12).text_color(t.dim)).child(div().text_color(t.dim).child(`${c.fieldLabel}:`)).child(div().child(c.label)).child(svg(I("x")).size(12).text_color(t.muted))))
      .child(div().id("chips-clear").h(24).px(8).flex().items_center().rounded_full().text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.filters = clearFilters(); cx.notify(); }).child("Clear"));
    // Popover: top_* pins the surface's top edge under the trigger (bottom_* would grow it upward over the trigger); mt is the gap.
    const topBar = () => h_flex().p(8).gap(8).items_center().relative()
      .child(Popover.new("pop-scope").anchor("top_left").open(this.pop === "scope").on_open_change((v, cx) => this.setPop("scope", v, cx))
        .trigger(h_flex().id("scope").h(28).px(10).gap(8).items_center().rounded(7).text_size(12.5).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .text_color(this.pop === "scope" ? t.foreground : t.muted).when(this.pop === "scope", (el) => el.bg(t.hover))
          .child(svg(I("clipboard-list")).size(15)).child(div().whitespace_nowrap().child(scopeLabel)).child(svg(I("chevron-down")).size(13)))
        .content(this.pop !== "scope" ? div() : menuBox("scope-menu", 220).mt(4)
          .children(SCOPES.map(([id, label]) => scopeItem(id, label, null)))
          .when(projects.length > 0, (m) => m.child(sep()).children(projects.map((p) => scopeItem(`project:${p.id}`, p.name, "folder"))))))
      .child(Popover.new("pop-filter").anchor("top_left").open(this.pop === "filter").on_open_change((v, cx) => this.setPop("filter", v, cx))
        .trigger(h_flex().id("filter").h(28).px(8).gap(5).items_center().rounded(7).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .text_color(this.pop === "filter" || filterCount > 0 ? t.foreground : t.muted).when(this.pop === "filter", (el) => el.bg(t.hover))
          .child(svg(I("list-filter")).size(15)).when(filterCount > 0, (el) => el.child(div().child(String(filterCount)))))
        .content(this.pop === "filter" ? filterMenu().mt(4) : div()))
      .child(Input.new(this.input).w(260).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12))
      .child(div().flex_1())
      .when(Boolean(slotText), (el) => el.child(div().id("slot-line").px(8).text_size(12).text_color(t.dim).whitespace_nowrap().child(slotText)))
      .when(hidden > 0, (el) => el.child(div().id("hidden-note").px(8).text_size(12).text_color(t.dim).whitespace_nowrap().child(`${hidden} hidden`)))
      .child(topBtn("view-board", "Board", (cx) => { this.view = "board"; cx.notify(); }, this.view === "board"))
      .child(topBtn("view-list", "List", (cx) => { this.view = "list"; cx.notify(); }, this.view === "list"))
      .child(this.addControl("new", (tip, go) => h_flex().id("new").h(28).px(12).gap(5).items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground)
        .text_size(12).when(Boolean(tip), (el) => el.opacity(0.5).tooltip(tip)).when(!tip, (el) => el.cursor_pointer().on_click(() => go())).child(svg(I("plus")).size(13)).child("New"), this.newColumn(), rs));
    // List view: the same cards under the column headers, in one scrolling list. Sort and collapse come from the column state.
    const list = () => v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(12).gap(12)
      .children(cols.map((col, ci) => {
        const folded = this.collapsed.has(col.id);
        return v_flex().id(`lcol-${col.id}`).gap(8).p(8).rounded(12).bg(t.surface)
          .child(h_flex().id(`lhead-${col.id}`).h(28).px(4).gap(8).items_center().cursor_pointer()
            .on_click((_e, cx) => { if (folded) { this.collapsed.delete(col.id); cx.notify(); } else this.collapse(col.id, cx); })
            .child(svg(I(STATUS_SVG[col.id])).size(14).text_color(t[STATUS_ICON[col.id].tone]))
            .child(div().text_size(13).font_medium().child(col.name))
            .child(div().text_size(12).text_color(t.dim).child(String(col.cards.length)))
            .child(div().flex_1())
            .child(svg(I(folded ? "chevron-right" : "chevron-down")).size(14).text_color(t.muted))
            .child(this.addControl(`ladd-${col.id}`, (tip, go) => tip ? off(`ladd-${col.id}`, "plus", tip) : icon(`ladd-${col.id}`, "plus", go), col.id, rs)))
          .when(!folded, (el) => el.children(col.cards.map((x) => card(x, ci))));
      }));

    return v_flex().id("root").size_full().bg(t.canvas).text_color(t.foreground)
      .track_focus(this.handle).on_mouse_down("left", (_e, cx) => { this.drag = null; this.over = null; cx.notify(); })
      .on_mouse_up("left", (_e, cx) => { this.drag = null; this.over = null; cx.notify(); })
      .on_mouse_move((_e, cx) => { if (this.over) { this.over = null; cx.notify(); } }) // reached only off a card or column body
      .on_hover((hovered, cx) => { if (!hovered && this.drag) { this.drag = null; this.over = null; cx.notify(); } }).on_key_down((e, cx) => this.key(e, cx))
      .child(topBar())
      .when(filterCount > 0, (el) => el.child(chipsRow()))
      .children(visibleBanners(merged.remotes, dismissedMap).map((r) => h_flex().id(`banner-${r.localId}`).mx(12).mb(8).px(12).h(32).gap(10).items_center().rounded(8).bg(t.hover).text_size(12.5)
        .text_color(r.state === "never" ? t.muted : t.blocked)
        .child(div().flex_1().min_w(0).truncate().child(`${r.name}: ${r.banner}`))
        .child(div().id(`dismiss-${r.localId}`).h(24).px(10).flex().items_center().rounded(6).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); dismissNeed({ key: bannerKey(r), reason: r.state }); cx.notify(); }).child("Dismiss"))
        .child(div().id(`retry-${r.localId}`).h(24).px(10).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
          .on_click((_e, cx) => { cx.stop_propagation(); retryRemote(r.machine, r.projectId, cx); }).child("Retry"))))
      .children(merged.remotes.filter((r) => !statusHidden(r, dismissedMap)).map((r) => div().id(`wstatus-${r.localId}`).mx(12).mb(6).text_size(11.5).text_color(t.dim)
        .child(`${r.name}: ${statusLine(remoteWriteState(r.localId))}${this.msg ? ` · ${this.msg}` : ""}`)))
      .child(this.view === "list" ? list() : h_flex().id("cols").flex_1().min_h(0).px(12).pb(12).gap(12).overflow_x_scrollbar()
        .children(cols.map((col, ci) => {
          const tone = t[STATUS_ICON[col.id].tone];
          const glyph = svg(I(STATUS_SVG[col.id])).size(14).text_color(tone);
          if (this.collapsed.has(col.id)) {
            return v_flex().id(`col-${col.id}`).flex_none().w(52).h_full().rounded(12).bg(t.surface).items_center().py(12).gap(8).cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { this.collapsed.delete(col.id); cx.notify(); })
              .child(glyph).child(div().text_size(12).text_color(t.dim).child(String(col.cards.length))).child(svg(I("chevron-right")).size(14).text_color(t.muted));
          }
          const mode = this.sort[col.id] ?? rs.dflt;
          const doneCount = col.id === "done" ? col.cards.filter((x) => !x.remote).length : 0;
          const item = (key, text, active, action, color) => mrow(`mi-${col.id}-${key}`, active ? "check" : null, text, { check: active, color, action });
          const menu = () => menuBox(`menu-${col.id}`, 220).mt(4)
            .child(div().px(10).h(24).flex().items_center().text_size(11.5).text_color(t.dim).child("Sort"))
            .children(SORT_MODES.map(([m, label]) => item(m, label, mode === m, (cx) => { this.sort[col.id] = m; this.dismissPops(); cx.notify(); })))
            .child(sep())
            .child(item("collapse", "Collapse column", false, (cx) => { this.dismissPops(); this.collapse(col.id, cx); }))
            .when(col.id === "done" && !this.confirm, (el) => el.child(item("archive", "Archive all", false, (cx) => { this.confirm = true; this.confirmIds = col.cards.filter((x) => !x.remote).map((x) => x.id); cx.notify(); }, doneCount ? t.foreground : t.dim)))
            .when(col.id === "done" && this.confirm, (el) => el.child(v_flex().gap(6).p(8)
              .child(div().text_size(13).whitespace_nowrap().child(`Archive ${this.confirmIds.length} card${this.confirmIds.length === 1 ? "" : "s"}?`))
              .child(h_flex().gap(6)
                .child(div().id("archive-confirm").h(28).px(12).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(12.5).cursor_pointer()
                  .on_click((_e, cx) => { cx.stop_propagation(); save(archiveDone(load(), Date.now(), this.confirmIds)); this.dismissPops(); cx.notify(); }).child("Confirm"))
                .child(div().id("archive-cancel").h(28).px(12).flex().items_center().rounded(6).text_size(12.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => { cx.stop_propagation(); this.confirm = false; cx.notify(); }).child("Cancel")))));
          return v_flex().id(`col-${col.id}`).flex_1().min_w(300).h_full().rounded(12).bg(t.surface)
            .child(h_flex().h(40).px(12).gap(8).items_center()
              .child(glyph)
              .child(div().text_size(13).font_medium().child(col.name))
              .child(div().text_size(12).text_color(t.dim).child(String(col.cards.length)))
              .child(div().flex_1())
              .child(Popover.new(`pop-${col.id}`).anchor("top_right").open(this.pop === `col:${col.id}`).on_open_change((v, cx) => this.setPop(`col:${col.id}`, v, cx))
                .trigger(div().id(`more-${col.id}`).w(22).h(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
                  .text_color(this.pop === `col:${col.id}` ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).child(svg(I("ellipsis")).size(15)))
                .content(this.pop === `col:${col.id}` ? menu() : div()))
              .child(this.addControl(`add-${col.id}`, (tip, go) => tip ? off(`add-${col.id}`, "plus", tip) : icon(`add-${col.id}`, "plus", go), col.id, rs)))
            .child(v_flex().id(`cards-${col.id}`).flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(8)
              .border_2().border_color(this.over?.col === col.id && this.over.before === null ? t.accent : t.surface)
              .on_mouse_move((_e, cx) => { cx.stop_propagation(); this.aim(col.id, null, cx); })
              .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.drop(col.id, null, cx); })
              .children(col.cards.map((x) => card(x, ci))));
        })));
  }
}
