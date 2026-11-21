// Jump palette (T-MWO2HHG9G6S): one list of every card, run and project, filtered as you type. Pure and memory-only: no I/O, no globals.
// jumpIndex() derives the list, jumpFilter() narrows it, createJumpCache() keeps the last result. refresh() and setQuery() run OUTSIDE render
// (init, a timer, the field's change handler); get() only reads memory, so a render costs the same at 3 or 300 cards.
import { cardKey } from "./needs.js";
import { liveStatuses, runStatus, openCommand } from "./runs.js";
import { projectOf } from "./store.js";
import { showPage, COLUMN } from "./needsnav.js";

export const JUMP_LIMIT = 50;
export const TASKS_FILTERS = "drover.tasks.filters"; // the Tasks panel's filter state, per space as "<key>:<space>" (mods/drover-tasks/main.js)
export const filtersKey = (space) => (space ? `${TASKS_FILTERS}:${space}` : TASKS_FILTERS);

const lowerOf = (...parts) => parts.filter((p) => p != null && p !== "").join(" ").toLowerCase();
const statusWord = (run, live, alive) => {
  const s = runStatus({ ...run, terminals: run.terminals ?? [] }, live, alive);
  return s === "stopped" ? "running" : s; // a live member that is neither working nor blocked is still running
};

// -> frozen [{ kind: "card" | "run" | "project", key, label, sub, lower }]: cards, then runs, then projects (the order a tie keeps).
// live: Map address -> status (liveStatuses). alive: Set of terminal addresses. A done card is included (its column shows in `sub`).
export function jumpIndex({ tasks = [], runs = [], projects = [], live = new Map(), alive = new Set() } = {}) {
  const byId = new Map(tasks.filter((t) => !t.remote).map((t) => [t.id, t]));
  const out = [];
  for (const t of tasks) {
    const project = projectOf(t, projects)?.name;
    const sub = [t.id, t.column, project, t.remote?.machine].filter(Boolean).join(" · ");
    out.push({ kind: "card", key: `card:${cardKey(t)}`, label: t.title ?? t.id ?? "", sub, lower: lowerOf(t.title, sub) });
  }
  for (const r of runs) {
    const card = byId.get(r.task);
    const status = statusWord(r, live, alive);
    const sub = [r.id, status, r.task].filter(Boolean).join(" · ");
    out.push({ kind: "run", key: `run:${r.id}`, label: card?.title ?? r.title ?? r.task ?? r.id ?? "", sub, lower: lowerOf(card?.title ?? r.title, sub) });
  }
  for (const p of projects) out.push({ kind: "project", key: `project:${p.id}`, label: p.name ?? p.id ?? "", sub: p.id ?? "", lower: lowerOf(p.name, p.id) });
  return Object.freeze(out);
}

// Rank of one token: 0 = the label starts with it, 1 = a word of the label starts with it, 2 = it is somewhere in the haystack, null = no match.
function rankOf(item, token) {
  const label = String(item.label).toLowerCase();
  if (label.startsWith(token)) return 0;
  for (let i = label.indexOf(token); i >= 0; i = label.indexOf(token, i + 1)) if (!/[a-z0-9]/.test(label[i - 1] ?? " ")) return 1;
  return item.lower.includes(token) ? 2 : null;
}

// Every token must match. Lower total rank first, then index order (stable). No query: the first `limit` of the index.
export function jumpFilter(index, query, limit = JUMP_LIMIT) {
  const tokens = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return Object.freeze(index.slice(0, limit));
  const hits = [];
  index.forEach((item, i) => {
    let score = 0;
    for (const t of tokens) { const r = rankOf(item, t); if (r == null) return; score += r; }
    hits.push({ item, score, i });
  });
  hits.sort((a, b) => a.score - b.score || a.i - b.i);
  return Object.freeze(hits.slice(0, limit).map((h) => h.item));
}

