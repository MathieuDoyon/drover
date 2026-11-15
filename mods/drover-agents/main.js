// Drover Agents & Squads: agent profiles (command + instructions) and squads (leader + members).
// Dialog modes: props.pick (▶ on a task), props.agent / props.squad (editors).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Popover } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, shared, setShared, notify, exec, appHome, hc, focused } from "herdr";
import { AGENTS_KEY, START_IN_KEY, saveAgent, saveSquad, removeFrom, addDefaults, defaultDrover, droverLabel, envProblem } from "./runs.js";
import { bind, isEnabled, whenLoaded, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";
import { load, loadConfig, loadRuns, loadProjects, launch, startFromSquads, droverList, startDefaults, observeEnded, readEnvNames, writeAgentEnv, deleteAgentEnv, envCounts, modSettings } from "./io.js";

const LAST = "drover.agents.last";
const close = () => closeOverlay(props().overlay);
const dialog = (p) => openOverlay({ mod: "drover-agents", kind: "dialog", width: 520, props: p });

function commit(result, cx, self) {
  if (result.error) { self.error = result.error; return cx.notify(); }
  setShared(AGENTS_KEY, result.config);
  close();
}

const ui = (t) => ({
  label: (text) => div().pt(12).pb(5).text_size(11.5).text_color(t.dim).child(text),
  field: (el) => el.px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground),
  button: (id, text, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(7).cursor_pointer()
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5)
    .hover((s) => s.opacity(0.88)).on_click(action).child(text),
  chip: (id, text, on, action) => h_flex().id(id).h(26).px(9).items_center().rounded(6).cursor_pointer().text_size(12)
    .border_1().border_color(on ? t.accent : t.input).text_color(on ? t.foreground : t.muted)
    .on_click(action).child(text),
  frame: (title, ...children) => v_flex().id("dialog").w_full().max_h_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
    .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
    .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(title))
      .child(div().text_size(11).text_color(t.dim).child("Esc")))
    .children(children),
});

