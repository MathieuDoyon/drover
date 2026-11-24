// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// A project bound to another machine (T-MWHVWQNL2HA): the shared vocabulary of the binding (ownership, the card as the UI sees it, the bind check).
// The laptop reads and writes that machine's board only through the exec transport (remote-exec.js, drover-headless over `hc exec`); the old
// shared.json reader and the inbox are retired (T-MWO2V65MUSX). Pure logic: the hc runner is injected.

export const POLL_MS = 15000; // normal poll
export const SLOW_MS = 60000; // backoff cap
export const SLOW_AFTER = 5; // failures before the cap
export const TIMEOUT_MS = 10000; // one read
export const CACHE_PREFIX = "drover.remote.";
export const READONLY_TIP = "This project lives on another machine (read-only for now)";

export const validMachine = (s) => typeof s === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(s);
export const validProjectId = (s) => typeof s === "string" && /^P-[A-Z0-9]+$/.test(s);
export const cacheKey = (machine, projectId) => `${CACHE_PREFIX}${machine}.${projectId}`;
export const readDelay = (failures) => (failures >= SLOW_AFTER ? SLOW_MS : POLL_MS);

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
    return remote ? { ...rest, remote: { machine: remote.machine, projectId: remote.projectId, ...(remote.id ? { id: remote.id } : {}), transport: "exec" } } : rest;
  });

// The bindings a projects list holds: [{ localId, machine, projectId }].
export const bindings = (projects) =>
  (Array.isArray(projects) ? projects : []).filter((p) => p?.remote && validMachine(p.remote.machine) && validProjectId(p.remote.projectId))
    .map((p) => ({ localId: p.id, machine: p.remote.machine, projectId: p.remote.projectId, id: typeof p.remote.id === "string" ? p.remote.id : undefined, transport: "exec" }));

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
// local cards + the remote cards of every bound project. view(machine, projectId) is the exec reader's view.
export function mergeRemote(local, projects, view) {
  const tasks = [...local], remotes = [];
  for (const b of bindings(projects)) {
    const v = view(b.machine, b.projectId);
    remotes.push({ localId: b.localId, name: projects.find((p) => p.id === b.localId)?.name ?? b.localId, machine: b.machine, projectId: b.projectId, state: v.state, banner: v.banner, at: v.at ?? null, picks: v.picks ?? { assignees: [], projects: [], tags: [] } });
    for (const t of v.tasks) tasks.push(normalizeRemoteCard(t, b.localId, b.machine, b.projectId));
  }
  return { tasks, remotes };
}


// Binding checks. Returns { project } (the project with `remote` set; the caller saves it) or { error }.
// run(args, { timeout }) -> Promise<{ code, stdout, stderr }>: the hc wrapper. probeExec(machine, projectId) -> { ops } | { error }: does the machine answer
// drover-headless and hold the project? Every binding is an exec binding: there is no other way to reach a remote machine.
export async function bindRemote({ run, now = Date.now, probeExec }, project, { machine, projectId }, { tasks, projects }) {
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
  const pe = probeExec ? await probeExec(machine, projectId) : { error: "the exec transport is not available here" };
  if (pe.error) return { error: pe.error };
  return { project: { ...project, remote: { machine, projectId, id: `B-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, transport: "exec" } } }; // id: this binding, not the pair
}
