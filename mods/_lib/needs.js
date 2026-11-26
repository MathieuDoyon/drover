// Needs-you view (T-MWO2HFFHWRB): which group each card sits in, and the counts. Pure and memory-only: no I/O, no globals.
// needsCounts() derives; createNeedsCache() keeps the last result. refresh() runs OUTSIDE render (init and a timer), get() only reads memory.
import { attention, sorted } from "./store.js";
import { liveAgents, reviewLive, dotKind, runStatus } from "./runs.js";
import { lineOf } from "./runline.js";
import { createAsksState, askReason } from "./asks.js";
import { isDismissed } from "./dismiss.js";

export const GROUP_IDS = ["needs", "review", "working", "todo", "blocked"];

// One card = one key. Cards of different boards can share an id (a local card and a remote one, or two remote boards), so a remote card is
// qualified by its machine and remote project; a local card keeps its bare id. Actions (focus, edit, done) keep using task.id.
export const cardKey = (task) => (task.remote ? `${task.remote.machine}/${task.remote.projectId ?? task.project ?? ""}/${task.id}` : task.id);

// Oldest first: the card that has waited longest. `created` ascending, then key; an edit never reorders.
const oldest = (a, b) => (a.created ?? 0) - (b.created ?? 0) || cardKey(a).localeCompare(cardKey(b));

// Failed automation the owner has not dealt with: a wakeup that failed or expired in the last 24 h and is still enabled. Pure: `now` is passed in.
// Deleting, disabling or rescheduling the wakeup (status back to scheduled) removes the row; so does the window passing.
export const WAKE_WINDOW = 24 * 3600000;
const WAKE_REASON = { failed: "Wakeup delivery failed", expired: "Wakeup didn't start" };
export function wakeAttention(wakes, now) {
  if (!Array.isArray(wakes) || !Number.isFinite(now)) return [];
  return wakes.filter((w) => w && WAKE_REASON[w.status] && w.enabled !== false && Number.isFinite(w.at) && w.at <= now && now - w.at <= WAKE_WINDOW)
    .map((w) => ({ kind: "wake", key: `wake/${w.id}`, at: w.at, reason: WAKE_REASON[w.status], wake: w }));
}

// tasks: every card (no filter, remote cards included). live: Map address -> { status } (liveAgents). alive: Set of terminal addresses.
// runs: the run records (for the review-live dot). wakes + now: the wakeup records and the clock (failed automation joins Needs you).
// Returns { rows: Map key -> { group, reason, dot }, byGroup: { group: [key] } (cards only), attention: [{ kind: "card"|"wake", key, at, reason }] oldest first,
// counts, lines: Map key -> { text, progress, ageMin, stale } of each LOCAL card's live run line (see lineViews) } (key: cardKey). counts.needs is the length of `attention`: what the page, the switch and the chip show.
// asks: Map terminal -> { id, kind, tool } (the asks reader, B4b). It only replaces the REASON of a card that is in Needs you because its live agent is blocked:
// no ask (no hooks, an unknown scan) keeps the fallback reason, and no group or count ever depends on it.
// dismissed: { key: { reason, at } } (dismiss.js). A dismissed row (same key and reason) moves from `attention` to `hidden` (same shape), so counts.needs,
// the page, the switch and the chip all drop it; the card keeps its group. A card row has `gone`: its agent is not alive (else it is blocked on a question).
export function needsCounts(tasks, live, alive, runs = [], wakes = [], now = Date.now(), asks = new Map(), dismissed = {}) {
  const statuses = new Map([...live].map(([k, v]) => [k, v?.status]).filter(([, s]) => s));
  const rows = new Map();
  const byGroup = Object.fromEntries(GROUP_IDS.map((g) => [g, []]));
  const placed = [];
  for (const task of tasks) {
    const at = attention(task, live, alive);
    if (!at) continue;
    // A remote card has no run or terminal on this machine: never match it to a local run that happens to share its bare id.
    const ask = at.group === "needs" && !task.remote && task.agent && alive.has(task.agent) && live.get(task.agent)?.status === "blocked" ? asks.get(task.agent) : null;
    rows.set(cardKey(task), { group: at.group, reason: (ask && askReason(ask)) || at.reason, dot: dotKind(at.group, !task.remote && reviewLive(task, runs, statuses, alive)) });
    placed.push(task);
  }
  for (const t of sorted(placed)) byGroup[rows.get(cardKey(t)).group].push(t);
  byGroup.needs = byGroup.needs.slice().sort(oldest);
  const needCards = byGroup.needs;
  for (const g of GROUP_IDS) byGroup[g] = byGroup[g].map(cardKey);
  const every = [...needCards.map((t) => ({ kind: "card", key: cardKey(t), at: t.created ?? 0, reason: rows.get(cardKey(t)).reason, gone: !(t.agent && alive.has(t.agent)) })), ...wakeAttention(wakes, now)]
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const list = every.filter((a) => !isDismissed(dismissed, a)), hidden = every.filter((a) => isDismissed(dismissed, a));
  const counts = Object.fromEntries(GROUP_IDS.map((g) => [g, byGroup[g].length]));
  counts.needs = list.length;
  return { rows, byGroup, attention: list, hidden, counts, lines: lineViews(tasks, runs, statuses, alive, now) };
}

