// Drover Needs you: the page of the cards that wait for the owner, oldest first, all projects (no filters). One of the three pages of the
// `drover` column (Room, Tasks, Needs you; see _lib/needsnav.js). The cache is derived in init and by a 1 s timer, never in render.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, theme, shared, spaces, panes } from "herdr";
import { loadProjects, startNeeds, edit, watchWakes } from "./io.js";
import { projectOf } from "./store.js";
import { runPage } from "./needsnav.js";

export default class Needs extends View {
  init(_props, cx) {
    watchWakes(cx); // a cold persisted Needs page may be the only open view: it delivers/expires wakeups itself (the "sending" claim stops a double send)
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

  render() {
    const t = theme();
    const v = this.cache.get(); // memory only
    const items = v.attention; // cards that wait for the owner and failed wakeups, oldest first
    const projects = loadProjects();
    const wakeRow = (a) => h_flex().id(`need-${a.key}`).min_h(44).px(10).py(5).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => this.openWakeups())
      .child(div().w(7).h(7).flex_none().rounded(4).bg(t.blocked))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).child(a.wake.name || `Wakeup for ${a.wake.target}`))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child([a.reason, a.wake.target, a.wake.reason].filter(Boolean).join(" · "))));
    const row = (a) => {
      if (a.kind === "wake") return wakeRow(a);
      const id = a.key, task = v.byId.get(id), at = v.rows.get(id);
      return h_flex().id(`need-${id}`).min_h(44).px(10).py(5).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => this.open(task))
        .child(div().w(7).h(7).flex_none().rounded(4).bg(t.blocked))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).child(task.title))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child([at.reason, task.id, projectOf(task, projects)?.name, task.remote?.machine].filter(Boolean).join(" · "))));
    };
    return v_flex().id("needs-root").size_full().bg(t.chrome).text_color(t.foreground)
      .child(h_flex().h(34).px(10).items_center().gap(6)
        .child(div().flex_1().text_size(12.5).font_semibold().child("Needs you"))
        .child(div().id("needs-count").text_size(11.5).text_color(t.muted).child(String(items.length))))
      .child(items.length
        ? v_flex().id("needs-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(8).gap(1).children(items.map(row))
        : div().p(12).text_size(12).text_color(t.dim).child("Nothing needs you"));
  }
}