// Environment rows. A saved variable is only a name here: its value is never read into the UI ("set" + Replace).
// A row has { key, name: InputState (new rows), nameText, saved, replacing, value: InputState (new or replacing) }.
class AgentEditor {
  constructor() {
    this.agent = loadConfig().agents.find((a) => a.id === props().agent) ?? null;
    const a = this.agent ?? { name: "", command: "claude", instructions: "" };
    this.name = InputState.new({ placeholder: "Opus dev", value: a.name });
    this.command = InputState.new({ placeholder: "claude --model claude-opus-5-5", value: a.command });
    this.instructions = TextareaState.new({ placeholder: "Soul / standing instructions, sent before every task", value: a.instructions, rows: 6 });
    this.error = null;
    this.rows = [];
    this.savedNames = [];
    this.envError = null;
    this.keys = 0;
    this.busy = false;
    this.name.focus();
  }
  // Called once with a live context: reads the saved variable names (never values).
  async load() {
    if (!this.agent) return;
    const r = await readEnvNames(this.agent.id);
    if (r.error) { this.envError = r.error; return; }
    this.savedNames = r.names;
    this.rows = r.names.map((n) => ({ key: ++this.keys, nameText: n, saved: true, replacing: false }));
  }
  masked() { const v = InputState.new({ placeholder: "value" }); v.set_masked(true); return v; }
  addRow() {
    const row = { key: ++this.keys, name: InputState.new({ placeholder: "NAME" }), nameText: "", saved: false, replacing: false, value: this.masked() };
    this.rows.push(row);
    return row;
  }
  removeRow(key) { this.rows = this.rows.filter((r) => r.key !== key); }
  replaceRow(key) {
    const row = this.rows.find((r) => r.key === key);
    if (row && row.saved && !row.replacing) { row.replacing = true; row.value = this.masked(); }
  }
  // [{ name, value }] for writeAgentEnv, or null when the env is untouched. Blank new rows are ignored.
  envRows() {
    const rows = this.rows.map((r) => ({ r, name: (r.saved ? r.nameText : r.name.value()).trim(), value: r.value ? r.value.value() : "" }))
      .filter((x) => x.r.saved || x.name || x.value).map((x) => ({ name: x.name, value: x.value }));
    const same = rows.length === this.savedNames.length && rows.every((x, i) => x.name === this.savedNames[i] && !x.value);
    return same ? null : rows;
  }
  // Order: profile check (pure), env write, then the one setShared (no value in it). A failed step saves nothing.
  save(cx) {
    if (this.busy) return;
    const a = this.agent, rows = this.envRows();
    const names = rows?.map((r) => r.name);
    const problem = rows ? envProblem(names) : null;
    if (problem) { this.error = problem; return cx.notify(); }
    const event = rows ? { at: new Date().toISOString(), action: rows.length ? "set" : "clear", names } : undefined;
    const result = saveAgent(loadConfig(), { id: a?.id, name: this.name.value(), command: this.command.value(), instructions: this.instructions.value(), envEvent: event });
    if (result.error) { this.error = result.error; return cx.notify(); }
    if (!rows) return commit(result, cx, this);
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      let w;
      try { w = await writeAgentEnv(result.agent.id, rows); }
      catch { w = { error: "Could not save the environment" }; }
      finally { this.busy = false; }
      if (w.error) { this.error = w.error; return cx.notify(); }
      commit(result, cx, this);
    });
  }
  // The agent and its env file go together. A squad using the agent keeps both.
  remove(cx) {
    if (this.busy) return;
    const result = removeFrom(loadConfig(), "agents", this.agent.id);
    if (result.error) { this.error = result.error; return cx.notify(); }
    this.busy = true;
    cx.spawn(async (cx) => {
      let e = null;
      try { e = await deleteAgentEnv(this.agent.id); }
      catch { e = "the helper failed"; }
      finally { this.busy = false; }
      if (e) { this.error = `Could not remove the environment file: ${e}`; return cx.notify(); }
      commit(result, cx, this);
    });
  }
  envSection(t, u) {
    const row = (r) => h_flex().id(`env-${r.key}`).gap(6).items_center()
      .child(r.saved ? div().w(130).flex_none().truncate().text_size(12.5).child(r.nameText) : u.field(Input.new(r.name).w(130).flex_none().h(30)))
      .child(r.saved && !r.replacing
        ? h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().text_size(12).text_color(t.dim).child("set"))
          .child(u.button(`rep-${r.key}`, "Replace", false, (_e, cx) => { this.replaceRow(r.key); cx.notify(); }))
        : u.field(Input.new(r.value).flex_1().h(30)))
      .child(u.button(`rm-${r.key}`, "✕", false, (_e, cx) => { this.removeRow(r.key); cx.notify(); }));
    return v_flex().gap(6)
      .child(u.label("Environment (variables for this agent only; saved values are never shown again)"))
      .child(this.envError ? div().text_size(12).text_color(t.blocked).child(`Environment file problem: ${this.envError}`) : div())
      .children(this.rows.map(row))
      .child(h_flex().child(u.button("add-env", "+ Variable", false, (_e, cx) => { this.addRow(); cx.notify(); })))
      .children((this.agent?.envLog ?? []).length
        ? [div().pt(6).text_size(11).text_color(t.dim).child("Environment changes (names only)"),
          ...this.agent.envLog.slice().reverse().map((l) => div().text_size(11).text_color(t.dim).child(l))] : []);
  }
  render(cx) {
    const t = theme(), u = ui(t), a = this.agent;
    return u.frame(a ? `Agent ${a.id} · v${a.version}` : "New agent",
      u.label("Name"), u.field(Input.new(this.name).h(34)),
      u.label("Command (no shell quoting)"), u.field(Input.new(this.command).h(34)),
      ...(a?.soul ? [u.label("Soul (sent first; edit the file to change it)"),
        h_flex().id("soul").h(34).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(() => exec("open", ["-t", `${appHome()}/mods/drover-agents/souls/${a.soul}.md`]))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(`souls/${a.soul}.md + souls/_herd.md`))
          .child(div().flex_none().text_size(11.5).text_color(t.muted).child("Open ↗"))] : []),
      u.label(a?.soul ? "Extra instructions (sent after the soul)" : "Instructions"), u.field(Textarea.new(this.instructions)).py(6),
      this.envSection(t, u),
      this.error ? div().pt(10).text_size(12).text_color(t.blocked).child(this.error) : div(),
      h_flex().pt(18).gap(8)
        .when(Boolean(a), (el) => el.child(u.button("del", "Delete", false, (_e, cx) => this.remove(cx))))
        .child(div().flex_1()).child(u.button("cancel", "Cancel", false, close)).child(u.button("save", "Save", true, (_e, cx) => this.save(cx))));
  }
}