// The live run line (drover line) of each LOCAL card: from the latest started run of the card that is still active (not stamped ended, not ended by the
// live state), through lineOf. A remote card has no run on this machine and gets none, even when a local run shares its bare id. Derived here, once per
// refresh; a screen's render only does lines.get(cardKey(task)). The view carries ageMin and stale, so the result changes once a minute, not each second.
function lineViews(tasks, runs, statuses, alive, now) {
  const lines = new Map();
  const best = new Map(); // task id -> { run, status } with the greatest numeric `started` (no started counts as 0; the list order breaks ties: newest first)
  for (const r of runs) {
    if (!r?.task || r.ended != null || !Array.isArray(r.terminals) || !r.terminals.length) continue;
    const status = runStatus(r, statuses, alive);
    if (status === "ended") continue;
    const cur = best.get(r.task);
    if (!cur || (Number.isFinite(r.started) ? r.started : 0) > (Number.isFinite(cur.run.started) ? cur.run.started : 0)) best.set(r.task, { run: r, status });
  }
  for (const task of tasks) {
    if (task.remote) continue;
    const hit = best.get(task.id);
    const view = hit ? lineOf(hit.run, hit.status, now) : null;
    if (view) lines.set(cardKey(task), view);
  }
  return lines;
}

const EXTRA = { tasks: [], byId: new Map(), remotes: [], controls: {}, agentAddrs: new Set(), live: new Map() };
const EMPTY = Object.freeze({ ...needsCounts([], new Map(), new Set(), []), ...EXTRA });
// Structural (JSON), never delimiter-joined: a valid line text may contain any delimiter and must not collide with another set of lines.
const linesSig = (v) => JSON.stringify([...v.lines].map(([k, l]) => [k, l.text, l.progress, l.ageMin, l.stale]));
const signatureOf = (v) => linesSig(v) + "##" + v.hidden.map((a) => `${a.key}|${a.reason}`).join(",") + "##" + v.attention.map((a) => `${a.key}|${a.reason}|${a.gone ?? ""}|${a.at}|${a.wake ? `${a.wake.name ?? ""}|${a.wake.target ?? ""}|${a.wake.reason ?? ""}` : ""}`).join(",") + "#" + GROUP_IDS.map((g) => `${g}:${v.byGroup[g].map((id) => { const r = v.rows.get(id); return `${id}|${r.reason ?? ""}|${r.dot}`; }).join(",")}`).join(";");
// What else a screen draws from the cache must also change the signature, or the screen would not repaint: the card fields a row shows,
// the remote banners, the remote write controls and the set of live pane agents.
const fingerprintOf = (v) => [
  v.tasks.map((t) => `${cardKey(t)}|${t.rev ?? ""}|${t.updated ?? ""}|${t.title}|${t.priority}|${(t.tags ?? []).join(",")}|${t.project ?? ""}|${t.column}`).join("\n"),
  v.remotes.map((r) => `${r.localId}|${r.state}|${r.banner ?? ""}`).join("\n"),
  Object.keys(v.controls).sort().map((k) => `${k}|${v.controls[k]?.on}|${v.controls[k]?.tip ?? ""}`).join("\n"),
  [...v.agentAddrs].sort().join(","),
].join("\u0001");

// read() returns { tasks, runs, agents, terminals, wakes } (one read of each), plus optional { remotes, controls: { projectId: { on, tip } } } for a
// screen with remote cards, optional { dismissed } (the shared Dismiss map), and optional { asksScan } (the asks reader's last result held in memory: { ok: true, files: Map } or unknown; none = no hooks).
// The asks state (which ask is still valid) is updated HERE, once per refresh, where the live statuses are known. refresh() recomputes and returns true when the result really changed.
// get() returns the stored value and never computes; each refresh stores a NEW value, so a reader holding the old one is safe.
export function createNeedsCache({ read, now = () => Date.now() }) {
  let value = { ...EMPTY, at: 0 };
  let sig = signatureOf(value) + fingerprintOf(value);
  const asksState = createAsksState();
  return {
    get: () => value,
    signature: () => sig,
    refresh() {
      const { tasks = [], runs = [], agents = [], terminals = [], remotes = [], controls = {}, wakes = [], asksScan = null, dismissed = {} } = read();
      const alive = new Set(terminals.map((x) => x.address));
      const live = liveAgents(agents, terminals);
      const asks = asksState.update({ scan: asksScan, statuses: new Map([...live].map(([k, v]) => [k, v?.status])), alive, now: now() });
      const next = { ...needsCounts(tasks, live, alive, runs, wakes, now(), asks, dismissed), tasks, byId: new Map(tasks.map((t) => [cardKey(t), t])), remotes, controls, agentAddrs: new Set(agents.map((a) => a.address)), live };
      const nextSig = signatureOf(next) + fingerprintOf(next);
      const changed = nextSig !== sig;
      value = { ...next, at: now() };
      sig = nextSig;
      return changed;
    },
  };
}
