// Drover Reader: read-only transcript of an agent (Claude Code or Codex), found by its
// revive.session label. Never sends input. States what is missing instead of guessing.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, terminals, focused, props, run, exec, home, readTextFile, theme, shared } from "herdr";
import { claudeEntries, codexEntries } from "./transcript.js";
import { bind, cfg, isEnabled, whenLoaded, ready as cfgReady } from "./config.js";
import { modSettings } from "./io.js";
import { gated } from "./ui.js";


// Where the transcript is, or why there is none. kind: "claude" | "codex".
async function locate(term, agent) {
  const labels = term?.labels ?? {};
  const session = labels["revive.session"];
  const app = agent?.app ?? term?.agent ?? "";
  const argv0 = (term?.foreground?.argv ?? term?.argv ?? [])[0] ?? "";
  const kind = /codex/.test(app + argv0) ? "codex" : /claude/.test(app + argv0) ? "claude" : null;
  if (!kind) return { problem: `Reader supports Claude Code and Codex; this terminal runs ${app || argv0 || "an unknown program"}.` };
  if (!session) return { problem: "No session id: the terminal has no revive.session label (start it with the revive mod)." };
  // Find by id: Claude files sit under the folder it started in, which the shell may have left.
  const [dir, name] = kind === "claude" ? [".claude/projects", `${session}.jsonl`] : [".codex/sessions", `rollout-*-${session}.jsonl`];
  const r = await exec("find", [`${home()}/${dir}`, "-name", name]);
  const path = r.code === 0 ? (r.stdout ?? "").trim().split("\n").filter(Boolean).pop() : null;
  return path ? { kind, path } : { problem: `Transcript for session ${session} not found under ~/${dir}.` };
}

export default class Reader extends View {
  init(_props, cx) {
    this.address = props()?.terminal ?? focused()?.agent ?? agents()[0]?.address ?? null;
    this.state = { loading: true };
    this.scroll = ScrollHandle.new();
    this.count = 0;
    bind({ shared, modSettings });
    this.started = false;
    this.stopped = false; // seen off since the last render that was on
    this.gen = 0; // one number per read: only the latest enabled read may commit
    whenLoaded("drover-reader", cx, (cx) => this.ensureStarted(cx));
  }

  // Idempotent. Off: no timer, no find, no transcript read. On: the timer and the first read start once; back from off, reads again.
  ensureStarted(cx) {
    if (!isEnabled("drover-reader")) { this.stopped = this.started; return; }
    if (!cfgReady("drover-reader")) return;
    if (this.started) { if (this.stopped) { this.stopped = false; this.load(cx); } return; }
    this.started = true;
    cx.timer.every(5000, (cx) => this.load(cx));
    this.load(cx);
  }

  select(address, cx) {
    this.address = address;
    this.state = { loading: true };
    this.count = 0;
    this.load(cx);
  }

  load(cx) {
    if (!isEnabled("drover-reader")) return;
    const address = this.address;
    if (!address) { this.state = { problem: "No agent to read." }; return cx.notify(); }
    const gen = ++this.gen;
    const current = () => gen === this.gen && this.address === address && isEnabled("drover-reader");
    cx.spawn(async (cx) => {
      if (!current()) return;
      const term = terminals().find((x) => x.address === address);
      const agent = agents().find((x) => x.address === address);
      let state;
      if (!term) state = { problem: `Terminal ${address} is gone.` };
      else {
        // The session label changes on /clear: the key catches it, so find runs once per session.
        const key = `${address} ${term.labels?.["revive.session"]}`;
        const where = this.found?.key === key ? this.found : { key, ...(await locate(term, agent)) };
        if (!current()) return; // switched off, or a newer read started: nothing more is asked or kept
        if (!where.problem) this.found = where;
        if (where.problem) state = where;
        else {
          const text = await readTextFile(where.path).catch(() => null);
          state = text == null
            ? { problem: `Transcript not found: ${where.path}` }
            : { ...where, ...(where.kind === "claude" ? claudeEntries(text) : codexEntries(text)) };
        }
      }
      if (!current()) return; // switched while reading, switched off, or superseded by a newer read: dropped
      this.state = state;
      const n = state.entries?.length ?? 0;
      if (n > this.count) this.scroll.scroll_to_item(n - 1 + (state.earlier ? 1 : 0));
      this.count = n;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    this.ensureStarted(cx);
    { const g = gated("drover-reader"); if (g) return g; }
    const s = this.state;
    const list = agents();
    const max = cfg("drover-reader", "max_text");
    const color = { user: t.accent, assistant: t.foreground, tool: t.dim };
    const chip = (a) => div().id(`a-${a.address}`).h(24).px(8).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .border_1().border_color(a.address === this.address ? t.accent : t.border)
      .text_color(a.address === this.address ? t.foreground : t.muted)
      .on_click((_e, cx) => this.select(a.address, cx)).child(`${a.address} ${a.tab_name}`.slice(0, 28));
    const entry = (e, i) => v_flex().id(`e-${i}`).px(10).py(e.role === "tool" ? 2 : 6).gap(2)
      .when(e.role !== "tool", (el) => el.child(div().text_size(10.5).text_color(t.dim).child(e.role === "user" ? "You" : "Agent")))
      .child(div().text_size(e.role === "tool" ? 11 : 12.5).text_color(color[e.role])
        .child(e.role === "tool" ? `› ${e.text}` : e.text.length > max ? e.text.slice(0, max) + " …" : e.text));

    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground)
      .child(h_flex().h(36).px(12).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().truncate().text_size(13).font_semibold().child(`Reader ${this.address ?? ""}`))
        .when(Boolean(this.address), (el) => el.child(div().id("back").h(24).px(9).flex().items_center().rounded(6).text_size(11.5)
          .cursor_pointer().bg(t.raised).hover((x) => x.opacity(0.85))
          .on_click(() => run("agent.focus", { terminal: this.address })).child("Back to terminal"))))
      .child(h_flex().px(8).py(6).gap(4).flex_wrap().border_b_1().border_color(t.border).children(list.slice(0, 12).map(chip)))
      .child(s.loading ? div().p(14).text_size(12).text_color(t.dim).child("Reading…")
        : s.problem ? div().p(14).text_size(12).text_color(t.muted).child(s.problem)
        : v_flex().id("log").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).py(6)
          .when(s.earlier > 0, (el) => el.child(div().px(10).py(4).text_size(11).text_color(t.dim).child(`${s.earlier} earlier entries not shown`)))
          .children(s.entries.map(entry))
          .when(s.entries.length === 0, (el) => el.child(div().p(14).text_size(12).text_color(t.dim).child("Transcript is empty so far."))));
  }
}
