// Needs-you view (T-MWO2HFFHWRB): which group each card sits in, and the counts. Pure and memory-only: no I/O, no globals.
// needsCounts() derives; createNeedsCache() keeps the last result. refresh() runs OUTSIDE render (init and a timer), get() only reads memory.
import { attention, sorted } from "./store.js";
import { liveAgents, reviewLive, dotKind } from "./runs.js";

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
// counts } (key: cardKey). counts.needs is the length of `attention`: what the page, the switch and the chip show.
export function needsCounts(tasks, live, alive, runs = [], wakes = [], now = Date.now()) {
  const statuses = new Map([...live].map(([k, v]) => [k, v?.status]).filter(([, s]) => s));
  const rows = new Map();
  const byGroup = Object.fromEntries(GROUP_IDS.map((g) => [g, []]));
  const placed = [];
  for (const task of tasks) {
    const at = attention(task, live, alive);
    if (!at) continue;
    // A remote card has no run or terminal on this machine: never match it to a local run that happens to share its bare id.
    rows.set(cardKey(task), { group: at.group, reason: at.reason, dot: dotKind(at.group, !task.remote && reviewLive(task, runs, statuses, alive)) });
    placed.push(task);
  }
  for (const t of sorted(placed)) byGroup[rows.get(cardKey(t)).group].push(t);
  byGroup.needs = byGroup.needs.slice().sort(oldest);
  const needCards = byGroup.needs;
  for (const g of GROUP_IDS) byGroup[g] = byGroup[g].map(cardKey);
  const list = [...needCards.map((t) => ({ kind: "card", key: cardKey(t), at: t.created ?? 0, reason: rows.get(cardKey(t)).reason })), ...wakeAttention(wakes, now)]
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const counts = Object.fromEntries(GROUP_IDS.map((g) => [g, byGroup[g].length]));
  counts.needs = list.length;
  return { rows, byGroup, attention: list, counts };
}

const EXTRA = { tasks: [], byId: new Map(), remotes: [], controls: {}, agentAddrs: new Set(), live: new Map() };
const EMPTY = Object.freeze({ ...needsCounts([], new Map(), new Set(), []), ...EXTRA });
const signatureOf = (v) => v.attention.map((a) => `${a.key}|${a.reason}|${a.at}|${a.wake ? `${a.wake.name ?? ""}|${a.wake.target ?? ""}|${a.wake.reason ?? ""}` : ""}`).join(",") + "#" + GROUP_IDS.map((g) => `${g}:${v.byGroup[g].map((id) => { const r = v.rows.get(id); return `${id}|${r.reason ?? ""}|${r.dot}`; }).join(",")}`).join(";");
// What else a screen draws from the cache must also change the signature, or the screen would not repaint: the card fields a row shows,
// the remote banners, the remote write controls and the set of live pane agents.
const fingerprintOf = (v) => [
  v.tasks.map((t) => `${cardKey(t)}|${t.rev ?? ""}|${t.updated ?? ""}|${t.title}|${t.priority}|${(t.tags ?? []).join(",")}|${t.project ?? ""}|${t.column}`).join("\n"),
  v.remotes.map((r) => `${r.localId}|${r.state}|${r.banner ?? ""}`).join("\n"),
  Object.keys(v.controls).sort().map((k) => `${k}|${v.controls[k]?.on}|${v.controls[k]?.tip ?? ""}`).join("\n"),
  [...v.agentAddrs].sort().join(","),
].join("\u0001");

// read() returns { tasks, runs, agents, terminals, wakes } (one read of each), plus optional { remotes, controls: { projectId: { on, tip } } } for a
// screen with remote cards. refresh() recomputes and returns true when the result really changed.
// get() returns the stored value and never computes; each refresh stores a NEW value, so a reader holding the old one is safe.
export function createNeedsCache({ read, now = () => Date.now() }) {
  let value = { ...EMPTY, at: 0 };
  let sig = signatureOf(value) + fingerprintOf(value);
  return {
    get: () => value,
    signature: () => sig,
    refresh() {
      const { tasks = [], runs = [], agents = [], terminals = [], remotes = [], controls = {}, wakes = [] } = read();
      const alive = new Set(terminals.map((x) => x.address));
      const live = liveAgents(agents, terminals);
      const next = { ...needsCounts(tasks, live, alive, runs, wakes, now()), tasks, byId: new Map(tasks.map((t) => [cardKey(t), t])), remotes, controls, agentAddrs: new Set(agents.map((a) => a.address)), live };
      const nextSig = signatureOf(next) + fingerprintOf(next);
      const changed = nextSig !== sig;
      value = { ...next, at: now() };
      sig = nextSig;
      return changed;
    },
  };
}
