// Drover Jira: read-only list of Jira work from a filter of atomic tokens (status:Done, assignee:me, ...) built into JQL.
// "+ Board" makes a local card. The default filter is the Config JQL as one raw jql:"..." token.
// Reads ~/.config/drover-herdr/atlassian.json ({email, apiToken}) and talks only to the site set in Drover Config
// (drover-jira.site, empty by default: the screen then asks for it and makes no request).
import { View, div } from "gpui-kit";
import { InputState } from "gpui-base";
import { shared, setShared, theme } from "herdr";
import { jiraPage } from "./sources.js";
import { QUERY_KEY, restoreContent, contentFromModel, createController, jqlModel, toJql } from "./query.js";
import { menuState } from "./menu.js";
import { menuView, tokenChip } from "./filterui.js";
import { createValues, valuesFor } from "./values.js";
import { jiraFetch, JIRA_NO_SITE, JIRA_STALE, modSettings } from "./io.js";
import { bind, load as loadCfg, cfg, isEnabled, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";
import { sourceList } from "./sourcelist.js";

const MOD = "drover-jira";
const SNAPSHOT = "drover.jira.snapshot";
const LEGACY_JQL = "drover.jira.jql"; // the old plain-JQL input: read once as the default of a person who never saved a query
const VALUE_KEYS = new Set(["project", "status", "assignee", "reporter", "type", "label", "priority"]);
const TICK_MS = 60 * 1000; // the configured refresh minutes are checked on each tick, so a change applies live

// current() is checked before every page request: a load whose site (or generation) changed stops asking and throws STALE.
const STALE = JIRA_STALE;
async function load(site, jql, pages, current) {
  const items = [];
  let next = null;
  for (let page = 0; page < pages; page++) {
    if (!current()) throw STALE;
    const json = await jiraFetch(site, "/rest/api/3/search/jql", { method: "POST",
      body: JSON.stringify({ jql, maxResults: 50, fields: ["summary", "status", "priority", "issuetype", "updated"], ...(next ? { nextPageToken: next } : {}) }) }, current);
    if (!current()) throw STALE;
    const p = jiraPage(json, site);
    items.push(...p.items);
    next = p.next;
    if (!next) break;
  }
  return { items, partial: Boolean(next), at: Date.now() };
}

const defaultsBtn = (t, onClick) => div().id("reset-defaults").h(22).px(7).flex_none().flex().items_center().rounded(5).border_1().border_color(t.border)
  .text_size(11).text_color(t.muted).cursor_pointer().hover((x) => x.border_color(t.foreground))
  .on_click((_e, cx) => onClick(cx)).child("↺ Defaults");

export default class Jira extends View {
  init(_props, cx) {
    this.loading = false;
    this.error = null;
    this.ready = false; // the mod.json layer of the config is loaded
    this.lastRun = 0;
    this.gen = 0; // load generation
    this.siteUsed = null; // the site of the latest load
    bind({ shared, modSettings });
    this.focused = false;
    this.dismissed = false;
    this.hi = -1;
    this.menuKey = "";
    this.skipSubmit = false;
    this.focusSeq = 0;
    this.pending = new Set(); // value keys with a request in flight
    this.values = createValues({ fetch: jiraFetch, site: () => cfg(MOD, "site"), enabled: () => isEnabled(MOD) });
    this.input = InputState.new({ placeholder: "status:Done assignee:me … (Enter applies)" });
    this.input.set_value(this.startContent());
    this.initialText = this.input.value(); // the configured default is applied later only over this text, never over a typed draft
    this.ctl = createController({
      input: this.input,
      scopes: () => [],
      save: (content) => setShared(QUERY_KEY, content),
      enqueue: () => this.refresh(this.cx, true),
      defaults: () => this.configuredContent(),
    });
    // Typing key:value + space turns the word into a chip; Enter converts an unfinished word.
    const guard = (fn) => (_e, cx) => { this.cx = cx; this.edit(fn); cx.notify(); };
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
    this.cx = cx;
    this.inputError = null;
    this.started = false; // the timer and the config load start once, the first time the screen is on
    this.stopped = false; // seen switched off since the last render that was on: reload when it comes back
    // The screen's own mod.json settings (an inherited enabled) load before the gate starts any work; then it re-renders.
    cx.spawn(async (cx) => { await loadCfg(MOD); this.ready = true; this.ensureStarted(cx); cx.notify(); });
  }

  // Idempotent. Off: nothing starts (no timer, no mod.json read, no credential read, no request); a load in flight is
  // invalidated (gen) and its result dropped. On: the timer and the first load start once; coming back reloads.
  ensureStarted(cx) {
    if (!isEnabled(MOD)) {
      if (!this.stopped) { this.stopped = true; this.gen++; this.loading = false; }
      return;
    }
    if (!cfgReady(MOD)) return;
    if (this.started) {
      // Back from off: reload after the render (refresh notifies, and a render must not).
      if (this.stopped) { this.stopped = false; cx.spawn(async (cx) => this.refresh(cx)); }
      return;
    }
    this.started = true;
    this.stopped = false;
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      if (!isEnabled(MOD)) return;
      if (this.noSavedQuery() && this.input.value() === this.initialText) this.input.set_value(this.configuredContent());
      this.cx = cx;
      this.ctl.adopt();
    });
  }

  defaultJql() { return cfg(MOD, "jql"); }
  configuredContent() { return contentFromModel(jqlModel(this.defaultJql())); }
  // The old plain-JQL input, trimmed; blank counts as never saved (the Config default then applies, also once it has loaded).
  legacyJql() { const l = shared(LEGACY_JQL); return typeof l === "string" ? l.trim() : ""; }
  noSavedQuery() { return restoreContent(shared(QUERY_KEY), null) === null && !this.legacyJql(); }
  // The saved query; else the legacy JQL as a jql: token; else the Config default.
  startContent() {
    const saved = restoreContent(shared(QUERY_KEY), null);
    if (saved) return saved;
    return this.legacyJql() ? contentFromModel(jqlModel(this.legacyJql())) : this.configuredContent();
  }

  // A failed token edit keeps its own error until the next edit succeeds; loads never clear it.
  edit(fn) {
    try { fn(); this.inputError = null; } catch (e) { this.inputError = `Token input failed: ${String(e?.message ?? e)}`; }
  }

  // The JQL of the committed query; an empty query loads the Config JQL. Throws on an invalid sort.
  jql() { return toJql(this.ctl.model()) || this.defaultJql(); }

  differsFromDefaults() {
    return JSON.stringify(this.ctl.model()) !== JSON.stringify(jqlModel(this.defaultJql()));
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
    const values = {};
    for (const k of VALUE_KEYS) values[k] = valuesFor(k, this.values);
    const m = menuState(this.input.content(), undefined, { values, defaultText: this.defaultJql() });
    this.loadValues(m, cx);
    const key = `${m.stage}|${m.key}|${m.typed}|${m.negated}|${m.items.length}`;
    if (key !== this.menuKey) {
      this.menuKey = key;
      // Nothing is highlighted until something is typed (or Up/Down), so Enter on an empty input still commits.
      this.hi = m.open && m.typed ? 0 : -1;
    }
    return m;
  }

  // The values stage of a Jira key asks the REST API when nothing fresh is cached (never when Jira is off or has no site).
  loadValues(m, cx) {
    if (!m.open || m.stage !== "values" || !VALUE_KEYS.has(m.key) || !this.values.stale(m.key)) return;
    if (this.pending.has(m.key)) return;
    this.pending.add(m.key);
    cx.spawn(async (cx) => {
      try { await this.values.fetch(m.key); } finally { this.pending.delete(m.key); }
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

  menuView(t, cx) { return menuView(this, t, cx); }

  // The error to show: "not configured" follows the effective site at every render, not a stored message.
  errorShown() { return cfg(MOD, "site") ? this.error : `${JIRA_NO_SITE}.`; }

  // Runs on every tick: reconciles a changed site first (even an empty one), then the configured interval.
  tick(cx) {
    if (!this.ready || !isEnabled(MOD)) return;
    const site = cfg(MOD, "site");
    if (!site) { this.gen++; this.siteUsed = null; this.loading = false; return cx.notify(); }
    if (site !== this.siteUsed || Date.now() - this.lastRun >= cfg(MOD, "refresh_minutes") * 60 * 1000) this.refresh(cx);
  }

  // force: a new query replaces a load in flight (its result is dropped by current()); the timer and tick never force.
  refresh(cx, force = false) {
    this.cx = cx;
    if (!this.ready || !isEnabled(MOD)) return;
    const site = cfg(MOD, "site");
    if (!site) { // not configured: no credential read, no request; any load in flight is dropped
      this.gen++; this.siteUsed = null; this.loading = false;
      return cx.notify();
    }
    if (!force && this.loading && this.siteUsed === site) return;
    let jql;
    try { jql = this.jql(); } catch (e) { this.error = String(e?.message ?? e); return cx.notify(); }
    const gen = ++this.gen; // a newer load (or a cleared site) invalidates this one
    this.siteUsed = site;
    this.loading = true;
    this.error = null;
    this.lastRun = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      const current = () => gen === this.gen && isEnabled(MOD) && cfg(MOD, "site") === site;
      try {
        const snap = await load(site, jql, cfg(MOD, "pages"), current);
        if (current()) { setShared(SNAPSHOT, snap); this.error = null; }
      } catch (e) {
        if (e !== STALE && current()) this.error = String(e?.message ?? e);
      }
      if (gen === this.gen) this.loading = false;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    this.ensureStarted(cx);
    { const g = gated(MOD); if (g) return g; }
    const snap = shared(SNAPSHOT) ?? {};
    return sourceList({
      title: "Jira",
      kind: "jira",
      items: snap.items,
      at: snap.at,
      partial: snap.partial,
      error: this.inputError ?? this.errorShown(),
      loading: this.loading,
      empty: "No issues match this filter.",
      input: this.input,
      menu: this.menuView(t, cx),
      token: tokenChip(t),
      onTokenClick: (e, cx) => { this.cx = cx; this.edit(() => this.ctl.onTokenClick(e.range)); cx.notify(); },
      inputRight: this.differsFromDefaults() ? [defaultsBtn(t, (cx) => this.resetDefaults(cx))] : [],
      meta: (i) => [i.status, i.type, i.priority],
      tags: () => ["jira"],
      onRefresh: () => { this.edit(() => this.ctl.onSubmit()); cx.notify(); },
    });
  }
}
