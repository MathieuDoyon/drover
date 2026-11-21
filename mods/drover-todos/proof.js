// The Accept proof dialog (B3a, read-only evidence; B3b adds the Accept chain). What the owner sees before approving a Review card. Hosted by the card
// dialog host (main.js), opened with props { proof: { id, project } }. The evidence, the PR text, the lock state and the accept record are loaded when the
// dialog opens (init) and on Refresh, never in render; the gate is computed there too. Render reads this.data / this.gate / this.run (memory) only.
// Accept runs the chain in accept.js through the real deps (io.js acceptDeps); the owner's click is permission for this PR at this head, once.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { load, loadRuns, loadEvidence, CONTEXT_STALE, openUrl, acceptDeps, acceptDir } from "./io.js";
import { linkedRun } from "./taskrun.js";
import { gate, overrideError, runAccept, checkAgain, lockKey, lockPath, clearCommand, HELD } from "./accept.js";

const WHY = {
  auth: "gh not logged in", offline: "offline", "not-found": "PR not found", unexpected: "unexpected gh answer",
  identity: "cannot isolate the gh identity, no gh request made", ambiguous: "more than one PR matches", "no-branch": "no PR or branch recorded on this card",
  "worktree-gone": "worktree gone, HEAD not provable", "no-repo": "the PR number is known but not its repo", "repo-mismatch": "the PR belongs to another repo",
};
const short = (sha) => (sha ? String(sha).slice(0, 7) : "?");
const absolute = (p) => typeof p === "string" && p.startsWith("/");
const NOT_MERGED = "Not merged: PR still open (queued or rejected, not proven)";

export class Proof {
  constructor(cx) {
    this.ref = props().proof ?? {};
    this.gen = 0;
    this.closed = false;
    this.data = null;
    this.error = null;
    this.task = null;
    this.state = "missing";
    this.gate = null; // the gate of the last load, recomputed when a reason is typed: never in render
    this.prx = null;
    this.cards = [];
    this.record = null;
    this.lock = "none"; // none | present | unknown (read in refresh)
    this.lockPath = null;
    this.clear = null;
    this.run = null; // { running, lines, result } of the chain started from this dialog
    this.checked = null;
    this.ready = false; // Accept may be clicked now (gate passes, no lock, nothing running)
    this.reason = InputState.new({ placeholder: "Why accept without it? One line, 10 to 300 characters" });
    this.reason.on("change", (_e, c) => this.onReason(c));
    this.refresh(cx);
  }

  // The card as the local store has it NOW: id AND project (a remote board can use the same id, and proof reads this machine only).
  stored() { return load().find((x) => x.id === this.ref.id && (x.project ?? null) === (this.ref.project ?? null)) ?? null; }

  // (Re)loads the evidence from ONE fresh snapshot of the card (its notes, source and summary) and its linked run, then the PR text, the lock and the
  // accept record (all reads), then the gate. A card that is gone or moved shows missing, never the old evidence. A load that is not the newest, or
  // that the dialog no longer wants, is dropped by current().
  refresh(cx) {
    if (this.closed) return;
    const gen = ++this.gen;
    const current = () => gen === this.gen && !this.closed;
    const task = this.stored();
    this.task = task;
    this.error = null;
    if (!task) { this.data = null; this.gate = null; this.ready = false; this.state = "missing"; cx.notify?.(); return; }
    this.state = "reading";
    const run = linkedRun(task, loadRuns());
    cx.notify?.();
    cx.spawn?.(async (acx) => {
      try {
        const data = await loadEvidence(task, run, current);
        if (!current()) return;
        const e = data.evidence;
        const deps = acceptDeps();
        const key = lockKey(task);
        const prx = e.pr.state === "found" && e.pr.prState === "OPEN" && e.head ? await deps.readPr({ repo: e.repo, number: e.pr.number, url: e.pr.url, head: e.head }).catch(() => ({ ok: false })) : undefined;
        const lock = await deps.lock.state(key).catch(() => "unknown");
        if (!current()) return;
        this.data = data;
        this.prx = prx;
        this.cards = load();
        this.record = deps.records.get(key);
        this.lock = lock;
        this.lockPath = lockPath(acceptDir(), key);
        this.clear = clearCommand(acceptDir(), key);
        this.state = "ready";
        this.compute();
      } catch (e) {
        if (e === CONTEXT_STALE || !current()) return;
        this.error = "could not read the proof";
        this.state = "error";
      }
      acx.notify?.();
    });
  }

  // The gate from what is in memory. A typed reason that covers every soft failure turns an override on; hard stops never take one.
  compute() {
    const e = this.data?.evidence;
    if (!e) { this.gate = null; this.ready = false; return; }
    const input = { evidence: e, prx: this.prx, task: this.task, cards: this.cards };
    let g = gate(input);
    if (g.needsOverride && overrideError(this.reason.value()) === null) g = gate({ ...input, override: { reason: this.reason.value().trim(), covers: g.soft } });
    this.gate = g;
    this.ready = g.enabled && this.lock === "none" && !this.run?.running && this.run?.result?.outcome !== "done";
  }

