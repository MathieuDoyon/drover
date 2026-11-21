// The Accept proof dialog (B3a, read-only): what the owner sees before approving a Review card. Hosted by the card dialog host (main.js), opened
// with props { proof: { id, project } }. The evidence is loaded when the dialog opens (init) and on Refresh, never in render; render reads
// this.data only. Accept is disabled until B3b ships; nothing here merges, moves, syncs or writes.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { load, loadRuns, loadEvidence, CONTEXT_STALE, openUrl } from "./io.js";
import { linkedRun } from "./taskrun.js";

const WHY = {
  auth: "gh not logged in", offline: "offline", "not-found": "PR not found", unexpected: "unexpected gh answer",
  identity: "cannot isolate the gh identity, no gh request made", ambiguous: "more than one PR matches", "no-branch": "no PR or branch recorded on this card",
  "worktree-gone": "worktree gone, HEAD not provable", "no-repo": "the PR number is known but not its repo", "repo-mismatch": "the PR belongs to another repo",
};
const short = (sha) => (sha ? String(sha).slice(0, 7) : "?");
const absolute = (p) => typeof p === "string" && p.startsWith("/");

export class Proof {
  constructor(cx) {
    this.ref = props().proof ?? {};
    this.gen = 0;
    this.closed = false;
    this.data = null;
    this.error = null;
    this.task = null;
    this.state = "missing";
    this.refresh(cx);
  }

  // The card as the local store has it NOW: id AND project (a remote board can use the same id, and proof reads this machine only).
  stored() { return load().find((x) => x.id === this.ref.id && (x.project ?? null) === (this.ref.project ?? null)) ?? null; }

  // (Re)loads the evidence from ONE fresh snapshot of the card (its notes, source and summary) and its linked run. A card that is gone or
  // moved shows missing, never the old evidence. A load that is not the newest, or that the dialog no longer wants, is dropped by current().
  refresh(cx) {
    if (this.closed) return;
    const gen = ++this.gen;
    const current = () => gen === this.gen && !this.closed;
    const task = this.stored();
    this.task = task;
    this.error = null;
    if (!task) { this.data = null; this.state = "missing"; cx.notify?.(); return; }
    this.state = "reading";
    const run = linkedRun(task, loadRuns());
    cx.notify?.();
    cx.spawn?.(async (acx) => {
      try {
        const data = await loadEvidence(task, run, current);
        if (!current()) return;
        this.data = data;
        this.state = "ready";
      } catch (e) {
        if (e === CONTEXT_STALE || !current()) return;
        this.error = "could not read the proof";
        this.state = "error";
      }
      acx.notify?.();
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
    }
    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground).text_size(13)
      .child(div().px(20).pt(16).pb(4).text_size(15).font_medium().child(`Proof${this.task ? `: ${this.task.id} ${this.task.title}` : ""}`))
      .child(v_flex().id("proof-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).pb(12).gap(4).children(body))
      .child(h_flex().px(20).py(12).gap(8).items_center().border_t_1().border_color(t.border)
        .child(div().id("proof-accept-off").h(30).px(12).flex().items_center().rounded(7).border_1().border_color(t.border).text_size(12.5).text_color(t.dim).opacity(0.5).tooltip("Accept ships in B3b").child("Accept"))
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Accept ships in B3b"))
        .when(this.state !== "missing", (el) => el.child(btn("proof-refresh", "Refresh", (_e, cx) => this.refresh(cx))))
        .child(btn("proof-close", "Close", () => this.shut())));
  }
}
