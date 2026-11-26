// Drover Needs you: the page of the cards that wait for the owner, oldest first, all projects (no filters). One of the three pages of the
// `drover` column (Room, Tasks, Needs you; see _lib/needsnav.js). The cache is derived in init and by a 1 s timer, never in render.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, theme, shared, spaces, panes } from "herdr";
import { loadProjects, startNeeds, edit, watchWakes, pick, resumeSquad, dismissNeed, restoreNeed, removeWake, retryWakeNow, sendHelp } from "./io.js";
import { projectOf } from "./store.js";
import { runPage } from "./needsnav.js";

export default class Needs extends View {
  init(_props, cx) {
    watchWakes(cx); // a cold persisted Needs page may be the only open view: it delivers/expires wakeups itself (the "sending" claim stops a double send)
    this.showHidden = false; // the Dismissed list
    this.sendFor = null; // key of the row whose "send to agent" picker is open
    this.cache = startNeeds(cx); // no remote watch: a remote card's agent is cleared on load, so it never waits on the owner
  }

  // Back to Room + Tasks, then the card: its live agent in Room, else the card editor (a remote card: the read-only view).
  open(task) {
    runPage(run, "room");
    if (task.remote) edit(task.id, undefined, undefined, undefined, undefined, task);
    else if (task.agent && this.cache.get().agentAddrs.has(task.agent)) run("agent.focus", { terminal: task.agent });
    else edit(task.id);
  }

  // A failed wakeup: its screen (the Wakeups tab if it is open, else a new one), where the owner re-schedules or deletes it.
  openWakeups() {
    const tab = spaces().find((p) => p.active)?.tabs.find((x) => panes().some((p) => p.tab === x.id && p.mod === "drover-wakeups"));
    if (tab) run("tab.select", { id: tab.id });
    else run("tab.new", { name: "Wakeups", mod: "drover-wakeups" });
  }

  // Button handlers: the click stops at the button (the row click would open the card).
  // `c` is the click's own context: valid for this call only. Work that awaits runs in c.spawn, and only the context it hands over (acx) is used after an await.
  act(c, f) { c.stop_propagation(); f(c); c.notify(); }
  resume(id, c) { c.spawn(async (acx) => { try { await resumeSquad(id); } finally { acx.notify(); } }); } // resumeSquad refuses and notifies by itself
  send(address, task, reason, c) { this.sendFor = null; c.spawn(async (acx) => { try { await sendHelp(address, task, reason); } finally { acx.notify(); } }); }

  render() {
    const t = theme();
    const v = this.cache.get(); // memory only
    const items = v.attention; // cards that wait for the owner and failed wakeups, oldest first
    const projects = loadProjects();
    const btn = (id, label, tip, f) => div().id(id).h(20).px(7).flex_none().flex().items_center().rounded(5).text_size(11).text_color(t.muted).cursor_pointer()
      .hover((x) => x.bg(t.raised).text_color(t.foreground)).tooltip(tip).on_click((_e, c) => this.act(c, f)).child(label);
    const dot = () => div().w(7).h(7).flex_none().rounded(4).bg(t.blocked);
    const wakeRow = (a, hidden) => h_flex().id(hidden ? `needhid-${a.key}` : `need-${a.key}`).min_h(44).px(10).py(5).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => this.openWakeups())
      .child(dot())
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).child(a.wake.name || `Wakeup for ${a.wake.target}`))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child([a.reason, a.wake.target, a.wake.reason].filter(Boolean).join(" · "))))
      .child(hidden ? btn(`needact-restore-${a.key}`, "Restore", "Show it again", () => restoreNeed(a.key)) : h_flex().gap(2).flex_none()
        .child(btn(`needact-wake-retry-${a.wake.id}`, "Retry", "Schedule it again now", () => retryWakeNow(a.wake.id)))
        .child(btn(`needact-wake-rm-${a.wake.id}`, "Remove", "Delete the wakeup", () => removeWake(a.wake.id)))
        .child(btn(`needact-dismiss-${a.key}`, "Dismiss", "Hide it until its reason changes", () => dismissNeed(a))));
    const picker = (a, task) => v_flex().id(`needact-send-list-${a.key}`).pl(25).pb(4).gap(1)
      .children([...v.live.keys()].filter((ad) => v.agentAddrs.has(ad)).map((ad) => btn(`needact-send-to-${a.key}-${ad}`, `${ad} · ${v.live.get(ad)?.status ?? ""}`, "Send the card to this agent", (c) => this.send(ad, task, a.reason, c)))
        .concat(v.agentAddrs.size ? [] : [div().text_size(10.5).text_color(t.dim).child("No live agent")]));
    const row = (a, hidden) => {
      if (a.kind === "wake") return wakeRow(a, hidden);
      const id = a.key, task = v.byId.get(id), at = v.rows.get(id), local = !task.remote;
      const live = task.agent && v.agentAddrs.has(task.agent);
      const line = h_flex().id(hidden ? `needhid-${id}` : `need-${id}`).min_h(44).px(10).py(5).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => this.open(task))
        .child(dot())
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).child(task.title))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child([a.reason, task.id, projectOf(task, projects)?.name, task.remote?.machine].filter(Boolean).join(" · "))))
        .child(hidden ? btn(`needact-restore-${id}`, "Restore", "Show it again", () => restoreNeed(id)) : h_flex().gap(2).flex_none().flex_wrap()
          .when(local && a.gone, (el) => el.child(btn(`needact-resume-${id}`, "Resume", "Reopen the gone squad", (c) => this.resume(task.id, c)))
            .child(btn(`needact-start-${id}`, "Start", "Start a new agent on the card", () => pick(task.id))))
          .when(!a.gone && live, (el) => el.child(btn(`needact-focus-${id}`, "Focus", "Show its terminal", () => run("agent.focus", { terminal: task.agent }))))
          .when(local, (el) => el.child(btn(`needact-send-${id}`, "Send", "Ask a live agent to help", () => { this.sendFor = this.sendFor === id ? null : id; })))
          .child(btn(`needact-dismiss-${id}`, "Dismiss", "Hide it until its reason changes", () => dismissNeed(a))));
      return !hidden && local && this.sendFor === id ? v_flex().child(line).child(picker(a, task)) : line;
    };
    const dismissedN = v.hidden.length;
    return v_flex().id("needs-root").size_full().bg(t.chrome).text_color(t.foreground)
      .child(h_flex().h(34).px(10).items_center().gap(6)
        .child(div().flex_1().text_size(12.5).font_semibold().child("Needs you"))
        .when(dismissedN > 0 || this.showHidden, (el) => el.child(btn("needs-dismissed-toggle", this.showHidden ? "Hide dismissed" : `Dismissed ${dismissedN}`, "Show or hide the dismissed rows", () => { this.showHidden = !this.showHidden; })))
        .child(div().id("needs-count").text_size(11.5).text_color(t.muted).child(String(items.length))))
      .child(items.length
        ? v_flex().id("needs-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(8).gap(1).children(items.map((a) => row(a, false)))
        : div().p(12).text_size(12).text_color(t.dim).child("Nothing needs you"))
      .when(this.showHidden && dismissedN > 0, (el) => el.child(v_flex().id("needs-hidden-list").px(4).pb(8).gap(1).opacity(0.7).children(v.hidden.map((a) => row(a, true)))));
  }
}
