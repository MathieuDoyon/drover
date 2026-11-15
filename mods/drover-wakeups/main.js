// Drover Wakeups: every scheduled message as a list (name, message, schedule, status, enabled, edit).
// Delivers only to an idle/finished agent: busy waits, blocked waits for you, gone fails, paused waits.
// A failed send is never retried by itself (it may have arrived). Agents schedule with `drover wake`.
// New / Edit opens a dialog overlay of this same mod (props.wakeEdit: a wakeup id, or null for a new one).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, theme, setShared, props, closeOverlay, openOverlay, notify, shared } from "herdr";
import { WAKE_KEY, addWake, updateWake, defaultOnce, parseWhen, setStatus, setEnabled, isOpen, wakeOrder, until, summary, wakeName } from "./wake.js";
import { age } from "./sources.js";
import { loadWakes, loadRuns, load, watchInbox, watchWakes, wakeInfo, modSettings } from "./io.js";
import { bind, cfg, isEnabled, whenLoaded, load as loadCfg, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";

const FILTERS = [["open", "Waiting or sending"], ["ended", "Ended"], ["all", "All"]];
const KINDS = [["at", "At a time"], ["once", "Once"], ["every", "Every interval"]];
const WEEK = [["Mo", 1], ["Tu", 2], ["We", 3], ["Th", 4], ["Fr", 5], ["Sa", 6], ["Su", 0]]; // 0 = Sunday, as Date.getDay()
const pad = (n) => String(n).padStart(2, "0");
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const toggle = (t, id, on, action) => div().id(id).w(30).h(17).flex_none().rounded(9).p(2).cursor_pointer()
  .bg(on ? t.foreground : t.input).flex().when(on, (el) => el.justify_end())
  .on_click((_e, cx) => { action(); cx.notify(); })
  .child(div().size(13).rounded(7).bg(on ? t.background : t.muted));

const button = (t, id, text, primary, action) =>
  h_flex().id(id).h(30).px(12).items_center().rounded(7).cursor_pointer()
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5)
    .hover((s) => s.opacity(0.88)).on_click(action).child(text);

// `target`: a new wakeup aimed at that task id or terminal (the terminal fields are hidden).
export const openEditor = (id, target) => openOverlay({ mod: "drover-wakeups", kind: "dialog", modal: true, width: 540, props: { wakeEdit: id ?? null, ...(target ? { wakeTarget: target } : {}) } });

export class WakeEditor {
  constructor(cx) {
    const w = props().wakeEdit ? loadWakes().find((x) => x.id === props().wakeEdit) : null;
    this.wake = w ?? null;
    this.kind = w ? (w.sched ? "at" : w.every ? "every" : "once") : "at";
    this.days = new Set(w?.sched?.days ?? [1, 2, 3, 4, 5]);
    this.enabled = w ? w.enabled !== false : true;
    this.error = null;
    this.closed = false;
    this.name = InputState.new({ placeholder: "Name, e.g. Morning CI check", value: w?.name ?? "" });
    this.fixedTarget = props().wakeTarget ?? null; // set when opened from a task: no terminal fields
    this.target = InputState.new({ placeholder: "t12 or T-…", value: this.fixedTarget ?? w?.target ?? "" });
    this.text = TextareaState.new({ placeholder: "Message, e.g. check CI and report", value: w?.text ?? "", rows: 5 });
    this.time = InputState.new({ placeholder: "09:00", value: w?.sched?.time ?? "09:00" });
    this.date = InputState.new({ placeholder: "YYYY-MM-DD HH:MM", value: stamp(w && !w.sched && !w.every ? w.due : defaultOnce()) });
    this.minutes = InputState.new({ placeholder: "15", value: String(w?.every ? Math.round(w.every / 60000) : 15) });
    this.name.focus();
    cx.timer.after(300, () => this.name.focus());
  }

  // What addWake / updateWake take. The schedule comes from the chosen kind only.
  fields() {
    const f = { name: this.name.value(), target: this.target.value(), text: this.text.value(), enabled: this.enabled };
    if (this.kind === "at") return { ...f, sched: { time: this.time.value().trim(), days: [...this.days] } };
    if (this.kind === "every") return { ...f, every: /^\d+$/.test(this.minutes.value().trim()) ? `${this.minutes.value().trim()}m` : "?" };
    return { ...f, when: this.date.value().trim() };
  }

  submit(cx) {
    if (this.closed) return;
    // A cold dialog may not have read the inherited min repeat and expiry yet: wait for them, so Save and the CLI apply the same policy.
    if (!cfgReady("drover-wakeups") && typeof cx?.spawn === "function") { cx.spawn(async (cx) => { await loadCfg("drover-wakeups"); this.submit(cx); }); return; }
    const { enabled, ...f } = this.fields();
    const r = this.wake ? updateWake(loadWakes(), this.wake.id, { ...f, enabled }) : addWake(loadWakes(), f);
    if (r.error) { this.error = r.error; cx.notify(); return; }
    setShared(WAKE_KEY, this.wake ? r.list : r.list.map((w) => (w.id === r.wake.id ? { ...w, enabled } : w)));
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeOverlay(props().overlay);
  }

