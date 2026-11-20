// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// A project bound to another machine: the laptop reads that machine's board, read-only (T-MWHVWQNL2HA).
// Pure logic: the hc runner and the shared-state accessors are injected. Nothing here writes to the remote machine.
// The remote shared.json is untrusted and holds secrets-adjacent keys (layout, runs, wakeups): only drover.tasks and
// drover.projects and (ids and display names only) drover.agents are read; the cache is { at, tasks, picks } and nothing else is stored or logged.

import { config } from "./runs.js";

export const SHARED_PATH = ".config/herdr-app/shared.json";
export const MAX_BYTES = 2 * 1024 * 1024;
export const POLL_MS = 15000; // normal poll
export const SLOW_MS = 60000; // backoff cap
export const SLOW_AFTER = 5; // failures before the cap
export const TIMEOUT_MS = 10000; // one read
export const TICK_MS = 1000; // how often the owner of the timer calls tick()
export const CACHE_PREFIX = "drover.remote.";
export const READONLY_TIP = "This project lives on another machine (read-only for now)";

// The mod runtime has no Buffer or TextEncoder: count UTF-8 bytes by hand (a lone surrogate counts 3), as runs.js does.
function utf8Bytes(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export const validMachine = (s) => typeof s === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(s);
export const validProjectId = (s) => typeof s === "string" && /^P-[A-Z0-9]+$/.test(s);
export const cacheKey = (machine, projectId) => `${CACHE_PREFIX}${machine}.${projectId}`;
export const readDelay = (failures) => (failures >= SLOW_AFTER ? SLOW_MS : POLL_MS);

const PICK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const pickName = (v, id) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : id);
// The picker data from the remote machine's shared.json: who a card can be assigned to ({kind,id,name}: no command, soul, env or member list) and the
// projects a card can move to ({id,name}: not one owned by another machine, no repos or folders). An unset drover.agents is the consumer's
// own default herd, as config() reads it there.
function picksOf(doc) {
  const cfg = config(doc["drover.agents"]);
  const assignees = [];
  for (const [kind, list] of [["agent", cfg.agents], ["squad", cfg.squads]]) {
    for (const x of Array.isArray(list) ? list : []) if (x && typeof x.id === "string" && PICK_ID.test(x.id)) assignees.push({ kind, id: x.id, name: pickName(x.name, x.id) });
  }
  const projects = (Array.isArray(doc["drover.projects"]) ? doc["drover.projects"] : [])
    .filter((p) => p && validProjectId(p.id) && !p.remote).map((p) => ({ id: p.id, name: pickName(p.name, p.id) }));
  return { assignees, projects };
}

// The text of the remote shared.json -> { tasks, projectIds, picks } or { error }. Only the 3 keys are looked at.
// The error is a fixed code, never the payload.
export function parseRemote(text, projectId) {
  if (typeof text !== "string") return { error: "empty answer" };
  if (text.length > MAX_BYTES || utf8Bytes(text) > MAX_BYTES) return { error: "file over 2 MiB" };
  let doc;
  try { doc = JSON.parse(text); } catch { return { error: "invalid JSON" }; }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { error: "invalid JSON" };
  const tasks = Array.isArray(doc["drover.tasks"]) ? doc["drover.tasks"] : [];
  const projects = Array.isArray(doc["drover.projects"]) ? doc["drover.projects"] : [];
  return {
    tasks: tasks.filter((t) => t && typeof t === "object" && t.project === projectId && !t.archived),
    projectIds: projects.map((p) => p?.id).filter((id) => typeof id === "string"),
    picks: picksOf(doc),
  };
}

// ---- ownership: the laptop never produces a card for a project that lives on another machine ----
export const remoteOf = (projects, projectId) => {
  const p = Array.isArray(projects) && projectId ? projects.find((x) => x.id === projectId) : null;
  return p?.remote && validMachine(p.remote.machine) ? p.remote : null;
};
// Where a card or run lives, as the editor and the room show it: the herdr machine name (a bound project, else a `machine/tN` terminal address), else "Local".
export const machineOf = (projects, projectId, address) => {
  const bound = remoteOf(projects, projectId)?.machine;
  if (bound) return bound;
  const m = typeof address === "string" ? /^([^/]+)\/t[A-Za-z0-9]+$/.exec(address) : null;
  return m && validMachine(m[1]) ? m[1] : "Local";
};
// An error text when `projectId` is remote-owned (naming the machine), else null.
export function ownerError(projects, projectId) {
  const r = remoteOf(projects, projectId);
  return r ? `Project ${projects.find((x) => x.id === projectId).name} lives on ${r.machine} (read-only for now)` : null;
}
// The projects list with `remote` set ({ machine, projectId }) or removed (null) on one project.
export const withRemote = (projects, id, remote) =>
  projects.map((p) => {
    if (p.id !== id) return p;
    const { remote: _old, ...rest } = p;
    return remote ? { ...rest, remote: { machine: remote.machine, projectId: remote.projectId, ...(remote.id ? { id: remote.id } : {}) } } : rest;
  });