class SquadEditor {
  constructor() {
    const cfg = loadConfig();
    this.squad = cfg.squads.find((s) => s.id === props().squad) ?? null;
    const s = this.squad ?? { name: "", leader: cfg.agents[0]?.id, members: [] };
    this.name = InputState.new({ placeholder: "Dev + Reviewer", value: s.name });
    this.leader = s.leader;
    this.roles = new Map(s.members.map((m) => [m.agent, InputState.new({ placeholder: "Role", value: m.role })]));
    this.error = null;
    this.name.focus();
  }
  render(cx) {
    const t = theme(), u = ui(t), s = this.squad, agents = loadConfig().agents;
    const save = (_e, cx) => commit(saveSquad(loadConfig(), {
      id: s?.id, name: this.name.value(), leader: this.leader,
      members: [...this.roles].map(([agent, role]) => ({ agent, role: role.value() })),
    }), cx, this);
    return u.frame(s ? `Squad ${s.id} · v${s.version}` : "New squad",
      u.label("Name"), u.field(Input.new(this.name).h(34)),
      u.label("Leader (gets the task, drives the members)"),
      h_flex().gap(6).flex_wrap().children(agents.map((a) => u.chip(`l-${a.id}`, a.name, this.leader === a.id, (_e, cx) => { this.leader = a.id; cx.notify(); }))),
      u.label("Members (click to add or remove)"),
      h_flex().gap(6).flex_wrap().children(agents.map((a) => u.chip(`m-${a.id}`, a.name, this.roles.has(a.id), (_e, cx) => {
        if (this.roles.has(a.id)) this.roles.delete(a.id); else this.roles.set(a.id, InputState.new({ placeholder: "Role" }));
        cx.notify();
      }))),
      v_flex().pt(6).gap(6).children([...this.roles].map(([id, role]) => h_flex().gap(8).items_center()
        .child(div().w(90).truncate().text_size(12).text_color(t.muted).child(agents.find((a) => a.id === id)?.name ?? id))
        .child(u.field(Input.new(role).flex_1().h(30))))),
      this.error ? div().pt(10).text_size(12).text_color(t.blocked).child(this.error) : div(),
      h_flex().pt(18).gap(8)
        .when(Boolean(s), (el) => el.child(u.button("del", "Delete", false, (_e, cx) => commit(removeFrom(loadConfig(), "squads", s.id), cx, this))))
        .child(div().flex_1()).child(u.button("cancel", "Cancel", false, close)).child(u.button("save", "Save", true, save)));
  }
}