  render(_cx) {
    const t = theme();
    const label = (text) => div().pt(12).pb(5).text_size(11.5).text_color(t.dim).child(text);
    const field = (el) => el.px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
    const chip = (id, text, on, set) => h_flex().id(id).h(26).px(9).items_center().rounded(6).cursor_pointer().text_size(12)
      .border_1().border_color(on ? t.accent : t.input).bg(on ? t.raised : t.popover).text_color(on ? t.foreground : t.muted)
      .on_click((_e, cx) => { set(); cx.notify(); }).child(text);
    const row = (...els) => h_flex().gap(8).items_center().children(els);
    const schedule = this.kind === "at"
      ? row(div().text_size(12).text_color(t.muted).child("Run at"), field(Input.new(this.time).w(80).h(30)), div().text_size(12).text_color(t.dim).child("on"),
        h_flex().gap(4).children(WEEK.map(([n, d]) => chip(`d-${d}`, n, this.days.has(d), () => (this.days.has(d) ? this.days.delete(d) : this.days.add(d))))))
      : this.kind === "once"
        ? row(div().text_size(12).text_color(t.muted).child("Run on"), field(Input.new(this.date).w(170).h(30)), div().text_size(11.5).text_color(t.dim).child(`local time, ${(() => { const d = parseWhen(this.date.value()); return d ? until(d) : "invalid time"; })()}`))
        : row(div().text_size(12).text_color(t.muted).child("Run every"), field(Input.new(this.minutes).w(80).h(30)), div().text_size(12).text_color(t.muted).child("minutes"));
    return v_flex().id("wake-editor").w_full().p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(this.wake ? `Edit wakeup ${this.wake.id}` : "New wakeup"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("Name")).child(field(Input.new(this.name).h(34)))
      .when(!this.fixedTarget, (el) => el
        .child(label("Wake (terminal t12 or task T-…)")).child(field(Input.new(this.target).h(34)))
        .child(h_flex().gap(2).pt(6).flex_wrap().children(agents().slice(0, 8).map((a) =>
          chip(`pick-${a.address}`, `${a.address} ${a.tab_name}`.slice(0, 26), this.target.value() === a.address, () => this.target.set_value(a.address))))))
      .child(label("Message")).child(field(Textarea.new(this.text)).py(6))
      .child(label("Schedule"))
      .child(h_flex().gap(6).children(KINDS.map(([k, text]) => chip(`k-${k}`, text, this.kind === k, () => { this.kind = k; this.error = null; }))))
      .child(div().pt(10).child(schedule))
      .child(h_flex().pt(16).items_center().gap(10)
        .child(v_flex().flex_1().child(div().text_size(13).child("Enabled")).child(div().text_size(11.5).text_color(t.dim).child("Disabled wakeups stay saved but do not send.")))
        .child(toggle(t, "ed-enabled", this.enabled, () => (this.enabled = !this.enabled))))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(18).gap(8).child(div().flex_1())
        .child(button(t, "ed-cancel", "Cancel", false, () => this.close()))
        .child(button(t, "ed-save", "Save", true, (_e, cx) => this.submit(cx))));
  }
}

export default class Wakeups extends View {
  init(_props, cx) {
    if (props()?.overlay && "wakeEdit" in props()) {
      bind({ shared, modSettings });
      loadCfg("drover-wakeups"); // the dialog's min repeat and expiry come from the same cfg() as the screen and the CLI; never gated by enabled
      this.editor = new WakeEditor(cx);
      return;
    }
    this.filter = "open";
    this.confirm = null; // id of the wakeup whose ✕ was clicked once
    bind({ shared, modSettings });
    // CLI inbox and wakeup delivery keep running while the screen is off (decision G2: off is screen only).
    watchInbox(cx);
    watchWakes(cx);
    whenLoaded("drover-wakeups", cx, (cx) => this.ensureStarted(cx));
  }

  // Idempotent: the countdown repaint timer starts once, the first time the screen is on.
  ensureStarted(cx) {
    if (this.started || !isEnabled("drover-wakeups") || !cfgReady("drover-wakeups")) return;
    this.started = true;
    cx.timer.every(cfg("drover-wakeups", "ui_tick_seconds") * 1000, (cx) => { if (isEnabled("drover-wakeups")) cx.notify(); }); // countdowns only
  }