  onReason(cx) { this.compute(); cx.notify?.(); }

  // The owner's click. One run at a time; the chain re-reads everything and stops on any difference.
  accept(cx) {
    if (!this.ready || !this.data) return undefined;
    const g = this.gate;
    const ref = { id: this.ref.id, project: this.ref.project ?? null, bound: this.data.evidence, mode: g.mode, override: g.overridden ? { reason: this.reason.value().trim(), covers: g.soft } : null };
    this.run = { running: true, lines: [], result: null };
    this.ready = false;
    cx.notify?.();
    return cx.spawn?.(async (acx) => {
      // The click's own context expires across an await: every notify after the first await goes through the spawn callback's durable acx.
      const deps = { ...acceptDeps(), onStep: (line) => { this.run.lines.push(line); acx.notify?.(); } };
      let result;
      // An error after the lock was taken leaves the lock on purpose; the refresh below then shows its recovery text.
      try { result = await runAccept(ref, deps); } catch { result = { outcome: "failed", text: "Stopped by an unexpected error. The Accept lock is kept if one was taken: see the recovery steps below" }; }
      this.run.running = false;
      this.run.result = result;
      for (const l of result.steps ?? []) if (!this.run.lines.includes(l)) this.run.lines.push(l);
      if (result.outcome !== "done") this.refresh(acx); else this.compute();
      acx.notify?.();
    });
  }

  // Read-only: the evidence and the PR's state again. It never merges and writes nothing.
  checkAgain(cx) {
    if (this.closed || this.run?.running) return undefined;
    return cx.spawn?.(async (acx) => {
      const r = await checkAgain({ id: this.ref.id, project: this.ref.project ?? null }, acceptDeps()).catch(() => null);
      this.checked = r?.state ? `Checked again: the PR is ${r.state}${r.head ? ` at ${short(r.head)}` : ""}` : "Checked again: could not read the PR";
      this.refresh(acx);
    });
  }

  close() { this.closed = true; this.gen++; }
  // Only an absolute path opens: a relative or option-looking text never reaches `open`.
  openPath(path) { if (absolute(path)) openUrl(path); }
  shut() { closeOverlay(props().overlay); }

