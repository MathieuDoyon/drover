// Drover Jira: read-only list of Jira work from a saved JQL. "+ Board" makes a local card.
// Reads ~/.config/drover-herdr/atlassian.json ({email, apiToken}) and talks only to the site set in Drover Config
// (drover-jira.site, empty by default: the screen then asks for it and makes no request).
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { shared, setShared } from "herdr";
import { jiraPage } from "./sources.js";
import { jiraFetch, JIRA_NO_SITE, JIRA_STALE, modSettings } from "./io.js";
import { bind, load as loadCfg, cfg, isEnabled, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";
import { sourceList } from "./sourcelist.js";

const MOD = "drover-jira";
const SNAPSHOT = "drover.jira.snapshot";
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

export default class Jira extends View {
  init(_props, cx) {
    this.loading = false;
    this.error = null;
    this.ready = false; // the mod.json layer of the config is loaded
    this.lastRun = 0;
    this.gen = 0; // load generation
    this.siteUsed = null; // the site of the latest load
    bind({ shared, modSettings });
    this.input = InputState.new({ placeholder: "JQL (Enter to run)", value: shared("drover.jira.jql") ?? "" });
    this.initialText = this.input.value(); // the configured default JQL is applied later only over this text, never over a typed draft
    this.input.on("submit", (_e, cx) => { setShared("drover.jira.jql", this.input.value()); this.refresh(cx); });
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
      if (this.stopped) { this.stopped = false; this.refresh(cx); }
      return;
    }
    this.started = true;
    this.stopped = false;
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      if (!isEnabled(MOD)) return;
      if (shared("drover.jira.jql") == null && this.input.value() === this.initialText) this.input.set_value(this.defaultJql());
      this.refresh(cx);
    });
  }

  defaultJql() { return cfg(MOD, "jql"); }

  // The error to show: "not configured" follows the effective site at every render, not a stored message.
  errorShown() { return cfg(MOD, "site") ? this.error : `${JIRA_NO_SITE}.`; }

  // Runs on every tick: reconciles a changed site first (even an empty one), then the configured interval.
  tick(cx) {
    if (!this.ready || !isEnabled(MOD)) return;
    const site = cfg(MOD, "site");
    if (!site) { this.gen++; this.siteUsed = null; this.loading = false; return cx.notify(); }
    if (site !== this.siteUsed || Date.now() - this.lastRun >= cfg(MOD, "refresh_minutes") * 60 * 1000) this.refresh(cx);
  }

  refresh(cx) {
    if (!this.ready || !isEnabled(MOD)) return;
    const site = cfg(MOD, "site");
    if (!site) { // not configured: no credential read, no request; any load in flight is dropped
      this.gen++; this.siteUsed = null; this.loading = false;
      return cx.notify();
    }
    if (this.loading && this.siteUsed === site) return;
    const gen = ++this.gen; // a newer load (or a cleared site) invalidates this one
    this.siteUsed = site;
    this.loading = true;
    this.error = null;
    this.lastRun = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      const current = () => gen === this.gen && isEnabled(MOD) && cfg(MOD, "site") === site;
      try {
        const snap = await load(site, this.input.value().trim() || this.defaultJql(), cfg(MOD, "pages"), current);
        if (current()) { setShared(SNAPSHOT, snap); this.error = null; }
      } catch (e) {
        if (e !== STALE && current()) this.error = String(e?.message ?? e);
      }
      if (gen === this.gen) this.loading = false;
      cx.notify();
    });
  }

  render(cx) {
    this.ensureStarted(cx);
    { const g = gated(MOD); if (g) return g; }
    const snap = shared(SNAPSHOT) ?? {};
    return sourceList({
      title: "Jira",
      kind: "jira",
      items: snap.items,
      at: snap.at,
      partial: snap.partial,
      error: this.errorShown(),
      loading: this.loading,
      empty: "No issues match this JQL.",
      input: this.input,
      meta: (i) => [i.status, i.type, i.priority],
      tags: () => ["jira"],
      onRefresh: () => this.refresh(cx),
    });
  }
}