  render(cx) {
    if (this.editor) return this.editor.render(cx);
    const t = theme();
    this.ensureStarted(cx);
    { const g = gated("drover-wakeups"); if (g) return g; }
    const runs = loadRuns(), tasks = load();
    const wakes = loadWakes().filter((w) => this.filter === "all" || (this.filter === "open") === isOpen(w))
      .sort(wakeOrder);
    const dot = { blocked: t.blocked, working: t.working, done: t.done, idle: t.idle, running: t.idle };
    const label = FILTERS.find(([k]) => k === this.filter)[1];
    const link = (id, text, action, color = t.muted) => div().id(id).px(6).h(22).flex().items_center().rounded(5).text_size(11.5).text_color(color)
      .cursor_pointer().hover((s) => s.bg(t.raised).text_color(color === t.muted ? t.foreground : color))
      .on_click((_e, cx) => { if (!id.startsWith("x-")) this.confirm = null; action(cx); cx.notify(); }).child(text); // any other click resets the ✕ confirm
    const chip = (text, color) => div().px(6).h(18).flex_none().flex().items_center().rounded(5).bg(t.raised).text_size(11).text_color(color ?? t.muted).child(text);

    const row = (w) => {
      const info = wakeInfo(w, runs, tasks);
      const open = isOpen(w);
      const next = w.status === "scheduled" ? `Next run ${until(w.due)}` : `${w.status} ${age(w.at ?? w.created)} ago`;
      return h_flex().id(`w-${w.id}`).px(16).py(10).gap(12).items_start().text_size(13).border_b_1().border_color(t.border)
        .hover((s) => s.bg(t.hover))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(8).items_center()
            .child(div().truncate().font_medium().child(w.name || info.task?.title || wakeName(w)))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child(info.task?.id ?? w.target))
            .child(div().id(`id-${w.id}`).flex_none().text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(w.id); notify({ title: `Copied ${w.id}`, body: "" }); }).child(w.id))
            .child(chip(w.source === "agent" ? "Agent" : "You")))
          .child(div().h(32).overflow_hidden().text_size(12).text_color(t.muted).child(w.text))
          .child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim)
            .child(div().truncate().child(`${summary(w)} · ${next}`))
            .child(chip(w.status, w.status === "failed" ? t.blocked : w.status === "sent" ? t.done : null))
            .when(Boolean(w.reason), (el) => el.child(div().truncate().text_color(w.status === "failed" ? t.blocked : t.dim).child(w.reason)))
            .when(Boolean(info.address), (el) => el.child(h_flex().gap(5).items_center().flex_none()
              .child(div().size(7).rounded(4).bg(dot[info.status] ?? t.dim))
              .child(div().child([info.address, info.name].filter(Boolean).join(" · ")))))))
        .child(h_flex().flex_none().gap(6).items_center().pt(2)
          .when(w.status === "scheduled", (el) => el
            .child(toggle(t, `on-${w.id}`, w.enabled !== false, () => { this.confirm = null; setShared(WAKE_KEY, setEnabled(loadWakes(), w.id, w.enabled === false)); })))
          .when(open, (el) => el
            .child(link(`e-${w.id}`, "Edit", () => openEditor(w.id)))
            .child(link(`x-${w.id}`, this.confirm === w.id ? "Cancel wakeup?" : "✕", (cx) => {
              if (this.confirm !== w.id) { this.confirm = w.id; cx.timer.after(4000, (cx) => { if (this.confirm === w.id) { this.confirm = null; cx.notify(); } }); return; }
              this.confirm = null;
              setShared(WAKE_KEY, setStatus(loadWakes(), w.id, "cancelled", "Cancelled by you"));
            }, this.confirm === w.id ? t.blocked : t.muted)))
          .when(!open, (el) => el.child(link(`f-${w.id}`, "Forget", () => setShared(WAKE_KEY, loadWakes().filter((x) => x.id !== w.id))))));
    };

    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground)
      .child(h_flex().h(52).px(16).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().text_color(t.muted).child("⏰"))
        .child(div().id("filter").h(28).px(8).flex().items_center().rounded(6).text_size(14).font_medium().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.confirm = null; const i = FILTERS.findIndex(([k]) => k === this.filter); this.filter = FILTERS[(i + 1) % FILTERS.length][0]; cx.notify(); })
          .child(`${label} ▾`))
        .child(div().text_size(12).text_color(t.dim).child(String(wakes.length)))
        .child(div().flex_1())
        .child(button(t, "new", "+ New", true, () => openEditor(null))))
      .child(v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(wakes.map(row))
        .when(wakes.length === 0, (el) => el.child(div().p(16).text_size(12.5).text_color(t.dim)
          .child(this.filter === "open" ? "Nothing waiting. Press + New or ask an agent to run `drover wake`." : "Nothing here."))));
  }
}