  render(cx) {
    const t = theme();
    const btn = (id, text, action) => h_flex().id(id).h(30).px(12).items_center().rounded(7).cursor_pointer().border_1().border_color(t.input).bg(t.raised)
      .text_color(t.foreground).text_size(12.5).hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const head = (text) => div().pt(14).pb(4).text_size(13).font_medium().child(text);
    const line = (text, color) => div().text_size(12).text_color(color ?? t.foreground).child(text);
    const link = (id, path) => div().id(id).text_size(12).text_color(t.accent).cursor_pointer().on_click(() => this.openPath(path)).child(path);
    const d = this.data;
    const g = this.gate;
    const body = [];
    if (this.state === "missing") body.push(line("Card not found here", t.muted), line("Proof reads this machine's cards only.", t.dim));
    else if (this.state === "reading" && !d) body.push(line("Reading the proof…", t.muted));
    else if (this.state === "error" && !d) body.push(line(`Error: ${this.error ?? "could not read the proof"}`, t.blocked));
    else if (d) {
      const e = d.evidence;
      if (this.state === "reading") body.push(line("Refreshing…", t.muted));
      if (this.state === "error") body.push(line(`Error: ${this.error}. Showing the last read.`, t.blocked));
      body.push(head("Summary"), line(d.summary.title, t.foreground));
      if (d.summary.desc) body.push(line(d.summary.desc, t.muted));
      body.push(line(d.handoff ? `Last handoff (${d.handoff.by ?? "?"}): ${d.handoff.text}` : "No handoff note yet", d.handoff ? t.foreground : t.dim));

      body.push(head("Changes"));
      if (e.pr.state === "found") body.push(line(`PR #${e.pr.number} ${e.pr.prState}${e.repo ? ` in ${e.repo}` : ""}: ${e.base ?? "?"} <- head ${short(e.head)}`, t.muted));
      else if (e.pr.state === "none") body.push(line(`No PR for this branch: evidence is the worktree commit ${short(e.head)}`, t.muted));
      else body.push(line(`PR unknown (${WHY[e.pr.reason] ?? e.pr.reason})`, t.blocked));
      if (d.localDiffers) body.push(line("Local branch differs from the PR head: everything below is about the PR head", t.done));
      if (d.changes.state === "ok") body.push(...d.changes.commits.map((c) => line(c, t.foreground)), line(d.changes.files, t.muted));
      else body.push(line(`unavailable: ${d.changes.reason}`, t.muted));

      body.push(head("Checks"));
      body.push(e.checks.green
        ? line(`Green on ${short(e.head)}`, t.accent)
        : line(`NOT green: ${e.pr.state === "unknown" ? `unknown (${WHY[e.pr.reason] ?? e.pr.reason})` : e.checks.reason}`, t.blocked));
      body.push(...e.checks.items.map((i) => line(`${i.name}: ${i.state}`, i.state === "pass" ? t.muted : t.blocked)));
      body.push(line(d.actor ? `Reading as ${d.actor}. This is the login gh resolved; it does not prove who owns it.` : "Reading as an unknown login", t.dim));

      body.push(head("Review"));
      const v = e.verdict;
      if (v.state === "pass" || v.state === "adverse") body.push(line(`${v.state === "pass" ? "Pass" : "Adverse"} on ${short(v.head)} (${v.by ?? "?"})`, v.state === "pass" ? t.accent : t.blocked));
      else if (v.state === "stale") body.push(line(`Stale: the ${v.was} review was of ${short(v.head)}, not the head ${short(e.head)}`, t.done));
      else body.push(line("No review of this head", t.muted));
      if (v.report) body.push(link("proof-open-review", v.report));

      body.push(head("Proof artifact"));
      body.push(d.proof ? link("proof-open-artifact", d.proof) : line("none", t.dim));

      body.push(head("Accept"));
      if (this.lock !== "none") {
        // A lock this process did not make: never removed by the app, whatever its age. The PR is read-only evidence; clearing it is the owner's call.
        body.push(line(HELD, t.blocked));
        body.push(line(e.pr.state === "found" ? `PR #${e.pr.number} ${e.pr.prState} at ${short(e.head)}` : e.pr.state === "none" ? "No PR" : `PR unknown (${WHY[e.pr.reason] ?? e.pr.reason})`, t.muted));
        body.push(line(`Lock: ${this.lockPath}`, t.muted));
        body.push(line("Removing it is your call: do it only after you confirm no Drover window or process is mid-Accept and you have read the PR state above. The app never runs this:", t.dim));
        body.push(line(this.clear, t.foreground));
      } else {
        if (g?.mode === "finish") body.push(line(`Merged at ${short(e.head)}: Finish syncs the source issue and moves the card to Done`, t.accent));
        if (this.record?.phase === "open" && g?.mode !== "finish") body.push(line(NOT_MERGED, t.done));
        if (this.record?.phase === "unknown") body.push(line("Unknown: an earlier Accept could not read the PR after the merge call", t.done));
        if (g && !g.enabled) body.push(...g.reasons.filter((r) => !r.soft || g.needsOverride || !g.overridden).map((r) => line(`${r.soft ? "Needs a reason: " : "Blocked: "}${r.text}`, r.soft ? t.done : t.blocked)));
        if (g?.needsOverride || g?.overridden) body.push(div().id("proof-reason").pt(6).child(line("Override with a reason (logged on the card)", t.muted)).child(Input.new(this.reason).h(28).text_size(12.5)));
      }
      if (this.checked) body.push(line(this.checked, t.muted));
      if (this.run) {
        body.push(...this.run.lines.map((l) => line(l, t.muted)));
        if (this.run.running) body.push(line("Running…", t.muted));
        else if (this.run.result) body.push(line(this.run.result.text ?? this.run.result.outcome, this.run.result.outcome === "done" ? t.accent : t.blocked));
      }
    }
    const reason = this.run?.running ? "Running…" : this.lock !== "none" ? HELD : g?.reasons[0]?.text ?? (this.state === "reading" ? "Reading the proof…" : this.state === "missing" ? "Card not found here" : this.state === "error" ? "Could not read the proof" : "");
    const label = g?.label ?? "Accept";
    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground).text_size(13)
      .child(div().px(20).pt(16).pb(4).text_size(15).font_medium().child(`Proof${this.task ? `: ${this.task.id} ${this.task.title}` : ""}`))
      .child(v_flex().id("proof-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).pb(12).gap(4).children(body))
      .child(h_flex().px(20).py(12).gap(8).items_center().border_t_1().border_color(t.border)
        .child(this.ready
          ? btn("proof-accept", label, (_e, c) => this.accept(c))
          : div().id("proof-accept-off").h(30).px(12).flex().items_center().rounded(7).border_1().border_color(t.border).text_size(12.5).text_color(t.dim).opacity(0.5).tooltip(reason || "Accept is not available").child(label))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.ready ? "Your click lets this PR merge at this exact commit, once" : reason))
        .when(this.lock === "none" && (this.record?.phase === "open" || this.record?.phase === "unknown") && !this.run?.running, (el) => el.child(btn("proof-check-again", "Check again", (_e, c) => this.checkAgain(c))))
        .when(this.state !== "missing", (el) => el.child(btn("proof-refresh", "Refresh", (_e, c) => this.refresh(c))))
        .child(btn("proof-close", "Close", () => this.shut())));
  }
}
