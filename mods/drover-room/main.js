// Drover Room: right panel for the run you are inside (focused member terminal, its worktree
// folder or its worktree space). Shows the linked issue (E11: properties, wakeups, parent, PRs)
// and the squad. Read-only for Jira and GitHub. Refreshes on entry and every `refresh_minutes` (Drover Config, read on each use) per run, never faster.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, focused, run, theme, shared, setShared } from "herdr";
import { WAKE_KEY, setEnabled, setStatus, isOpen, wakeOrder, until, summary } from "./wake.js";
import { projectOf } from "./store.js";
import { machineOf } from "./remote.js";
import { currentRun, wakesOf, liveStatuses, memberStatus, terminalName, runTitle, lineageOf, squadRows, openCommand } from "./runs.js";
import { section as sectionOf, toggle, openNewWakeup } from "./ui.js";
import { age, prLabel, projectLabel } from "./sources.js";
import { bind, cfg, isEnabled, load as loadCfg, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";
import { load, loadProjects, loadRuns, loadWakes, edit, openUrl, watchWakes, observeEnded, loadContext, mergeContext, CONTEXT_STALE, ROOM_KEY, modSettings } from "./io.js";

const contexts = () => shared(ROOM_KEY) ?? {};

export default class Room extends View {
  init(_props, cx) {
    this.historyOpen = false;
    this.confirm = null;
    this.loading = null;
    bind({ shared, modSettings });
    this.started = false;
    this.gen = 0; // advanced when the screen is seen switched off: a load of an earlier period stops asking
    // The screen's own mod.json settings (an inherited enabled) load before the gate starts any work; then it re-renders.
    cx.spawn(async (cx) => { await loadCfg("drover-room"); this.ensureStarted(cx); cx.notify(); });
    // watchWakes delivers CLI wakeups (hc send): the queue keeps running while the screen is off (decision G2, screen only).
    watchWakes(cx);
  }

  // Idempotent. Off: the screen's own work (mod.json read, countdown timer, context loads) does not start. On: starts once.
  ensureStarted(cx) {
    if (!isEnabled("drover-room")) { if (this.started && !this.off) this.gen++; this.off = this.started; return; }
    this.off = false;
    if (this.started || !cfgReady("drover-room")) return;
    this.started = true;
    cx.timer.every(30000, (cx) => { if (!isEnabled("drover-room")) return; observeEnded(); this.refresh(cx); cx.notify(); }); // countdowns; refresh only when refresh_minutes old
  }

  // The "+" opens the New wakeup dialog aimed at the run's task, else its leader terminal.
  addWakeup() {
    const lead = this.run && (this.run.terminals.find((m) => m.role === "leader") ?? this.run.terminals[0]);
    const target = this.run && (this.run.task ?? lead?.address);
    if (target) openNewWakeup(target);
  }

  // Squad row: copies the resume command. The click stops here, so it never reaches the row (no focus, no peek). No resume action: the person pastes it.
  copyResume(address, text, cx) {
    cx.stop_propagation();
    cx.write_to_clipboard(text);
    this.copied = address; cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === address) { this.copied = null; cx.notify(); } });
  }

  // Only the run you are in, only when its data is refresh_minutes old (or missing), one at a time.
  refresh(cx) {
    const r = this.run;
    if (!isEnabled("drover-room") || !r || this.loading || Date.now() - (contexts()[r.id]?.at ?? 0) < cfg("drover-room", "refresh_minutes") * 60 * 1000) return;
    this.loading = r.id;
    const gen = this.gen;
    const current = () => isEnabled("drover-room") && gen === this.gen;
    cx.spawn(async (cx) => {
      const task = load().find((x) => x.id === r.task);
      let next;
      try { next = await loadContext(r, task, current); } catch (e) { if (e === CONTEXT_STALE) { this.loading = null; return; } next = { at: Date.now(), issue: null, prs: null, errors: [String(e?.message ?? e)] }; }
      if (!current()) { this.loading = null; return; } // switched off while it loaded: dropped, nothing written
      const all = contexts();
      // keeps context for the last drover-room.kept_contexts runs
      setShared(ROOM_KEY, Object.fromEntries([[r.id, mergeContext(all[r.id], next)], ...Object.entries(all).filter(([k]) => k !== r.id)].slice(0, cfg("drover-room", "kept_contexts"))));
      this.loading = null;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    this.ensureStarted(cx);
    { const g = gated("drover-room"); if (g) { this.run = null; return g; } }
    const r = (this.run = currentRun(focused(), loadRuns()));
    const root = v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground).overflow_y_scrollbar();
    if (!r) return root.child(div().p(14).text_size(12).text_color(t.dim)
      .child("Not inside a run. Focus a run's agent or open its room (Runs → Open room)."));
    this.refresh(cx);

    const task = load().find((x) => x.id === r.task);
    const ctx = contexts()[r.id] ?? null;
    const issue = ctx?.issue ?? null;
    const live = liveStatuses(agents(), terminals());
    const alive = new Set(terminals().map((x) => x.address));
    const color = { blocked: t.blocked, working: t.working, done: t.done, idle: t.idle, gone: t.dim };
    const stateColor = { new: t.dim, indeterminate: t.working, done: t.done };
    const prColor = { Open: t.done, Draft: t.dim, Merged: t.accent, Closed: t.blocked };
    const wakes = wakesOf(r, loadWakes()).sort(wakeOrder);
    const open = wakes.filter(isOpen);
    const ended = wakes.filter((w) => !isOpen(w));
    const leader = r.terminals.find((m) => m.role === "leader") ?? r.terminals[0];
    const leaderStatus = leader ? memberStatus(leader.address, live, alive) : null;

    const section = (title, count, extra) => sectionOf(t, title, count, extra);
    const prop = (k, v, dot, jump) => h_flex().id(`p-${k}`).h(26).gap(8).items_center().text_size(12.5)
      .when(Boolean(jump), (el) => el.cursor_pointer().rounded(6).hover((x) => x.bg(t.hover)).on_click(jump))
      .child(div().w(76).flex_none().text_color(t.muted).child(k))
      .when(Boolean(dot), (el) => el.child(div().size(8).rounded(4).flex_none().bg(dot)))
      .child(div().flex_1().truncate().child(v));
    const linkRow = (id, url) => h_flex().id(id).py(5).gap(8).items_start().rounded(6).cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => openUrl(url));

    const wake = (w) => h_flex().id(`w-${w.id}`).py(6).gap(8).items_start()
      .child(div().text_color(t.dim).child("⏰"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12.5).truncate().text_color(isOpen(w) ? t.foreground : t.muted).child(w.text))
        .child(div().text_size(11).text_color(t.dim).truncate().child([
          w.target === r.task ? `Wake ${leader?.name ?? "leader"}` : `Wake ${w.target}`,
          ...(w.status === "scheduled" ? [summary(w), until(w.due)] : [`${w.status} ${age(w.at ?? w.created)} ago`]),
          w.reason, w.source === "agent" ? "by agent" : null,
        ].filter(Boolean).join(" · "))))
      .when(w.status === "scheduled", (el) => el.child(toggle(t, `on-${w.id}`, w.enabled !== false,
        () => setShared(WAKE_KEY, setEnabled(loadWakes(), w.id, w.enabled === false)))))
      .when(w.status === "scheduled", (el) => el.child(div().id(`x-${w.id}`).text_size(11).text_color(t.dim).cursor_pointer()
        .on_click((_e, cx) => {
          if (this.confirm !== w.id) { this.confirm = w.id; cx.timer.after(4000, (cx) => { if (this.confirm === w.id) { this.confirm = null; cx.notify(); } }); cx.notify(); return; }
          this.confirm = null;
          setShared(WAKE_KEY, setStatus(loadWakes(), w.id, "cancelled", "Cancelled by you")); cx.notify();
        }).child(this.confirm === w.id ? div().text_color(t.blocked).child("Cancel wakeup?") : "✕")));

    const pr = (p) => linkRow(`pr-${p.number}`, p.url)
      .child(div().text_color(prColor[p.state] ?? t.muted).child("⑂"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12.5).truncate().child(p.title))
        .child(div().text_size(11).text_color(t.dim).child(`${prLabel(p)}${p.created ? ` · ${age(p.created)} ago` : ""}`)))
      .child(div().px(6).py(1).rounded(5).bg(t.raised).text_size(11).text_color(prColor[p.state] ?? t.muted).child(p.state));

    const status = this.loading === r.id ? "Refreshing…"
      : ctx ? `Updated ${age(ctx.at)} ago${ctx.errors?.length && ctx.good ? ` · last good ${age(ctx.good)} ago` : ""}` : null;

    return root.px(14).pb(14)
      .child(h_flex().pt(14).gap(8).items_start()
        .child(div().id("task").flex_1().min_w(0).text_size(14).font_semibold().cursor_pointer().on_click(() => task && edit(task.id))
          .child(issue ? `${issue.key} ${issue.title}` : runTitle(r, task)))
        .when(Boolean(task), (el) => el.child(div().id("edit-task").flex_none().mt(1).px(6).py(2).rounded(5).text_size(11.5).text_color(t.dim)
          .cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(() => edit(task.id)).child("✎ Edit"))))
      .when(Boolean(status), (el) => el.child(div().pt(2).text_size(11).text_color(t.dim).child(status)))
      .children((ctx?.errors ?? []).map((e, i) => div().id(`err-${i}`).pt(4).text_size(11.5).text_color(t.blocked).child(e)))

      .child(section("Properties"))
      .when(Boolean(issue), (el) => el
        .child(prop("Status", issue.status, stateColor[issue.category] ?? t.muted))
        .child(prop("Assignee", issue.assignee ?? "Unassigned"))
        .when(Boolean(issue.project), (el) => el.child(prop(projectLabel(issue), issue.project)))
        .when(Boolean(issue.type), (el) => el.child(prop("Type", issue.type))))
      .when(Boolean(projectOf(task, loadProjects())), (el) => el.child(prop("Project", projectOf(task, loadProjects()).name)))
      .when(!issue && !task?.source, (el) => el.child(prop("Issue", "No linked issue")))
      .child(prop("Agent", leader ? `${leader.name} · ${leaderStatus}` : "—", color[leaderStatus],
        leader && leaderStatus !== "gone" ? () => run("agent.focus", { terminal: leader.address }) : null))
      .when(Boolean(r.reportTo), (el) => {
        const s = memberStatus(r.reportTo, live, alive);
        return el.child(prop("Lead", `${terminalName(loadRuns(), r.reportTo)} · ${s}`, color[s],
          s !== "gone" ? () => run("agent.focus", { terminal: r.reportTo }) : null));
      })
      .child(prop("Machine", machineOf(loadProjects(), projectOf(task, loadProjects())?.id, leader?.address)))
      .child(prop("Column", r.task ? task?.column ?? "task deleted" : "No task"))
      .when(Boolean(r.worktree), (el) => el.child(prop("Branch", r.worktree.branch)))
      .child(prop("Run", `${r.id} · started ${age(r.started)} ago`))

      .child(section("Wakeups", open.length, div().id("plus").px(4).text_size(16).text_color(t.muted).cursor_pointer()
        .on_click(() => this.addWakeup()).child("+")))
      .children(open.slice(0, 20).map(wake))
      .when(ended.length > 0, (el) => el.child(h_flex().id("history").mt(6).px(10).py(8).gap(6).items_center().rounded(8).bg(t.raised)
        .text_size(12.5).text_color(t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.historyOpen = !this.historyOpen; cx.notify(); })
        .child(this.historyOpen ? "▾" : "›").child(`Wakeup history · ${ended.length}`)))
      .when(this.historyOpen, (el) => el.children(ended.slice(0, 20).map(wake)))
      .when(wakes.length === 0, (el) => el.child(div().text_size(12).text_color(t.dim).child("No wakeups for this run.")))

      .when(Boolean(issue?.parent), (el) => el.child(section("Parent issue"))
        .child(linkRow("parent", issue.parent.url)
          .child(div().size(8).mt(5).rounded(4).flex_none().bg(stateColor[issue.parent.category] ?? t.dim))
          .child(div().text_size(12.5).text_color(t.muted).flex_none().child(issue.parent.key))
          .child(div().flex_1().truncate().text_size(12.5).child(issue.parent.title))))

      .when(ctx?.prs != null, (el) => el.child(section("Pull requests", ctx.prs.length))
        .children(ctx.prs.map(pr))
        .when(ctx.prs.length === 0, (el) => el.child(div().text_size(12).text_color(t.dim)
          .child(r.worktree ? `No PRs for ${r.worktree.branch}.` : "No worktree branch: PRs show for linked ones only."))))

      .child(section("Squad", r.terminals.length))
      .children(squadRows(lineageOf(r, loadRuns(), live, alive, Date.now())).map((m) => {
        const row = h_flex().id(`m-${m.address}`).min_h(26).gap(8).items_center().rounded(6).pl(m.depth * 14)
          .when(m.dim, (el) => el.opacity(0.5))
          .when(m.focusable, (el) => el.cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => run(openCommand(m), { terminal: m.address })));
        const line = m.resumeText && h_flex().id(`resume-${m.address}`).ml(m.depth * 14 + 15).mb(2).px(6).py(2).gap(8).items_center().rounded(5).bg(t.raised)
          .cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.copyResume(m.address, m.resumeText, cx))
          .child(div().text_size(11).flex_none().text_color(t.muted).child(`session ${m.session.slice(0, 8)}`))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(m.resumeText))
          .child(div().text_size(11).flex_none().text_color(this.copied === m.address ? t.done : t.dim).child(this.copied === m.address ? "Copied" : "⧉ Copy"));
        return v_flex().id(`sq-${m.address}`).child(row
          .child(div().size(7).rounded(4).flex_none().bg(color[m.status] ?? t.idle))
          .child(div().text_size(12.5).flex_none().child(m.name))
          .child(div().flex_1().truncate().text_size(11).text_color(t.dim)
            .child([m.role, m.address, m.leader && r.worktree ? r.worktree.branch : null].filter(Boolean).join(" · ")))
          .child(div().px(5).rounded(4).flex_none().bg(t.raised).text_size(11).text_color(t.muted).child(`req: ${m.modelText}`))
          .child(div().text_size(11).flex_none().text_color(color[m.status] ?? t.muted).child(m.status))
          .child(div().w(44).flex_none().text_size(11).text_color(t.dim).child(m.durationText)))
          .when(Boolean(line), (el) => el.child(line));
      }));
  }
}
