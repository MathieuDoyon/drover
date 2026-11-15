// Drover GitHub: read-only, every open issue and PR, only in the orgs/repos you add.
// No scope, no search. Uses your `gh` login. "+ Board" makes a local card.
import { View, div } from "gpui-kit";
import { InputState, Input, v_flex, h_flex } from "gpui-base";
import { exec, shared, setShared, theme } from "herdr";
import { parseScope, githubItems, inScope } from "./sources.js";
import { QUERY_KEY, restoreContent, contentFromModel, usableModel, ghErrorMessage, createLoader, createController, planRequests, emptyText } from "./filter.js";
import { menuState, nextIndex } from "./menu.js";
import { toArgs } from "./query.js";
import { createValues, valuesFor } from "./values.js";
import { modSettings } from "./io.js";
import { bind, load as loadCfg, cfg, isEnabled, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";
import { sourceList } from "./sourcelist.js";

const SCOPES = "drover.github.scopes";
const SNAPSHOT = "drover.github.snapshot";
const FIELDS = "number,title,repository,url,isPullRequest,updatedAt,state,labels,author,assignees";
const VALUE_KEYS = new Set(["label", "assignee", "author", "involves", "mentions", "review-requested", "milestone"]);
const MOD = "drover-github";
const OFF = Symbol("github-off"); // a request that found the screen switched off

// The person's saved scopes win, even an empty list (they removed them all); only when none were ever saved do the configured ones apply.
const scopes = () => (Array.isArray(shared(SCOPES)) ? shared(SCOPES) : cfg(MOD, "scopes"));
const configuredModel = () => usableModel(cfg(MOD, "query"));
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const configuredContent = () => contentFromModel(configuredModel());

// One request = {query (model), scopes}, captured when committed. The snapshot is tagged with its query.
// current(): still wanted (on, same generation). Tested before every gh call: a load switched off mid-way asks no further scope.
async function load(req, limit, current) {
  const items = [];
  if (!req.scopes.length) return { items, partial: false, at: null, scopes: [], query: req.query };
  let partial = false;
  for (const { scope, args } of planRequests(req.scopes, limit, FIELDS, req.query)) {
    if (!current()) throw OFF;
    const r = await exec("gh", args, { timeout: 60000 });
    if (r.code !== 0) throw new Error(ghErrorMessage(r.stderr, scope, req.query));
    const found = githubItems(JSON.parse(r.stdout), req.scopes);
    if (found.length >= limit) partial = true;
    items.push(...found);
  }
  const unique = [...new Map(items.map((i) => [i.id, i])).values()].sort((a, b) => b.updated - a.updated);
  return { items: unique, partial, at: Date.now(), scopes: req.scopes, query: req.query };
}

export default class GitHub extends View {
  init(_props, cx) {
    this.loading = false;
    this.error = null;
    this.inputError = null;
    this.cx = cx;
    this.addingScope = false;
    // Key/value menu: shown while the filter input has focus; Esc, blur or an outside press dismisses it until the text changes.
    this.focused = false;
    this.dismissed = false;
    this.hi = -1;
    this.menuKey = "";
    this.skipSubmit = false;
    this.focusSeq = 0;
    this.values = createValues({ exec });
    this.pending = new Set(); // key+scopes with a gh api request in flight
    this.input = InputState.new({ placeholder: "is:issue state:open … (Enter applies)" });
    bind({ shared, modSettings });
    this.input.set_value(restoreContent(shared(QUERY_KEY), configuredContent()));
    this.initialText = this.input.value(); // the configured default is applied later only over this text, never over a typed draft
    this.scopeInput = InputState.new({ placeholder: "org or owner/repo (Enter)" });
    this.loader = createLoader({
      run: async (req) => {
        const gen = this.gen;
        const current = () => isEnabled(MOD) && gen === this.gen;
        if (!current()) throw OFF;
        return load(req, cfg(MOD, "limit"), current);
      },
      // A result or error that arrives while the screen is off is dropped: nothing is written.
      onResult: (_req, snap) => { if (!isEnabled(MOD)) { this.loading = false; return; } setShared(SNAPSHOT, snap); this.error = null; this.loading = false; this.cx.notify(); },
      onError: (_req, e) => { if (e === OFF || !isEnabled(MOD)) { this.loading = false; return; } this.error = String(e?.message ?? e); this.loading = false; this.cx.notify(); },
    });
    this.ctl = createController({
      input: this.input,
      scopes,
      save: (content) => setShared(QUERY_KEY, content),
      enqueue: (req) => this.enqueue(req),
      defaults: configuredContent,
      // Reset (button and menu): drop the saved scopes so the Config ones apply, and the snapshot of the old query/scopes.
      onReset: () => { setShared(SCOPES, null); setShared(SNAPSHOT, null); this.error = null; },
    });
    // Typing key:value + space turns the word into a chip; Enter converts an unfinished word.
    // Token edits sync explicitly in the controller, so nothing depends on a change echo.
    const guard = (fn) => (_e, cx) => {
      this.cx = cx;
      this.edit(fn);
      cx.notify();
    };
    this.input.on("change", guard(() => this.ctl.onChange()));
    // The Enter that picked a menu item must not also commit: its own `submit` is skipped once (skipSubmit).
    this.input.on("submit", guard(() => {
      if (this.skipSubmit) { this.skipSubmit = false; return; }
      this.ctl.onSubmit();
    }));
    this.input.on("focus", (_e, cx) => { this.focusSeq++; this.focused = true; this.dismissed = false; cx.notify(); });
    // A blur closes the menu after a short delay (a press on a menu item blurs first); a refocus cancels it.
    this.input.on("blur", (_e, cx) => {
      this.cx = cx;
      const seq = ++this.focusSeq;
      cx.timer.after(150, (cx) => { if (seq === this.focusSeq) { this.focused = false; cx.notify(); } });
    });
    this.scopeInput.on("submit", (_e, cx) => {
      const text = this.scopeInput.value();
      const s = parseScope(text);
      if (!s) { this.error = `"${text}" is not an org or owner/repo.`; return cx.notify(); }
      setShared(SCOPES, [...new Set([...scopes(), s])]);
      this.scopeInput.set_value("");
      this.addingScope = false;
      this.error = null;
      this.cx = cx;
      this.ctl.refresh();
    });
    this.gen = 0; // advanced when the screen is seen switched off: a load of an earlier period stops asking
    this.started = false; // the timer and the first load run once, the first time the screen is on
    this.stopped = false; // seen switched off since the last render that was on: reload when it comes back
    // The screen's own mod.json settings (an inherited enabled) load before the gate starts any work; then it re-renders.
    cx.spawn(async (cx) => { await loadCfg(MOD); this.ensureStarted(cx); cx.notify(); });
  }

  // Idempotent. Off: nothing starts (no timer, no config read, no gh). On: the timer and the first load start once;
  // coming back after an off period reloads. The input, scopes and drafts are never touched by going off.
  ensureStarted(cx) {
    if (!isEnabled(MOD)) { if (this.started && !this.stopped) this.gen++; this.stopped = this.started; return; }
    if (!cfgReady(MOD)) return;
    if (this.started) {
      if (this.stopped) { this.stopped = false; this.refresh(cx); }
      return;
    }
    this.started = true;
    cx.timer.every(5 * 60 * 1000, (cx) => { if (isEnabled(MOD)) this.refresh(cx); });
    // The mod.json layer loads async: the first search waits for it, so the configured query, scopes and limit are all in force.
    cx.spawn(async (cx) => {
      if (!isEnabled(MOD)) { this.stopped = true; return; }
      if (restoreContent(shared(QUERY_KEY), null) === null && this.input.value() === this.initialText) this.input.set_value(configuredContent());
      this.cx = cx;
      this.ctl.adopt();
      cx.notify();
    });
  }

  // A failed token edit keeps its own error until the next edit succeeds; loads never clear it.
  edit(fn) {
    try { fn(); this.inputError = null; } catch (e) { this.inputError = `Token input failed: ${String(e?.message ?? e)}`; }
  }

  // One request = {query, scopes}. An empty-scope request is enqueued too, so it supersedes anything running.
  enqueue(req) {
    if (!isEnabled(MOD)) return;
    this.loading = req.scopes.length > 0;
    this.error = null;
    this.cx.notify();
    this.cx.spawn(async (cx) => { this.cx = cx; await this.loader.commit(req); });
  }

  refresh(cx) {
    this.cx = cx;
    this.ctl.refresh();
  }

  // True when the saved scopes or the committed query differ from the Config defaults (the Defaults button shows only then).
  differsFromDefaults() {
    const saved = shared(SCOPES);
    if (Array.isArray(saved) && !sameSet(saved, cfg(MOD, "scopes"))) return true;
    return JSON.stringify(toArgs(this.ctl.model())) !== JSON.stringify(toArgs(configuredModel()));
  }

  resetDefaults(cx) {
    this.cx = cx;
    this.edit(() => this.ctl.pick({ reset: true }));
    cx.notify();
  }

  // The menu for the current text: caret is assumed at the END (the host has no caret getter; see menu.js).
  menuNow(cx) {
    if (this.dismissed && this.input.value() !== this.dismissedText) this.dismissed = false; // typing reopens it
    if (!this.focused || this.dismissed) return { open: false, items: [] };
    const list = scopes();
    const items = (shared(SNAPSHOT)?.items ?? []).filter((i) => inScope(i.repo, list));
    const values = {};
    for (const k of VALUE_KEYS) values[k] = valuesFor(k, list, items, this.values);
    const m = menuState(this.input.content(), undefined, { scopes: list, values, defaultText: toArgs(configuredModel()).join(" ") });
    this.loadValues(m, list, cx);
    const key = `${m.stage}|${m.key}|${m.typed}|${m.negated}|${m.items.length}`;
    if (key !== this.menuKey) {
      this.menuKey = key;
      // Nothing is highlighted until something is typed (or Up/Down), so Enter on an empty input still commits.
      this.hi = m.open && m.typed ? 0 : -1;
    }
    return m;
  }

  // The values stage of a source key asks gh api when a repo scope has no fresh cache entry (first open, TTL or
  // failure expiry, reopen). Typing while cached never calls; one request per key+scopes is in flight at a time.
  loadValues(m, list, cx) {
    if (!m.open || m.stage !== "values" || !VALUE_KEYS.has(m.key) || !this.values.stale(m.key, list)) return;
    const id = `${m.key}|${list.join(",")}`;
    if (this.pending.has(id)) return;
    this.pending.add(id);
    cx.spawn(async (cx) => {
      try { await this.values.fetch(m.key, list); } finally { this.pending.delete(id); }
      cx.notify();
    });
  }

  dismiss(cx) {
    this.dismissed = true;
    this.dismissedText = this.input.value();
    cx.notify();
  }

  pick(item, cx) {
    this.cx = cx;
    this.edit(() => this.ctl.pick(item.insert));
    this.hi = -1;
    this.input.focus();
    cx.notify();
  }

  menuView(t, cx) {
    const m = this.menuNow(cx);
    const onKey = (e, cx) => {
      this.skipSubmit = false; // a pending skip belongs to the previous key only
      const m = this.menuNow(cx);
      if (!m.open) return;
      const n = m.items.length;
      if (e.key === "escape") { this.dismiss(cx); return cx.stop_propagation(); }
      if (e.key === "up" || e.key === "down") {
        this.hi = this.hi < 0 ? (e.key === "up" ? n - 1 : 0) : nextIndex(this.hi, n, e.key);
        cx.notify();
        return cx.stop_propagation();
      }
      // Enter picks only a highlighted item; otherwise it falls through to the input's submit.
      if (e.key === "enter" && m.items[this.hi]) { this.pick(m.items[this.hi], cx); this.skipSubmit = true; return cx.stop_propagation(); }
    };
    const content = v_flex().id("filter-menu").w(260).max_h(300).p(4).gap(1).mt(4).rounded(8).border_1().border_color(t.input).bg(t.popover)
      .child(v_flex().id("filter-menu-items").gap(1).overflow_y_scrollbar().children(m.items.map((it, i) =>
        h_flex().id(`fm-${it.id}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .text_size(12).text_color(t.foreground).role("list_box_option")
          .when(i === this.hi, (el) => el.aria_active_descendant().bg(t.selected))
          .hover((s) => s.bg(t.hover))
          // Pick on press, before the input loses focus; a click would arrive after the blur.
          .on_mouse_down("left", (_e, cx) => { this.pick(it, cx); cx.stop_propagation(); })
          // People rows: a plain circle with the login's initial. The host drew nothing for a remote Avatar image, so
          // none is used; it.avatar (a github.com URL) stays in the item data for a follow-up that caches avatars locally.
          .child(it.avatar
            ? div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded_full().bg(t.raised).text_size(9).text_color(t.muted)
              .child(it.label.slice(0, 1).toUpperCase())
            : div().w(14).text_color(t.muted).child(it.glyph))
          .child(div().flex_1().min_w(0).truncate().child(it.label))
          .when(Boolean(it.hint), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(it.hint))))));
    return { open: m.open, content, onKey, onOutside: (_e, cx) => this.dismiss(cx) };
  }

  render(cx) {
    const t = theme();
    this.ensureStarted(cx);
    { const g = gated(MOD); if (g) return g; }
    const list = scopes();
    const snap = shared(SNAPSHOT) ?? {};
    // A removed scope disappears at once, before the next refresh.
    const items = (snap.items ?? []).filter((i) => inScope(i.repo, list));
    const chip = (s) => div().id(`s-${s}`).h(22).px(7).flex_none().flex().items_center().rounded(5).border_1().border_color(t.border)
      .text_size(11).text_color(t.muted).cursor_pointer().hover((x) => x.border_color(t.blocked))
      .on_click((_e, cx) => { setShared(SCOPES, list.filter((x) => x !== s)); this.cx = cx; this.ctl.refresh(); }).child(`${s} ×`);
    const addScope = this.addingScope
      ? Input.new(this.scopeInput).w(170).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12)
      : div().id("add-scope").h(22).px(7).flex_none().flex().items_center().rounded(5).border_1().border_color(t.border)
        .text_size(11).text_color(t.muted).cursor_pointer().hover((x) => x.border_color(t.foreground))
        .on_click((_e, cx) => { this.addingScope = true; cx.notify(); }).child("+ scope");
    const defaultsBtn = this.differsFromDefaults()
      ? div().id("reset-defaults").h(22).px(7).flex_none().flex().items_center().rounded(5).border_1().border_color(t.border)
        .text_size(11).text_color(t.muted).cursor_pointer().hover((x) => x.border_color(t.foreground))
        .on_click((_e, cx) => this.resetDefaults(cx)).child("↺ Defaults")
      : null;
    return sourceList({
      title: "GitHub",
      kind: "github",
      items,
      at: list.length ? snap.at : null,
      partial: snap.partial,
      error: this.inputError ?? this.error ?? (list.length ? null : "No org or repo yet. Click + scope and add one (example-org, or owner/repo)."),
      loading: this.loading,
      empty: emptyText(snap.query ?? this.ctl.model(), list),
      input: this.input,
      menu: this.menuView(t, cx),
      token: (ctx) => div().h(20).px(6).flex().items_center().rounded(5).bg(t.raised).border_1().border_color(ctx.selected ? t.foreground : t.border)
        .text_size(11.5).child(ctx.token.label),
      onTokenClick: (e, cx) => { this.cx = cx; this.edit(() => this.ctl.onTokenClick(e.range)); cx.notify(); },
      inputRight: defaultsBtn ? [addScope, defaultsBtn] : [addScope],
      extra: list.map(chip),
      meta: (i) => [i.pr ? "PR" : "issue", i.state.toLowerCase()],
      tags: (i) => ["github", i.pr ? "pr" : "issue"],
      onRefresh: () => { this.edit(() => this.ctl.onSubmit()); cx.notify(); },
    });
  }
}