// Selection is a result KEY. After typing: the first. After a refresh: kept when still listed, else the first. Up/Down clamp. Nothing listed: null.
export const firstKey = (results) => results[0]?.key ?? null;
export const keepKey = (results, sel) => (results.some((x) => x.key === sel) ? sel : firstKey(results));
export function moveKey(results, sel, delta) {
  if (!results.length) return null;
  const i = results.findIndex((x) => x.key === sel);
  return results[Math.max(0, Math.min(results.length - 1, (i < 0 ? 0 : i) + delta))].key;
}

// What Enter does for a result, from the CURRENT snapshot (a card, run or project removed since the list was drawn gives null).
// -> { type: "focus", command, terminal } | { type: "edit", id, task } | { type: "runs" } | { type: "project", id } | null
export function jumpTarget(item, snap) {
  if (!item || !snap) return null;
  const id = item.key.slice(item.key.indexOf(":") + 1);
  if (item.kind === "card") {
    const task = snap.byCard.get(id);
    if (!task) return null;
    if (task.remote) return { type: "edit", id: task.id, task }; // read-only view of another machine's card
    if (task.agent && snap.agentAddrs.has(task.agent)) return { type: "focus", command: "agent.focus", terminal: task.agent };
    return { type: "edit", id: task.id, task: null };
  }
  if (item.kind === "run") {
    const run = snap.runs.get(id);
    if (!run) return null;
    const m = (run.terminals ?? []).find((x) => snap.alive.has(x.address));
    return m ? { type: "focus", command: openCommand({ parked: m.parked, role: m.role }), terminal: m.address } : { type: "runs" };
  }
  if (item.kind === "project") return snap.projects.has(id) ? { type: "project", id } : null;
  return null;
}

// The Tasks filter a project jump writes: the whole object is replaced, so no other filter hides the project's cards.
export const projectFilter = (space, id) => ({ key: filtersKey(space), value: { project: [id] } });
// A project jump can start with the `drover` column hidden (its own toggle): show the parent first, then Room + Tasks (needsnav's room page).
export const projectPage = () => [["layout.show", { id: COLUMN }], ...showPage("room")];
// Tasks keeps its text query in the instance. A project jump leaves a token here (per space, like the filters); Tasks reads it in a timer, never in render.
export const QUERY_RESET = "drover.tasks.query-reset";
export const queryResetKey = (space) => (space ? `${QUERY_RESET}:${space}` : QUERY_RESET);

const EMPTY = Object.freeze({ index: Object.freeze([]), results: Object.freeze([]), query: "", snap: Object.freeze({ byCard: new Map(), runs: new Map(), projects: new Set(), agentAddrs: new Set(), alive: new Set() }) });
const signatureOf = (index) => index.map((x) => `${x.key}|${x.label}|${x.sub}`).join("\n");

// read() returns { tasks, projects, runs, agents, terminals } (one read of each). refresh() recomputes (index, snapshot, results for the current
// query) and returns true when the index really changed. setQuery() re-filters only. get() returns the stored value and never computes;
// each refresh/setQuery stores a NEW value, so a reader holding the old one is safe.
export function createJumpCache({ read }) {
  let value = EMPTY, sig = "", query = "";
  return {
    get: () => value,
    query: () => query,
    setQuery(q) { query = String(q ?? ""); value = { ...value, query, results: jumpFilter(value.index, query) }; },
    refresh() {
      const { tasks = [], projects = [], runs = [], agents = [], terminals = [] } = read() ?? {};
      const alive = new Set(terminals.map((x) => x.address));
      const live = liveStatuses(agents, terminals);
      const index = jumpIndex({ tasks, runs, projects, live, alive });
      const snap = { byCard: new Map(tasks.map((t) => [cardKey(t), t])), runs: new Map(runs.map((r) => [r.id, r])), projects: new Set(projects.map((p) => p.id)), agentAddrs: new Set(agents.map((a) => a.address)), alive };
      const next = signatureOf(index);
      const changed = next !== sig;
      sig = next;
      value = { index, results: jumpFilter(index, query), query, snap };
      return changed;
    },
  };
}
