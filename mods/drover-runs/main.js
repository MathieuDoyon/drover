// Drover Runs: every agent/squad run with its members' live status.
// A stopped agent is "stopped: check the result", never "done": only the person or `drover move` says review.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, theme, setShared, shared } from "herdr";
import { RUNS_KEY, runBadge, stopTargets, openCommand } from "./runs.js";
import { createRunsCache } from "./runscache.js";
import { loadRuns, edit, observeEnded, modSettings, resumeSquad, cancelResume, recoverResume, runsWorld } from "./io.js";
import { bind, isEnabled, whenLoaded, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";

const LABEL = { blocked: "Needs you", working: "Working", stopped: "Stopped: check the result", ended: "Ended" };

export default class Runs extends View {
  init(_props, cx) {
    this.confirm = null;
    this.showEnded = false;
    this.resumeBusy = null;
    bind({ shared, modSettings });
    this.started = false;
    this.stopped = false; // seen off since the last tick that was on
    // Everything render draws is derived HERE (init, a 1 s tick, after the screen's own saves), never in render: render reads this.cache.get() only.
    this.cache = createRunsCache({ read: () => runsWorld({ resume: this.showEnded }) });
    this.cache.refresh();
    // The 1 s tick: starts the screen when it is on (idempotent: also the off -> on transition, which observes again) and refreshes the cache; a repaint only when it changed.
    cx.timer.every(1000, (cx) => { this.ensureStarted(cx); if (this.started && isEnabled("drover-runs") && this.cache.refresh()) cx.notify(); });
    whenLoaded("drover-runs", cx, (cx) => this.ensureStarted(cx));
  }

  forget(id) { setShared(RUNS_KEY, loadRuns().filter((x) => x.id !== id)); }

  // After the screen's own save or toggle: derive again now, so the next render shows it without waiting for the tick.
  refreshNow() { this.cache.refresh(); }

  // Resume squad on an ended run: one click = one resumeSquad call (the flag is set before the first await). A failure is notified by resumeSquad itself.
  startResume(id, cx) {
    if (this.resumeBusy) return;
    this.resumeBusy = id;
    cx.spawn(async (cx) => { try { await resumeSquad(id); } finally { this.resumeBusy = null; this.refreshNow(); cx.notify(); } });
    cx.notify();
  }

  // Recover / Cancel of a crashed attempt. One click = one call; nothing recovers by itself.
  startRecover(id, adopt, cx) {
    if (this.resumeBusy) return;
    this.resumeBusy = id;
    cx.spawn(async (cx) => { try { await recoverResume(id, { adopt }); } finally { this.resumeBusy = null; this.refreshNow(); cx.notify(); } });
    cx.notify();
  }

  // Idempotent. Off: no observeEnded (it can kill parked workers) and no timer. On: starts once; back from off, observes again.
  ensureStarted(cx) {
    if (!isEnabled("drover-runs")) { this.stopped = this.started; return; }
    if (!cfgReady("drover-runs")) return;
    if (this.started) { if (this.stopped) { this.stopped = false; observeEnded(); } return; }
    this.started = true;
    observeEnded();
    this.cache.refresh();
    cx.timer.every(60000, (cx) => { if (!isEnabled("drover-runs")) return; observeEnded(); cx.notify(); }); // ages; saves first-observed end times
  }

  render(cx) {
    const t = theme();
    { const g = gated("drover-runs"); if (g) return g; }
    const v = this.cache.get(); // memory only: no exec, read, write, timer or spawn below this line
    const { all, slotLines, endedCount: ended, alive } = v;
    const shown = this.showEnded ? all : v.active; // both lists were derived by the cache: render only picks one
    const color = { blocked: t.blocked, working: t.working, stopped: t.done, ended: t.dim, gone: t.dim, running: t.idle, idle: t.idle, done: t.done };
    const link = (id, text, action) => div().id(id).h(22).px(7).flex().items_center().rounded(5).text_size(11.5).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground)).on_click((_e, cx) => { action(); this.refreshNow(); cx.notify(); }).child(text);

    const card = ({ r, status, waiting, task, title, startedText, rows, line, lineText, resume }) => {
      const stop = () => {
        if (this.confirm !== r.id) { this.confirm = r.id; return; }
        this.confirm = null;
        for (const a of stopTargets(r, alive)) run("terminal.kill", { terminal: a });
      };
      return v_flex().id(`run-${r.id}`).p(10).gap(6).rounded(9).bg(t.background).border_1().border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().w(8).h(8).rounded(4).bg(waiting ? t.dim : color[status]))
          .child(div().flex_1().truncate().text_size(13).child(title))
          .child(div().text_size(11).text_color(waiting ? t.dim : color[status]).child(runBadge(waiting, LABEL[status]))))
        .child(div().text_size(11).text_color(t.dim).truncate()
          .child([r.id, r.name, `started ${startedText} ago`, task ? `column ${task.column}` : "task deleted", r.worktree?.branch].filter(Boolean).join(" · ")))
        .when(Boolean(line), (el) => el.child(div().truncate().text_size(11).text_color(line.stale ? t.dim : t.muted).when(line.stale, (d) => d.opacity(0.5)).child(lineText)))
        .children(rows.map((m) => {
          const row = h_flex().id(`m-${r.id}-${m.address}`).min_h(26).px(6).pl(6 + m.depth * 14).gap(8).items_center().rounded(6)
            .when(m.dim, (el) => el.opacity(0.5))
            .when(m.focusable, (el) => el.cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => run(openCommand(m), { terminal: m.address })));
          return row
            .child(div().w(6).h(6).rounded(3).flex_none().bg(color[m.status] ?? t.idle))
            .child(div().text_size(12).flex_none().child(m.name))
            .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child([m.role, m.address].filter(Boolean).join(" · ")))
            .child(div().text_size(11).flex_none().text_color(color[m.status] ?? t.muted).child(m.status))
            .child(div().w(44).flex_none().text_size(11).text_color(t.dim).child(m.durationText));
        }))
        .child(h_flex().gap(4)
          .when(Boolean(r.space), (el) => el.child(link(`room-${r.id}`, "Open room", () => run("space.select", { id: r.space }))))
          .when(Boolean(task), (el) => el.child(link(`task-${r.id}`, "Task", () => edit(r.task))))
          .when(Boolean(r.worktree), (el) => el.child(div().flex_1().truncate().text_size(10.5).text_color(t.dim).child(r.worktree.path)))
          .when(!r.worktree, (el) => el.child(div().flex_1()))
          .when(status !== "ended", (el) => el.child(link(`stop-${r.id}`, this.confirm === r.id ? "Click again to kill all" : "Stop", stop)))
          .when(status === "ended" && (this.resumeBusy === r.id || resume?.state === "live"), (el) => el.child(link(`resume-cancel-${r.id}`, "Cancel resume", () => cancelResume(r.id))))
          .when(status === "ended" && this.resumeBusy !== r.id && resume?.state === "needs-recovery", (el) => el
            .child(div().h(22).px(7).flex().items_center().text_size(11.5).text_color(t.blocked).child("Resume needs recovery"))
            .child(div().id(`resume-recover-${r.id}`).h(22).px(7).flex().items_center().rounded(5).text_size(11.5).text_color(t.foreground).cursor_pointer().hover((x) => x.bg(t.raised))
              .on_click((_e, cx) => this.startRecover(r.id, true, cx)).child("Recover"))
            .child(div().id(`resume-abandon-${r.id}`).h(22).px(7).flex().items_center().rounded(5).text_size(11.5).text_color(t.muted).cursor_pointer().hover((x) => x.bg(t.raised))
              .on_click((_e, cx) => this.startRecover(r.id, false, cx)).child("Cancel")))
          .when(status === "ended" && this.resumeBusy !== r.id && resume?.state === "none" && resume.can, (el) => el.child(div().id(`resume-${r.id}`).h(22).px(7).flex().items_center().rounded(5).text_size(11.5).text_color(t.muted)
            .cursor_pointer().hover((x) => x.bg(t.raised).text_color(t.foreground)).on_click((_e, cx) => this.startResume(r.id, cx)).child("Resume squad")))
          .when(status === "ended", (el) => el.child(link(`forget-${r.id}`, "Forget", () => this.forget(r.id)))));
    };

    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground)
      .child(h_flex().h(36).px(12).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().text_size(13).font_semibold().child("Runs"))
        .child(link("ended", this.showEnded ? `Hide ended (${ended})` : `Show ended (${ended})`, () => { this.showEnded = !this.showEnded; })))
      .children(slotLines.map((text, i) => div().id(`slots-${i}`).px(12).py(4).text_size(11.5).text_color(t.dim).child(text)))
      .child(shown.length === 0
        ? div().p(14).text_size(12).text_color(t.dim).child(all.length ? "No active runs." : "No runs yet. Press ▶ on a task.")
        : v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8).children(shown.map(card)));
  }
}