// The bindings a projects list holds: [{ localId, machine, projectId }].
export const bindings = (projects) =>
  (Array.isArray(projects) ? projects : []).filter((p) => p?.remote && validMachine(p.remote.machine) && validProjectId(p.remote.projectId))
    .map((p) => ({ localId: p.id, machine: p.remote.machine, projectId: p.remote.projectId, id: typeof p.remote.id === "string" ? p.remote.id : undefined }));

// ---- a remote description is text only: its image paths and file links mean files on the other machine ----
export const isRemoteCard = (task) => Boolean(task?.remote);
export const imagePaths = (task, imageLines, home) => (isRemoteCard(task) ? [] : imageLines(task?.desc ?? "", home));
export const canOpenFile = (task) => !isRemoteCard(task);

// ---- the card as the UI sees it ----
const COLUMN_IDS = ["backlog", "todo", "doing", "review", "blocked", "done"];
// The agent of a remote card is a terminal on that machine: text only, never an address the laptop could focus or message.
export const agentText = (task, machine) => (typeof task?.agent === "string" && /^[A-Za-z0-9_.\/-]{1,40}$/.test(task.agent) ? (task.agent.includes("/") ? task.agent : `${machine}/${task.agent}`) : null);
// Untrusted card -> a card every view can draw. `project` is the LOCAL project id; `agent` is cleared (see agentText).
export const normalizeRemoteCard = (t, localId, machine, remoteProjectId) => ({
  ...t,
  id: String(t.id ?? ""),
  title: String(t.title ?? ""),
  desc: typeof t.desc === "string" ? t.desc : "",
  column: COLUMN_IDS.includes(t.column) ? t.column : "backlog",
  priority: ["P0", "P1", "P2", "P3"].includes(t.priority) ? t.priority : "P2",
  tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
  notes: Array.isArray(t.notes) ? t.notes.filter((n) => n && typeof n === "object") : [],
  archived: false,
  assignee: t.assignee && typeof t.assignee === "object" && (t.assignee.kind === "agent" || t.assignee.kind === "squad") && typeof t.assignee.id === "string" && t.assignee.id ? { kind: t.assignee.kind, id: t.assignee.id } : null,
  parent: typeof t.parent === "string" && t.parent ? t.parent : null,
  source: null,
  project: localId,
  agent: null,
  agentText: agentText(t, machine),
  remote: { machine, ...(remoteProjectId ? { projectId: remoteProjectId } : {}) }, // projectId: the id on that machine (a move target is another one)
});
// What the read-only card view shows. Everything is a string or a list of strings: plain text, nothing to resolve on this machine.
export const remoteCardRows = (c) => ({
  id: String(c.id), machine: c.remote?.machine ?? "", title: c.title, column: c.column, priority: c.priority, tags: c.tags, agentText: c.agentText ?? null, desc: c.desc,
  notes: (c.notes ?? []).map((n) => ({ by: String(n.by ?? "").trim() || "you", text: String(n.text ?? ""), kind: typeof n.kind === "string" ? n.kind : null, at: Number.isFinite(n.at) ? n.at : null })),
});
// local cards + the remote cards of every bound project. view(machine, projectId) is createRemote().view.
export function mergeRemote(local, projects, view) {
  const tasks = [...local], remotes = [];
  for (const b of bindings(projects)) {
    const v = view(b.machine, b.projectId);
    remotes.push({ localId: b.localId, name: projects.find((p) => p.id === b.localId)?.name ?? b.localId, machine: b.machine, projectId: b.projectId, state: v.state, banner: v.banner, at: v.at ?? null, picks: v.picks ?? { assignees: [], projects: [], tags: [] } });
    for (const t of v.tasks) tasks.push(normalizeRemoteCard(t, b.localId, b.machine, b.projectId));
  }
  return { tasks, remotes };
}

