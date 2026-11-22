// Drover Tabs: capsule tabs with agent status, an agent selector and the Tasks column toggle.
// Made for the "drover" layout (a copy of main with a right "drover" column). Based on the shipped tabs mod.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, closeOverlay, props, theme, window, layout, settings, shared, setBadge } from "herdr";
import { RUNS_KEY, openCommand } from "./runs.js";
import { bind, isEnabled, load as loadCfg, cfg, ready as cfgReady } from "./config.js";
import { createDockBadge } from "./dockbadge.js";
import { modSettings, startNeeds } from "./io.js";
import { runPage } from "./needsnav.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const STATUS = { blocked: "needs you", working: "working", done: "done" };

// Every Drover screen. A screen already open as a tab in this space is selected, else a new tab opens.
const SCREENS = [
  ["Todos", "drover-todos"], ["Board", "drover-board"], ["Jira", "drover-jira"], ["GitHub", "drover-github"],
  ["Squads", "drover-agents"], ["Runs", "drover-runs"], ["Wakeups", "drover-wakeups"], ["Projects", "drover-projects"], ["Reader", "drover-reader"],
];

// Tabs with 2 screens side by side. A tab with that name that already shows the right screen is selected.
const PRESETS = [
  ["Sources", "drover-jira", "drover-github"], ["Squads", "drover-agents", "drover-runs"], ["Work", "drover-board", "drover-tasks"],
];

function openPreset(name, left, right) {
  const tab = spaces().find((p) => p.active)?.tabs.find((x) => x.name === name && panes().some((p) => p.tab === x.id && p.mod === right));
  if (tab) return run("tab.select", { id: tab.id });
  run("tab.new", { name, mod: left });
  run("pane.split", { direction: "right", mod: right }); // the new tab's pane has the focus
}

function openScreen(name, mod) {
  const space = spaces().find((p) => p.active);
  const tab = space?.tabs.find((x) => panes().some((p) => p.tab === x.id && p.mod === mod));
  if (tab) run("tab.select", { id: tab.id });
  else run("tab.new", { name, mod });
}

// Popups opened from the bar: props.menu = "drover" (screens) or "agents" (every agent, click to go).
function menu(kind) {
  const t = theme(), close = () => closeOverlay(props().overlay);
  const row = (id, action) => h_flex().id(id).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_click(() => { action(); close(); });
  const dot = { blocked: t.blocked, working: t.working, done: t.done };
  // Split buttons put the screen in a new pane beside the focused pane of the current tab.
  const split = (id, label, direction, mod) => div().id(id).px(6).h(22).flex().items_center().rounded(5).text_size(11.5).text_color(t.dim)
    .hover((s) => s.bg(t.raised).text_color(t.foreground))
    .on_click((_e, cx) => { cx.stop_propagation(); run("pane.split", { direction, mod }); close(); }).child(label);
  const head = (text) => div().px(10).pt(8).pb(2).text_size(11).text_color(t.dim).child(text);
  // Parked workers have no tab: the menu peeks them in a modal instead of focusing.
  const parked = new Map((Array.isArray(shared(RUNS_KEY)) ? shared(RUNS_KEY) : []).flatMap((r) => (r.terminals ?? []).filter((t) => t.parked).map((t) => [t.address, t.role])));
  const rows = kind === "drover"
    ? [head("Open as a tab · or split the current pane"),
      // A screen is offered only when decided ON: not while its settings load, and a shared false hides at once.
      ...SCREENS.filter(([, mod]) => isEnabled(mod)).map(([name, mod]) => row(`s-${mod}`, () => openScreen(name, mod))
        .child(div().flex_1().text_size(13).child(name))
        .child(split(`r-${mod}`, "Split →", "right", mod)).child(split(`d-${mod}`, "↓", "down", mod))),
      head("Tabs with 2 screens"),
      // A tab with 2 screens needs both on (Tasks in Work is the right screen).
      ...PRESETS.filter(([, left, right]) => isEnabled(left) && isEnabled(right)).map(([name, left, right]) => row(`p-${name}`, () => openPreset(name, left, right))
        .child(div().text_size(13).child(name))
        .child(div().text_size(11).text_color(t.dim).child(`${SCREENS.find((x) => x[1] === left)[0]} | ${SCREENS.find((x) => x[1] === right)?.[0] ?? "Tasks"}`))),
      head("Settings"),
      row("s-config", () => openOverlay({ mod: "drover-config", kind: "dialog", width: 860, height: 620 }))
        .child(div().flex_1().text_size(13).child("Config"))]
    : agents().sort((a, b) => b.seq - a.seq).map((a) => row(`a-${a.address}`, () => run(openCommand({ parked: parked.has(a.address), role: parked.get(a.address) ?? null }), { terminal: a.address }))
      .child(div().size(7).rounded(4).flex_none().bg(dot[a.status] ?? t.idle))
      .child(div().flex_1().truncate().text_size(12.5).child(a.tab_name))
      .child(div().text_size(11).text_color(t.dim).truncate().max_w(120).child(`${a.space_name} · ${a.address}`))
      .child(div().w(62).text_size(11).text_color(dot[a.status] ?? t.muted).child(STATUS[a.status] ?? a.status)));
  return v_flex().id("menu").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).overflow_y_scrollbar()
    .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
    .children(rows.length ? rows : [div().p(10).text_size(12).text_color(t.dim).child("No agents.")]);
}