// Start dialog. Each choice resolves: what the person clicked, else what was used last (drover.agents.last), else the configured
// default (drover-config), else today's built-in. Read on each render, so the mod.json layer applies when it finishes loading and a
// click is never overwritten by it.
class Picker {
  // space: where the Todos sidebar is shown (the focused space when the picker opens); the Drover chosen here is for this launch only.
  constructor() { this.picked = {}; this.space = focused()?.space ?? null; this.menu = false; }
  get runner() { return this.picked.runner ?? startDefaults().runner; }
  set runner(v) { this.picked.runner = v; }
  get worktree() { return this.picked.worktree ?? startDefaults().worktree; }
  set worktree(v) { this.picked.worktree = v; }
  get report() { return this.picked.report ?? startDefaults().report; }
  set report(v) { this.picked.report = v; }
  droverAt(list = droverList()) { const p = this.picked.drover; return list.some((c) => c.address === p) ? p : defaultDrover(list, this.space); }
  // Stays open until launch ends: a closed overlay's tasks get cancelled.
  start(_e, cx, task = load().find((x) => x.id === props().pick)) {
    if (this.busy) return;
    this.busy = true;
    const runner = this.runner, worktree = this.worktree, report = this.report;
    setShared(LAST, { runner, worktree, report });
    const reportTo = report ? this.droverAt() : null;
    cx.notify();
    cx.spawn(async () => {
      const run = await launch(task, runner, { worktree, reportTo });
      // launch stays silent when reportTo is set (the CLI gets the error): the picker shows it.
      if (run.error && reportTo) notify({ title: `${task.id} not started`, body: run.error, level: "error" });
      else if (reportTo) {
        const lead = run.terminals[run.terminals.length - 1];
        await hc(["send", reportTo, `STATUS: run ${run.id} started from the picker: task ${task.id}, leader ${lead.address}`]).catch(() => {});
      }
      close();
    });
  }
  render(cx) {
    const t = theme(), u = ui(t), cfg = loadConfig();
    const task = load().find((x) => x.id === props().pick);
    if (!task) return u.frame("Task not found");
    const row = (kind, x, detail) => {
      const on = this.runner.kind === kind && this.runner.id === x.id;
      return h_flex().id(`${kind}-${x.id}`).min_h(34).px(10).gap(10).items_center().rounded(7).cursor_pointer()
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.popover)
        .on_click((_e, cx) => { this.runner = { kind, id: x.id }; cx.notify(); })
        .child(div().text_size(13).child(x.name)).child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(detail));
    };
    const choices = droverList(), drover = this.droverAt(choices);
    const reportChip = (label) => u.chip("report", `${this.report ? "☑" : "☐"} Report to ${label}`, this.report, (_e, cx) => { this.report = !this.report; cx.notify(); });
    // 2+ Drovers on screen: a Combobox-style list (name · space · address) picks the one this launch reports to.
    const reportRow = () => choices.length < 2 ? reportChip(`Drover (${drover})`) : h_flex().gap(6).items_center()
      .child(reportChip("Drover"))
      .child(Popover.new("pop-drover").anchor("top_left").open(this.menu).on_open_change((v, cx) => { this.menu = v; cx.notify(); })
        .trigger(h_flex().id("trig-drover").h(26).px(9).items_center().rounded(6).cursor_pointer().text_size(12).border_1().border_color(this.menu ? t.accent : t.input)
          .text_color(t.foreground).child(div().max_w(260).truncate().child(`${droverLabel(choices.find((c) => c.address === drover))} ▾`)))
        .content(v_flex().id("menu-drover").w(300).max_h(240).p(4).gap(1).rounded(8).border_1().border_color(t.input).bg(t.popover).mt(4)
          .overflow_y_scrollbar().children(choices.map((c) =>
            h_flex().id(`drover-${c.address}`).h(28).px(8).items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.foreground)
              .when(c.address === drover, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { this.picked.drover = c.address; this.menu = false; cx.notify(); })
              .child(div().flex_1().min_w(0).truncate().child(droverLabel(c)))))));
    const start = (e, cx) => this.start(e, cx, task);
    const names = (s) => [s.leader, ...s.members.map((m) => m.agent)].map((id) => cfg.agents.find((a) => a.id === id)?.name ?? id).join(" + ");
    // The overlay is 75% of the window tall (io.js pick): a definite height, so the list can shrink and scroll.
    return u.frame(`Start ${task.id}`,
      div().flex_none().pt(4).text_size(12).text_color(t.muted).truncate().child(task.title),
      // The lists scroll on their own; the title and the footer below stay in view at a short window height.
      v_flex().id("choices").flex_1().min_h(110).overflow_y_scrollbar()
        .child(u.label("Agent").flex_none()).child(v_flex().flex_none().gap(4).children(cfg.agents.map((a) => row("agent", a, a.command))))
        .child(u.label("Squad").flex_none()).child(v_flex().flex_none().gap(4).children(cfg.squads.map((s) => row("squad", s, names(s))))),
      h_flex().flex_none().pt(14).gap(8).items_center().flex_wrap()
        .child(u.chip("wt", this.worktree ? "☑ Own git worktree + space" : "☐ Own git worktree + space", this.worktree, (_e, cx) => { this.worktree = !this.worktree; cx.notify(); }))
        .child(drover
          ? reportRow()
          : div().h(26).px(9).flex().items_center().text_size(12).text_color(t.dim).child("☐ Report to Drover: Drover is not running")),
      h_flex().flex_none().pt(10).gap(8).items_center()
        .child(div().flex_1()).child(u.button("cancel", "Cancel", false, close)).child(u.button("go", this.busy ? "Starting…" : "Start", true, start))).h_full();
  }
}

export default class Agents extends View {
  init(_props, cx) {
    bind({ shared, modSettings });
    const p = props() ?? {};
    this.dialog = p.pick ? new Picker() : p.agent !== undefined ? new AgentEditor() : p.squad !== undefined ? new SquadEditor() : null;
    if (this.dialog?.load) cx.spawn(async (cx) => { await this.dialog.load(); cx.notify(); });
    // The pickers and editors are dialogs other screens open: they are not the Squads screen and are never switched off.
    if (this.dialog) cx.timer?.every?.(30000, () => { observeEnded(); });
    else whenLoaded("drover-agents", cx, (cx) => this.ensureStarted(cx));
    if (this.dialog instanceof Picker) whenLoaded("drover-agents", cx); // the mod.json layer of the defaults; the render repaints
  }

