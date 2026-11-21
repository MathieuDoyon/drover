// Drover Jump: a dialog to jump to any card, run or project. No screen of its own: bound to a key (keys.json: "mod.open:drover-jump", opt-in from
// Drover Config > Shortcuts), it opens its own overlay. Type to filter, Up/Down move, Enter goes there, Esc closes.
// The list is derived in init and by a 1 s timer, the filter in the field's change handler; render reads memory only.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { props, closeOverlay, setShared, run, theme, spaces, panes } from "herdr";
import { jumpWorld, edit, sidebarSpace } from "./io.js";
import { createJumpCache, jumpTarget, firstKey, keepKey, moveKey, projectFilter, projectPage, queryResetKey } from "./jump.js";

const KIND = { card: "Card", run: "Run", project: "Project" };

export default class Jump extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay; // null when the host only checks the mod: do nothing
    if (this.overlay == null) return;
    this.done = false; // the one action (or close) this dialog performs
    this.sel = null; // a result key
    this.cache = createJumpCache({ read: jumpWorld });
    this.typing = false; // the field has focus: Enter is its `submit`, the bubbled root key is not a second press
    this.handled = new WeakSet(); // event objects already acted on
    this.scroll = ScrollHandle.new();
    this.cache.refresh();
    this.sel = firstKey(this.cache.get().results);
    cx.timer.every(1000, (cx) => { if (this.done) return; if (this.cache.refresh()) { this.sel = keepKey(this.cache.get().results, this.sel); this.reveal(); cx.notify(); } });
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Jump to a card, run or project…" });
    this.input.on("change", (_e, cx) => { this.cache.setQuery(this.input.value()); this.sel = firstKey(this.cache.get().results); this.reveal(); cx.notify(); });
    this.input.on("focus", () => { this.typing = true; });
    this.input.on("blur", () => { this.typing = false; });
    this.input.on("submit", (e, cx) => { cx.stop_propagation?.(); this.press(e, cx); }); // the one Enter path while the field has focus
    this.input.focus();
    this.typing = true;
    cx.timer.after?.(300, () => this.input.focus());
  }

  // Scroll the selected row into view (a request the host applies after layout; never called from render).
  reveal() {
    const i = this.cache.get().results.findIndex((x) => x.key === this.sel);
    if (i >= 0) this.scroll.scroll_to_item(i);
  }

  close() {
    if (this.done) return;
    this.done = true;
    closeOverlay(this.overlay);
  }

  key(e, cx) {
    if (!this.cache || this.done) return;
    const k = e.key;
    if (k === "escape") { cx.stop_propagation?.(); return this.close(); }
    if (k === "up" || k === "down") { this.sel = moveKey(this.cache.get().results, this.sel, k === "up" ? -1 : 1); this.reveal(); cx.stop_propagation?.(); return cx.notify(); }
    if (k === "enter") { cx.stop_propagation?.(); if (!this.typing) this.press(e, cx); } // a focused field's Enter arrives as its submit: this bubbled copy is ignored
  }

  // One press: the same event object is never acted on twice (no clock: a late duplicate and a fresh press are told apart by the path, not by time).
  press(e, cx) {
    if (e !== null && typeof e === "object") { if (this.handled.has(e)) return; this.handled.add(e); }
    this.enter(cx);
  }

  // Enter: re-read now (outside render), then act on the selected key only if it is still there. Never on a different row.
  enter(cx) {
    if (!this.cache || this.done) return;
    this.cache.refresh();
    const v = this.cache.get();
    const item = v.results.find((x) => x.key === this.sel);
    const target = item ? jumpTarget(item, v.snap) : null;
    if (!target) { this.sel = keepKey(v.results, this.sel); this.reveal(); cx.notify(); return; } // gone or nothing selected: do nothing
    this.done = true;
    try { this.go(target); } finally { closeOverlay(this.overlay); }
  }

  go(t) {
    if (t.type === "focus") run(t.command, { terminal: t.terminal });
    else if (t.type === "edit") edit(t.id, undefined, undefined, undefined, undefined, t.task ?? undefined);
    else if (t.type === "runs") this.openRuns();
    else if (t.type === "project") {
      const f = projectFilter(sidebarSpace(), t.id);
      setShared(f.key, f.value); // the Tasks panel of this space follows
      setShared(queryResetKey(sidebarSpace()), `${Date.now()}-${Math.random()}`); // and drops its text query (it reads this in its timer)
      for (const [cmd, args] of projectPage()) run(cmd, args); // the drover column, then Room + Tasks
    }
  }

  openRuns() {
    const tab = spaces().find((p) => p.active)?.tabs.find((x) => panes().some((p) => p.tab === x.id && p.mod === "drover-runs"));
    if (tab) run("tab.select", { id: tab.id });
    else run("tab.new", { name: "Runs", mod: "drover-runs" });
  }

  render(_cx) {
    if (!this.cache) return div();
    const t = theme();
    const { results } = this.cache.get(); // memory only
    const row = (x) => h_flex().id(`jump-row-${x.key}`).min_h(40).px(10).py(4).gap(8).items_center().rounded(7).cursor_pointer()
      .bg(x.key === this.sel ? t.selected : t.popover).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.sel = x.key; this.enter(cx); })
      .child(div().w(52).flex_none().text_size(10.5).text_color(t.dim).child(KIND[x.kind]))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).child(x.label))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(x.sub)));
    return v_flex().id("jump-root").size_full().bg(t.popover).text_color(t.foreground).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(div().px(10).pt(10).pb(6).child(Input.new(this.input).w_full().h(32).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(13)))
      .child(results.length
        ? v_flex().id("jump-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).px(4).pb(6).gap(1).children(results.map(row))
        : div().p(12).text_size(12).text_color(t.dim).child("No match"))
      .child(div().px(12).py(6).text_size(10.5).text_color(t.dim).child("↑↓ move · Enter go · Esc close"));
  }
}