const hhmm = (at) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// run(args, { timeout }) -> Promise<{ code, stdout, stderr }>: the hc wrapper. It owns the timeout (a mod has no setTimeout).
// bound(machine, projectId, id): is this exact binding still the current one? Asked again at commit, so an unbind or rebind made by
// ANOTHER reader (each mod holds its own) still drops a read that was already running. Default: always.
// active(): is the owning screen still on? Asked at commit too, so a read that returns after a switch-off, before the next timer tick, is dropped.
export function createRemote({ run, getShared, setShared, now = Date.now, log = () => {}, bound = () => true, active = () => true }) {
  const entries = new Map(); // cacheKey -> { machine, projectId, gen, failures, nextAt, inflight, ok, error }
  let genSeed = 0;

  async function fetchBoard(machine) {
    let r;
    try { r = await run(["file", "read", "--on", machine, SHARED_PATH], { timeout: TIMEOUT_MS }); } catch { return { error: "hc failed" }; }
    if (r?.code !== 0) return { error: `hc exit ${Number.isInteger(r?.code) ? r.code : "unknown"}` }; // a fixed code: stderr is never shown or logged
    return { text: String(r.stdout ?? "") };
  }

  // Binding checks. Returns { project } (the project with `remote` set; the caller saves it) or { error }.
  async function bind(project, { machine, projectId }, { tasks, projects }) {
    if (!project) return { error: "No such project" };
    if (!validMachine(machine)) return { error: "Machine name: letters, digits, . _ - only (1-64)" };
    if (!validProjectId(projectId)) return { error: "Remote project id looks like P-XXXX" };
    if ((projects ?? []).some((p) => p.id !== project.id && p.remote?.machine === machine && p.remote.projectId === projectId)) return { error: `${projectId} on ${machine} is already bound to another project` };
    const local = (tasks ?? []).filter((t) => t.project === project.id && !t.archived).length;
    if (local) return { error: `${project.name} has ${local} local card${local === 1 ? "" : "s"}: move or archive them first` };
    let ml;
    try { ml = await run(["machine", "ls"], { timeout: TIMEOUT_MS }); } catch { ml = null; }
    let machines = [];
    try { machines = JSON.parse(ml?.stdout ?? "").machines ?? []; } catch {}
    if (!machines.some((m) => m?.name === machine)) return { error: `Unknown machine ${machine} (see: hc machine ls)` };
    const f = await fetchBoard(machine);
    if (f.error) return { error: `${machine} did not answer (${f.error})` };
    const parsed = parseRemote(f.text, projectId);
    if (parsed.error) return { error: `${machine}'s board is unreadable (${parsed.error})` };
    if (!parsed.projectIds.includes(projectId)) return { error: `${machine} has no project ${projectId}` };
    return { project: { ...project, remote: { machine, projectId, id: `B-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` } } }; // id: this binding, not the pair
  }

  // Start tracking a binding. A new generation: any read still in flight for the old one is dropped.
  function attach(machine, projectId, id) {
    const key = cacheKey(machine, projectId);
    entries.set(key, { machine, projectId, id, gen: ++genSeed, failures: 0, nextAt: 0, inflight: null, ok: false, error: null });
    return key;
  }
  // Unbind: drop the entry (an in-flight read is dropped on arrival) and the cache.
  function detach(machine, projectId) {
    const key = cacheKey(machine, projectId);
    const e = entries.get(key);
    entries.delete(key);
    setShared(key, null);
    const s = e?.settle; if (e) e.settle = null; s?.({ error: "detached" }); // nobody waits forever on a read of a binding that is gone
  }

  function read(machine, projectId) {
    const key = cacheKey(machine, projectId);
    const e = entries.get(key);
    if (!e) return Promise.resolve({ dropped: true });
    if (e.inflight) return e.inflight;
    const gen = e.gen;
    e.startedAt = now();
    const p = (async () => {
      const f = await fetchBoard(machine);
      const parsed = f.error ? f : parseRemote(f.text, projectId);
      const cur = entries.get(key);
      if (!cur || cur.gen !== gen || !bound(machine, projectId, cur.id) || !active()) { if (cur && cur.gen === gen) cur.inflight = null; return { dropped: true }; } // rebound or unbound while reading, here or in another reader
      cur.inflight = null;
      if (parsed.error) {
        cur.failures++; cur.ok = false; cur.error = parsed.error;
        cur.nextAt = now() + readDelay(cur.failures);
        log(`remote ${machine}/${projectId}: read failed (${parsed.error}), failures ${cur.failures}`);
        return { error: parsed.error };
      }
      cur.picks = parsed.picks; // kept in memory too: a cache write by an older mod copy (no picks) must not erase what this instance has read
      setShared(key, { at: now(), tasks: parsed.tasks, picks: parsed.picks });
      cur.failures = 0; cur.ok = true; cur.error = null;
      cur.nextAt = now() + POLL_MS;
      log(`remote ${machine}/${projectId}: read ok, ${parsed.tasks.length} cards`);
      return { ok: true };
    })();
    // The promise callers wait on settles with the read, OR when the read is abandoned (timeout, switch-off): nobody waits on a read that was dropped.
    const wait = new Promise((resolve) => { e.settle = resolve; p.then(resolve, () => resolve({ error: "read failed" })); });
    e.inflight = wait;
    return wait;
  }

  // A read past its deadline is abandoned: a new generation drops its late answer, and it counts as one failure.
  function abandon(e) {
    e.gen = ++genSeed; e.inflight = null; e.failures++; e.ok = false; e.error = "timeout";
    const s = e.settle; e.settle = null; s?.({ error: "timeout" });
    e.nextAt = now() + readDelay(e.failures);
    log(`remote ${e.machine}/${e.projectId}: read timed out, failures ${e.failures}`);
  }
  // Make the tracked set equal `list` ([{ machine, projectId }]); a tracked binding keeps its state and generation.
  function sync(list) {
    const want = new Map(list.map((b) => [cacheKey(b.machine, b.projectId), b]));
    for (const [key, b] of want) {
      const e = entries.get(key);
      if (e && e.id !== b.id) { entries.delete(key); setShared(key, null); const s = e.settle; e.settle = null; s?.({ error: "detached" }); } // same pair, new binding: nothing of the old one survives
      if (!entries.has(key)) attach(b.machine, b.projectId, b.id);
    }
    for (const [key, e] of [...entries]) if (!want.has(key)) detach(e.machine, e.projectId);
  }
  // The owning screen was switched off: drop every read in flight (a new generation), start none.
  function suspend() {
    for (const e of entries.values()) if (e.inflight) { e.gen = ++genSeed; e.inflight = null; const s = e.settle; e.settle = null; s?.({ dropped: true }); }
  }

  // Called by the owner's timer (every TICK_MS): abandons a read past its deadline, then reads each binding that is due.
  function tick() {
    const t = now();
    const timedOut = [];
    for (const e of entries.values()) if (e.inflight && t - e.startedAt > TIMEOUT_MS) { abandon(e); timedOut.push({ error: "timeout" }); }
    // Due by the poll, or the cache lost its picks (an older mod copy rewrote it): read now, so every copy sees them again.
    const lost = (e) => e.ok && !(getShared(cacheKey(e.machine, e.projectId)) || {}).picks;
    return Promise.all([...timedOut, ...[...entries.values()].filter((e) => !e.inflight && (t >= e.nextAt || lost(e))).map((e) => read(e.machine, e.projectId))]);
  }
  // The Retry control: a read now (joins one already running).
  const retry = (machine, projectId) => read(machine, projectId);

  // What the UI draws: state "fresh" | "stale" | "never", the cards (stamped remote), and the banner text.
  function view(machine, projectId) {
    const key = cacheKey(machine, projectId);
    const e = entries.get(key);
    const c = getShared(key);
    const have = c && typeof c === "object" && Array.isArray(c.tasks);
    if (!have) return { state: "never", tasks: [], picks: { assignees: [], projects: [], tags: [], loading: true }, banner: `${machine} has not answered yet`, error: e?.error ?? null };
    const tasks = c.tasks.map((t) => ({ ...t, remote: { machine } }));
    const list = (v) => (Array.isArray(v) ? v : []);
    const src = c.picks && typeof c.picks === "object" ? c.picks : e?.picks ?? null; // the cache first, else what this instance read; neither: still loading
    const picks = { assignees: list(src?.assignees), projects: list(src?.projects), ...(src ? {} : { loading: true }), tags: [...new Set(tasks.flatMap((t) => (Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === "string") : [])))].sort() };
    if (e?.ok) return { state: "fresh", at: c.at, tasks, picks, banner: null };
    return { state: "stale", at: c.at, tasks, picks, banner: `${machine} unreachable · last update ${hhmm(c.at)} · showing a saved copy`, error: e?.error ?? null };
  }

  return { bind, attach, detach, sync, suspend, read, tick, retry, view };
}