  // The Squads screen only. Idempotent: off starts nothing; on starts the reaper timer once (the screen launches runs).
  ensureStarted(cx) {
    if (this.started || !isEnabled("drover-agents") || !cfgReady("drover-agents")) return;
    this.started = true;
    cx.timer?.every?.(30000, () => { if (isEnabled("drover-agents")) observeEnded(); });
  }

  // Env counts for the list: names only, reloaded when an agent profile changes (every env save bumps its version).
  counts(cfg, cx) {
    const sig = cfg.agents.map((a) => `${a.id}:${a.version}`).join(",");
    if (sig !== this.countsSig && !this.countsBusy) {
      this.countsBusy = true;
      cx.spawn(async (cx) => {
        const c = await envCounts(cfg.agents.map((a) => a.id));
        this.envCount = c; this.countsSig = sig; this.countsBusy = false;
        cx.notify();
      });
    }
    return this.envCount ?? {};
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    this.ensureStarted(cx);
    { const g = gated("drover-agents"); if (g) return g; }
    const t = theme(), u = ui(t), cfg = loadConfig();
    const envs = this.counts(cfg, cx);
    const section = (title, add, rows) => v_flex().gap(4)
      .child(h_flex().h(28).items_center().child(div().flex_1().text_size(12).font_medium().text_color(t.muted).child(title)).child(add))
      .children(rows);
    // ▶ starts the agent or squad with no task, in a new tab of this space (Drover, a free helper),
    // in the "Opens in" project's repo, else the space's folder.
    const projects = loadProjects();
    const startIn = projects.some((p) => p.id === shared(START_IN_KEY)) ? shared(START_IN_KEY) : null; // a removed project: the space
    const startNow = (kind, id) => (_e, cx) => {
      cx.stop_propagation();
      this.starting = id; cx.notify();
      cx.spawn(async (cx) => { await startFromSquads(kind, id, startIn); this.starting = null; cx.notify(); });
    };
    const pickIn = (pid) => (_e, cx) => { setShared(START_IN_KEY, pid); cx.notify(); };
    const opensIn = h_flex().flex_wrap().gap(6).items_center()
      .child(div().text_size(12).text_color(t.muted).child("▶ opens in"))
      .child(u.chip("in-space", "Space folder", !startIn, pickIn(null)))
      .children(projects.map((p) => u.chip(`in-${p.id}`, p.name, startIn === p.id, pickIn(p.id))));
    const row = (id, name, detail, version, open, start) => h_flex().id(id).min_h(36).px(10).gap(10).items_center().rounded(7)
      .cursor_pointer().bg(t.background).hover((s) => s.bg(t.hover)).on_click(open)
      .child(div().flex_none().text_size(13).child(name)).child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`v${version}`))
      .child(div().id(`go-${id}`).flex_none().px(7).h(24).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted)
        .hover((s) => s.bg(t.raised).text_color(t.foreground)).on_click(start).child(this.starting === id.slice(2) ? "Starting…" : "▶ Start"));
    const names = (s) => [s.leader, ...s.members.map((m) => m.agent)].map((id) => cfg.agents.find((a) => a.id === id)?.name ?? id).join(" + ");
    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground).p(12).gap(14).overflow_y_scrollbar()
      .child(h_flex().items_center().child(div().flex_1().text_size(13).font_semibold().child("Agents & Squads"))
        .child(u.button("defaults", "Add default herd", false, (_e, cx) => {
          const r = addDefaults(cfg);
          if (r.added) setShared(AGENTS_KEY, r.config);
          notify({ title: r.added ? `Added ${r.added} default agents and squads` : "The default herd is already here", level: "info" });
          cx.notify();
        })))
      .child(opensIn)
      .child(section("Agents", u.button("add-agent", "+ Agent", false, () => dialog({ agent: null })),
        cfg.agents.map((a) => row(`a-${a.id}`, a.name, (a.soul ? `soul ${a.soul} · ` : "") + a.command + (a.instructions ? " · instructions" : "") + (envs[a.id] ? ` · ${envs[a.id]} env` : ""), a.version, () => dialog({ agent: a.id }), startNow("agent", a.id)))))
      .child(section("Squads", u.button("add-squad", "+ Squad", false, () => dialog({ squad: null })),
        cfg.squads.map((s) => row(`s-${s.id}`, s.name, names(s), s.version, () => dialog({ squad: s.id }), startNow("squad", s.id)))));
  }
}