export default class DroverTabs extends View {
  init(_props, cx) {
    bind({ shared, modSettings }); // the screens' on/off switches live in shared "drover.config"; read live on each render
    // Each screen's own mod.json `enabled` is the layer under that override: load them all, then repaint. Until then (or if a screen is still loading) its entry is not offered; a shared override decides at once.
    // Concurrently, each in its own task, with a repaint as each settles: one stuck read hides only its own screen.
    for (const [, mod] of [...SCREENS, ["Tasks", "drover-tasks"], ["Tabs", "drover-tabs"]]) cx.spawn(async (cx) => { await loadCfg(mod); cx.notify(); });
    this.needs = startNeeds(cx); // the chip count: own cache and 1 s timer, read-only in render
    // The Dock badge (T-MWO6FADBCH4): THIS bar copy is the only writer of setBadge. A popup copy of this mod (props.menu: the Drover and Agents menus) never
    // writes or clears it. The write runs from this 1 s timer and from close(), never from render; it reads the cache's memory and the setting (it waits for the mod.json layer).
    this.badge = null;
    if (!props()?.menu) {
      this.badge = createDockBadge({
        count: () => this.needs.get().counts.needs,
        enabled: () => cfg("drover-tabs", "dock_badge") !== false,
        setBadge: (text) => setBadge(text),
      });
      const sync = () => { if (cfgReady("drover-tabs")) this.badge.sync(); }; // nothing is written before the mod.json layer is known
      cx.timer.every(1000, sync);
      sync();
    }
    this.pressed = null; // index of the tab pressed; release on another tab moves it there
    this.scroll = ScrollHandle.new();
  }

  // The host closes the bar copy at quit: clear the badge (a popup copy has none).
  async close(_cx) { this.badge?.clear(); }

  render() {
    if (props()?.menu) return menu(props().menu);
    const t = theme();
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex((tab) => tab.active);
    if (shown[active]?.id !== this.selected) {
      this.selected = shown[active]?.id;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const capsule = (id, on) => h_flex().id(id).h(28).px(12).gap(7).flex_none().items_center().rounded(14).text_size(12.5)
      .border(1).border_color(on ? t.accent : t.border).bg(on ? t.raised : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop);

    const item = (c, i) => {
      const program = panes().find((p) => p.tab === c.id && p.program?.agent)?.program ?? panes().find((p) => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return capsule(`tab-${c.id}`, c.active)
        .when(this.pressed !== null && this.pressed !== i, (el) => el.hover((s) => s.border_color(t.accent)))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); cx.notify(); })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: i + 1 });
          else run("tab.select", { id: c.id });
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), (el) => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", (el) => el.child(div().size(7).rounded(4).bg(t[c.status])))
        .when(c.active, (el) => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };

    // Agent selector: counts by status; click opens every agent in a popup.
    const all = agents();
    const blocked = all.filter((a) => a.status === "blocked").length, working = all.filter((a) => a.status === "working").length;
    const selector = capsule("agents", false)
      .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "drover-tabs", kind: "popup", width: 420, height: 420, props: { menu: "agents" } }); })
      .child(div().child(`Agents ${all.length}`))
      .when(blocked > 0, (el) => el.child(div().text_color(t.blocked).child(`● ${blocked} ${STATUS.blocked}`)))
      .when(working > 0, (el) => el.child(div().text_color(t.working).child(`● ${working}`)));

    const root = layout(), sidebar = find(root, "sidebar"), column = find(root, "drover"), w = window();
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    // Tasks off: this capsule does nothing and the column stays as it is (empty). The owner's cmd-alt-b is bound in keys.json
    // straight to layout.toggle, which a mod cannot gate: it still toggles the empty column. Do not edit keys.json from here.
    const needsN = this.needs.get().counts.needs; // memory only: the cache is refreshed by its timer
    const tasksOn = column && !column.hidden && isEnabled("drover-tasks");

    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(6).items_center().bg(t.canvas ?? t.chrome)
      .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
      .on_scroll_wheel((e) => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(6).overflow_x_scrollbar().track_scroll(this.scroll)
        .children(shown.map(item))
        .child(capsule("tab-new", false).px(10).on_click(() => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })).child("+")))
      .child(capsule("drover", false).on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "drover-tabs", kind: "popup", width: 280, height: 530, props: { menu: "drover" } }); }).child("Drover ▾"))
      .child(selector)
      .when(needsN > 0, (el) => el.child(capsule("needs-chip", false).px(9).text_color(t.blocked).on_click((_e, cx) => { cx.stop_propagation(); runPage(run, "needs"); }).child(String(needsN))))
      .when(Boolean(column), (el) => el.child(capsule("tasks", tasksOn).on_click(() => { if (isEnabled("drover-tasks")) run("layout.toggle", { id: "drover" }); }).child("Tasks")))
      .when(w?.buttons, (el) => el.child(capsule("close-window", false).px(10).on_click(() => run("window.close")).child(svg("mods/pane/close.svg").size(12))));
  }
}
