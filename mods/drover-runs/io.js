// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// The herdr side of the store: tasks persist in shared state (shared.json, written atomically).
import { shared, setShared, openOverlay, exec, hc, readTextFile, writeTextFile, notify, focused, appHome, home, watchFolder, spaces, panes, agents, terminals } from "herdr";
import * as fs from "fs/promises";
import { KEY, SEEN_KEY, PROJECTS_KEY, firstSight, list, add, update, bySource, addCommand, applyCommand, repoOf, projectOf, projectKey, projectAddRequest, projectDiff, PROTOCOL, inboxGate, arrivalOf, addProject, projectNamed, nextReport, claim, release, editSize } from "./store.js";
import { base64, httpProblem, jiraIssue, jiraKey, githubIssue, prItems } from "./sources.js";
import { ownerError, createRemote, bindings as remoteBindings, mergeRemote, cacheKey } from "./remote.js";
import { createWriter } from "./remote-write.js";
import { WAKE_KEY, reschedule, addWake, decide, setStatus, wakeOp } from "./wake.js";
import { apply as applyKey } from "./keys.js";
import { resolveWorkFolder, moveOffers, parseMove } from "./workfolder.js";
import { bind as bindCfg, load as loadCfg, ready as cfgReady, cfg } from "./config.js";
import { AGENTS_KEY, RUNS_KEY, config, plan, argv, leaderPrompt, createCardsPrompt, memberPrompt, worktreeOf, terminalName, startGuard, projectOfDrover, isLiveDrover, activeFor, reconcile, runFolder, markEnded, orphanedWorkers, terminalRecord, liveStatuses, launchArgv, parseAgentEnv, envProblem, BIND_KEY, droverChoices, defaultDrover, maxRuns, keptRuns, pruneRuns } from "./runs.js";

export const load = () => list(shared(KEY));

// The commit boundary: every card the result adds or changes is checked against its stored project AND its new one.
function savedOwned(result) {
  const ps = loadProjects();
  if (!ps.some((p) => p.remote)) return null;
  const stored = new Map(load().map((x) => [x.id, x]));
  for (const x of result.tasks ?? []) {
    const old = stored.get(x.id);
    if (old && JSON.stringify(old) === JSON.stringify(x)) continue;
    const e = ownerError(ps, x.project) ?? (old ? ownerError(ps, old.project) : null);
    if (e) return e;
  }
  return result.task ? ownerError(ps, result.task.project) : null;
}

// Takes a store result: saves its tasks, or shows its error and saves nothing.
export function save(result) {
  const owned = result.error ? null : savedOwned(result); // a project on another machine takes no local card
  if (result.error || owned) {
    notify({ title: "Task not saved", body: result.error ?? owned, level: "error" });
    return null;
  }
  setShared(KEY, result.tasks);
  return result.task;
}

// Create and edit share the Multica-style modal shell (small 720x520, large 0.9x0.85). `draft` + `large`: the expand/shrink reopen.
// parent: a create opens as a sub-issue of that task.
export const NEWTASK_KEY = "drover.newtask.open";
export const edit = (id, column, draft, large, parent, remoteCard) => {
  const overlay = openOverlay({ mod: "drover-todos", kind: "dialog", modal: true, ...editSize(large),
    props: { edit: id ?? null, column: column ?? "todo", ...(draft ? { draft, large: Boolean(large) } : large ? { large: true } : {}), ...(parent ? { parent } : {}), ...(remoteCard ? { remoteCard } : {}) } }); // remoteCard: a card of another machine, shown read-only
  // A Create dialog is remembered so the new-task key does not stack a second one (see createDialogOpen).
  if (id == null) setShared(NEWTASK_KEY, { id: overlay, at: Date.now() });
  return overlay;
};

// The guard in shared state: { id, at } (a Create dialog is open; its View refreshes `at` every HEARTBEAT_MS and clears it on close),
// or { pending: true, at, token } (a key press reserving its slot), or an older plain id string. Shared state is the channel
// between the mod copies a key press starts. A guard is live while `at` is under LIVE_MS old (a crash stops the heartbeat).
export const HEARTBEAT_MS = 15000;
export const LIVE_MS = 40000;
export const PENDING_MS = 3000;
export const guardOf = (raw) => {
  if (typeof raw === "string" && raw !== "") return { id: raw, at: 0 };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { id: typeof raw.id === "string" ? raw.id : undefined, pending: raw.pending === true, at: Number(raw.at) || 0 };
};
export const guardLive = (raw, now = Date.now()) => {
  const g = guardOf(raw);
  return Boolean((g.pending && now - g.at < PENDING_MS) || (g.id && now - g.at < LIVE_MS));
};
export const reserveCreate = () => setShared(NEWTASK_KEY, { pending: true, at: Date.now() });
// Only the dialog that owns the guard touches it: an old dialog closing after its expand/shrink reopen leaves the new record alone.
export const clearCreateGuard = (overlay) => { if (overlay && guardOf(shared(NEWTASK_KEY)).id === overlay) setShared(NEWTASK_KEY, null); };
// The heartbeat rewrites the guard to its own id when it is empty, stale or already its own; a different LIVE id is never overwritten.
// So an older dialog re-protects the key within one beat after a newer one closed and cleared it.
export const beatCreateGuard = (overlay) => {
  if (!overlay) return;
  const raw = shared(NEWTASK_KEY);
  if (guardOf(raw).id === overlay || !guardLive(raw)) setShared(NEWTASK_KEY, { id: overlay, at: Date.now() });
};

// Deliver a note to a live agent. Throws when hc send fails.
export async function sendToAgent(address, text) {
  const r = await hc(["send", address, text]);
  if (r?.code !== 0) throw new Error(`hc send failed: ${String(r?.stderr ?? "").trim().split("\n")[0] || "no answer"}`);
}

export const openBoard = () => exec("herdr-app", ["do", "tab.new", "--name", "Board", "--mod", "drover-board"]);

// ▶ on a task: pick an agent or squad (the drover-agents mod draws the picker).
export const pick = (taskId) =>
  openOverlay({ mod: "drover-agents", kind: "dialog", width: 460, height: 0.75, props: { pick: taskId } });

export const loadWakes = () => (Array.isArray(shared(WAKE_KEY)) ? shared(WAKE_KEY) : []);
export const loadConfig = () => config(shared(AGENTS_KEY));

// How a start is set up when the person did not choose in the start dialog. One precedence everywhere (Squads Picker, the task
// editor's Create/Send with an assignee): what was used last (drover.agents.last) > the Drover Config default > the built-in.
// A default squad that no longer exists is ignored.
export function startDefaults() {
  const last = shared("drover.agents.last") ?? {};
  const squad = cfg("drover-agents", "default_squad");
  const runner = last.runner ?? (squad && loadConfig().squads.some((s) => s.id === squad) ? { kind: "squad", id: squad } : { kind: "agent", id: "claude" });
  return { runner, worktree: last.worktree ?? cfg("drover-agents", "default_worktree"), report: last.report ?? cfg("drover-agents", "default_report") };
}
// launch() options for those defaults. Report goes to the Drover of the focused space (else the newest on screen), like the Picker; none on screen: nobody.
// Async: a mod that is not Squads loads the mod.json layer of drover-agents first (also awaiting a read still pending), so an inherited
// default_worktree / default_report is never read as the schema default.
export async function startOptions() {
  await loadPolicy("drover-agents").catch(() => {});
  const d = startDefaults();
  return { worktree: d.worktree, reportTo: d.report ? defaultDrover(droverList(), focused()?.space) : null };
}
// The Drovers on screen with the space each is shown in, newest first (the picker's Combobox rows).
export function droverList() {
  const all = panes(), sp = spaces();
  const spaceOf = (address) => {
    const tab = all.find((p) => p.terminal === address)?.tab;
    const s = tab ? sp.find((x) => x.tabs.some((t) => t.id === tab)) : null;
    return s ? { id: s.id, name: s.name } : null;
  };
  return droverChoices(loadRuns(), all.map((p) => p.terminal), spaceOf);
}
// The project of the Drover shown in the focused (sidebar's) space, newest first; null when that space has none or it is unbound.
// The space the sidebar shows in: the window's focused space (null when the host reports none).
export const sidebarSpace = () => focused()?.space ?? null;
export function spaceProject() {
  const sp = sidebarSpace();
  const d = sp ? droverList().find((c) => c.space === sp) : null;
  return d ? projectOfDrover(loadRuns(), d.address) : null;
}
// The laptop's reader of a remote project's board: hc runs `file read --on <machine>`; the 10 s timeout is the wrapper's job (no setTimeout in a mod).
export const remoteRun = (args) => hc(args); // hc takes argv only: the 10 s deadline is enforced by remote.js (tick), not here
let screenOn = () => true; // set by watchRemote: the owning screen's switch
export const remote = createRemote({ run: remoteRun, active: () => screenOn(), getShared: (k) => shared(k), setShared: (k, v) => setShared(k, v ?? undefined),
  bound: (machine, projectId, id) => remoteBindings(loadProjects()).some((b) => b.machine === machine && b.projectId === projectId && b.id === id) });
export const loadProjects = () => (Array.isArray(shared(PROJECTS_KEY)) ? shared(PROJECTS_KEY) : []);

// Local cards plus the cached cards of every remote-bound project (read-only; see remote.js). { tasks, remotes } where remotes carry each banner.
export const loadMerged = () => { const ps = loadProjects(); return remoteBindings(ps).length ? mergeRemote(load(), ps, remote.view) : { tasks: load(), remotes: [] }; };
// Board / Tasks timer: keeps the tracked bindings equal to the projects' and reads the due ones (a mod copy polls on its own while it is open).
// enabled(): the owning screen's switch. Off: no read, and a read in flight is dropped (the inbox consumers are separate and keep running).
export function watchRemote(cx, enabled = () => true) {
  screenOn = enabled;
  const tick = (cx) => {
    if (!enabled()) { remote.suspend(); return; }
    const list = remoteBindings(loadProjects());
    remote.sync(list); // the whole binding, id included: the commit-time check compares it
    if (list.length && cx.spawn) cx.spawn(async (cx) => { if ((await remote.tick()).length) cx.notify(); });
    driveWriter(cx, list);
  };
  cx.timer?.every?.(1000, tick);
  tick(cx);
}
// ---- Remote project, step 2: writes to the machine's inbox (T-MWHVWR8TIJB). remote-write.js is pure; this is its host side. ----
// Each mod copy that polls (Board, Tasks) owns one writer; the pending list is a shared key. Origin: this laptop's stable tag in every nonce.
const ORIGIN_KEY = "drover.remote-origin";
let writer = null, writerCx = null;
const remoteOutcomes = [];
export const remoteWriter = () => {
  if (writer) return writer;
  let origin = shared(ORIGIN_KEY);
  if (!/^[A-Za-z0-9]{1,16}$/.test(origin ?? "")) { origin = `D${Math.random().toString(36).slice(2, 9).padEnd(7, "0")}`; setShared(ORIGIN_KEY, origin); }
  const bound = (machine, projectId) => loadProjects().find((p) => p.remote?.machine === machine && p.remote.projectId === projectId);
  writer = createWriter({
    run: (args) => hc(args), // the writer owns its deadlines (tick); hc takes argv only
    exec: (cmd, args, opts) => exec(cmd, args, opts),
    now: () => Date.now(), getShared: (k) => shared(k), setShared: (k, v) => setShared(k, v ?? undefined), origin,
    writable: (machine) => loadProjects().some((p) => p.remote?.machine === machine && p.remote.writes !== false),
    link: (machine, projectId) => ({ writes: bound(machine, projectId)?.remote.writes !== false, state: remote.view(machine, projectId).state }),
    reload: (machine, projectId) => { void remote.retry(machine, projectId).then(() => writerCx?.notify?.()); },
    onOutcome: (o) => { if (!o.probe) remoteOutcomes.push(o); if (remoteOutcomes.length > 20) remoteOutcomes.shift(); writerCx?.notify?.(); },
  });
  return writer;
};
// Late outcomes (a result that arrived after the wait), oldest first; the caller shows and clears them.
export const takeRemoteOutcomes = () => remoteOutcomes.splice(0);
const remoteBinding = (localId) => remoteBindings(loadProjects()).find((b) => b.localId === localId) ?? null;
// What a Board/Tasks control needs: { remote, enabled, reason, frozen }.
export function remoteWriteState(localId) {
  const b = remoteBinding(localId);
  if (!b) return { remote: false, enabled: false, reason: "Not a remote project", frozen: false };
  const w = remoteWriter();
  const g = w.canWrite(b.machine, b.projectId);
  return { remote: true, enabled: g.ok, reason: g.ok ? null : g.reason, frozen: w.frozen(b.machine, b.projectId) };
}
// A card change on a remote project: only remote-write.js builds the request. The board is re-read after a save.
export async function remoteSend(localId, op, cx) {
  const b = remoteBinding(localId);
  if (!b) return { status: "refused", message: "Not a remote project" };
  if (cx) writerCx = cx;
  const o = await remoteWriter().send(b.machine, b.projectId, op);
  if (o.status === "saved") await remote.retry(b.machine, b.projectId);
  cx?.notify?.();
  return o;
}
// The freeze switch of the rollback runbook: remote.writes (the binding keeps its id). `frozen` is true only when no send is in flight.
export function setRemoteWrites(localId, on) {
  const b = remoteBinding(localId);
  if (!b) return { error: "Not a remote project" };
  setShared(PROJECTS_KEY, loadProjects().map((p) => (p.id === localId ? { ...p, remote: { ...p.remote, writes: Boolean(on) } } : p)));
  return { ok: true, writes: Boolean(on), frozen: remoteWriter().frozen(b.machine, b.projectId) };
}
const seenState = new Map(); // binding key -> the last view state, to see stale/never -> fresh
// Forget the writer, its probes and what it saw (a test, or a reset of the remote layer).
export function resetRemoteWriter() { writer = null; writerCx = null; seenState.clear(); remoteOutcomes.length = 0; }
function driveWriter(cx, list) {
  writerCx = cx;
  const w = remoteWriter();
  for (const b of list) {
    const key = cacheKey(b.machine, b.projectId);
    const now = remote.view(b.machine, b.projectId).state;
    if (now === "fresh" && seenState.get(key) !== "fresh") { w.reconnect(b.machine); void w.cleanup(b.machine); } // bind, or the machine came back
    seenState.set(key, now);
  }
  for (const key of [...seenState.keys()]) if (!list.some((b) => cacheKey(b.machine, b.projectId) === key)) seenState.delete(key);
  if (list.length) void w.tick().then(() => cx.notify?.());
}
// The Retry control: a read now, then a repaint.
export const retryRemote = (machine, projectId, cx) => cx.spawn(async (cx) => { await remote.retry(machine, projectId); cx.notify(); });
export const loadRuns = () => (Array.isArray(shared(RUNS_KEY)) ? shared(RUNS_KEY) : []);

// terminal.park can answer { pending: true } and fail later: wait (tries x ms) for the pane to leave its tab.
export const parkSettle = { tries: 10, ms: 300 };
async function parkConfirmed(address) {
  const out = await herdr(["terminal.park", "--terminal", address]);
  if (!out.pending) return true;
  for (let i = 0; i < parkSettle.tries; i++) {
    if (!panes().some((p) => p.terminal === address)) return true;
    await exec("sleep", [String(parkSettle.ms / 1000)]); // no setTimeout in a mod: the host runs the wait
  }
  return !panes().some((p) => p.terminal === address);
}

async function herdr(args) {
  let out = null;
  try { out = JSON.parse((await exec("herdr-app", ["do", ...args])).stdout); } catch {}
  if (!out || out.error) throw new Error(out?.error ?? `herdr-app do ${args[0]} failed`);
  return out;
}

// The focused terminal's folder, else any terminal folder in the shown space.
function here() {
  const f = focused();
  return f?.cwd ?? panes().find((p) => p.cwd && spaces().find((s) => s.id === f?.space)?.tabs.some((t) => t.id === p.tab))?.cwd ?? null;
}

async function makeWorktree(task, from, base) {
  const cwd = from ?? here();
  if (!cwd) throw new Error("No folder here: focus a terminal in the repo first.");
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (top.code !== 0) throw new Error(`${cwd} is not in a git repo.`);
  const repo = top.stdout.trim();
  const { branch, path } = worktreeOf(home(), repo, task);
  // E7-05: never reuse or overwrite an existing checkout or branch; stop and let the person look.
  const add = await exec("git", ["worktree", "add", "-b", branch, path, ...(base ? [base] : [])], { cwd: repo });
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim().split("\n").pop()}`);
  return { repo, branch, path };
}

// Starts a run: optional worktree + its own space (the "room"), members first, leader last
// (its prompt lists the members' addresses). Records the run with a frozen copy of the config.
// task null = a free run (no task, no worktree). reportTo = the coordinator's address (Drover):
// the run opens in its space and folder, and the leader reports to it. Returns the run, or { error }.
// The folder for plans, scouts, reviews and lane logs, from drover-config.work_folder. A bad id or an unusable base falls back to repo mode, then to none.
// Policy consumers in another mod's copy (the inbox in Tasks/Board, wakeup delivery, Room context from Todos) load the mod.json fallback of the mods
// whose settings they read, once, at their own boundary. Never gated by a screen's enabled switch.
export async function loadPolicy(...mods) {
  bindCfg({ shared, modSettings });
  await Promise.all(mods.filter((m) => !cfgReady(m)).map((m) => loadCfg(m)));
}

const WORKFOLDER_ROOT = () => `${home()}/.config/drover-herdr`;
async function workFolderFor({ runId, worktree, repo, project, mode: only }) {
  bindCfg({ shared, modSettings });
  if (!cfgReady("drover-config")) await loadCfg("drover-config");
  const args = { repo, worktree, project, runId, configDir: WORKFOLDER_ROOT() };
  for (const mode of [only ?? cfg("drover-config", "work_folder"), "repo"]) {
    try { return { mode, path: resolveWorkFolder({ ...args, mode }) }; } catch { /* try repo mode */ }
  }
  return null;
}

// drover-workfolder (a helper under drover-agents/bin, like drover-env-write): the runtime has no chmod.
const WORKFOLDER_BIN = () => `${appHome()}/mods/drover-agents/bin/drover-workfolder`;
// Global modes only: make the folder (0700, no symlink below the config root). Repo mode is unchanged: agents mkdir .drover as before.
// A refusal throws, so launch() opens no agent: they would write to a folder that failed the privacy check.
async function ensureWorkFolder(wf) {
  if (!wf || wf.mode === "repo") return;
  let why = "";
  try { const r = await exec(WORKFOLDER_BIN(), ["ensure", wf.path, "--root", WORKFOLDER_ROOT()]); if (r.code !== undefined && r.code !== 0) why = String(r.stderr || r.stdout || `exit ${r.code}`).trim(); } catch (e) { why = String(e?.message ?? e); }
  if (why) throw new Error(`work folder not ready: ${wf.path}: ${why}`);
}

// Entries in <repo>/.drover for each project's default repo: what the dialog offers to move. 0 when absent or unreadable.
export async function workFolderOffers() {
  bindCfg({ shared, modSettings });
  if (!cfgReady("drover-config")) await loadCfg("drover-config");
  const projects = loadProjects(), counts = {};
  for (const p of projects) {
    const repo = (p.repos?.find((r) => r.default) ?? p.repos?.[0])?.path;
    if (repo && !(repo in counts)) counts[repo] = (await fs.readdir(`${repo}/.drover`).catch(() => [])).length;
  }
  return moveOffers({ mode: cfg("drover-config", "work_folder"), projects, counts, configDir: WORKFOLDER_ROOT() });
}

// The person confirmed: move <from> into <to> (never overwrites). Returns { moved, skipped, conflicts } or { error }.
export async function moveWorkFolder(from, to) {
  try {
    const r = await exec(WORKFOLDER_BIN(), ["move", from, to, "--root", WORKFOLDER_ROOT()]);
    if (r.code !== undefined && r.code !== 0) return { error: String(r.stderr || r.stdout || `exit ${r.code}`).trim() };
    return parseMove(r.stdout) ?? { error: "Unexpected answer from drover-workfolder" };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

export async function launch(task, runner, { worktree, reportTo, project, create, folder: chosen, note } = {}) {
  const label = task?.id ?? "Run";
  try {
    const owned = ownerError(loadProjects(), task?.project ?? project);
    if (owned) throw new Error(owned);
    const p = plan(loadConfig(), runner);
    if (p.error) throw new Error(p.error);
    if (worktree && !task) throw new Error("A worktree needs a task.");
    const boss = reportTo ? panes().find((x) => x.terminal === reportTo) : null;
    if (reportTo && !boss) throw new Error(`Coordinator ${reportTo} is not on screen.`);
    // A project's default repo wins over the coordinator's folder.
    // Its base branch is the start point; a task without a project keeps the repo's current HEAD.
    const proj = projectOf(task, loadProjects()), projRepo = repoOf(task, loadProjects());
    const runProject = task?.project ?? project ?? null; // a task-less run gets the bind from the op
    const runId = "R-" + Date.now().toString(36).toUpperCase();
    const runProj = runProject ? loadProjects().find((x) => x.id === runProject) ?? null : null;
    // A global work folder does not depend on the worktree: make it (or stop) before anything is created.
    let wf = await workFolderFor({ runId, project: runProj });
    if (wf?.mode === "repo") wf = null;
    await ensureWorkFolder(wf);
    const wt = worktree ? await makeWorktree(task, projRepo ?? boss?.cwd, projRepo ? proj.branch : null) : null;
    const ctx = { drover: drover(), souls: SOULS(), reportTo, note: note ?? null, project: !task && runProject ? loadProjects().find((x) => x.id === runProject) : null };
    const terminals = [];
    let space = boss ? spaces().find((sp) => sp.tabs.some((t) => t.id === boss.tab))?.id ?? null : focused()?.space ?? null;
    // chosen: a folder picked by the person (Squads ▶ "Opens in"); else a task-less run's bound project.
    const folder = runFolder(wt?.path, chosen ?? repoOf({ project: runProject }, loadProjects()), boss?.cwd);
    if (!wf) wf = await workFolderFor({ mode: "repo", runId, worktree: wt?.path, repo: projRepo ?? folder, project: runProj });
    ctx.workFolder = wf?.path ?? null;
    const open = async (agent, prompt) => {
      const name = `${task ? task.id + " " : ""}${agent.role === "leader" ? agent.name : agent.role.split(/[.:(]/)[0].trim()}`.slice(0, 40);
      // Env file present: the wrapper runs the agent. A wrapper failure exits non-zero and the plain agent never starts.
      const args = ["--argv", JSON.stringify(launchArgv(agent.id, argv(agent.command), ENV_WRAPPER(), await hasAgentEnv(agent.id))), "--task", prompt];
      const out = wt && !terminals.length
        ? await herdr(["space.new", "--name", `${task.id} ${task.title}`.slice(0, 40), "--folder", wt.path, "--tab", name, ...args])
        : await herdr(["tab.new", "--name", name, ...(space ? ["--space", space] : []), ...(folder ? ["--folder", folder] : []), ...args]);
      if (out.space) space = out.space;
      terminals.push(terminalRecord(out.terminal, agent, Date.now()));
      return out.terminal;
    };
    for (const m of create ? [] : p.members) m.address = await open(m, memberPrompt(task, m, ctx));
    const leader = await open(p.leader, create ? createCardsPrompt(create, p.leader, ctx.project, ctx) : leaderPrompt(task, p.leader, p.members, ctx));
    // Floating workers: once the leader's tab is open, park each member (never the leader). Parked is recorded only once Herdr confirms the pane is gone; a failed or unconfirmed park keeps that tab.
    const failed = [];
    for (const t of terminals) {
      if (t.role === "leader") continue;
      try { if (await parkConfirmed(t.address)) t.parked = true; else failed.push(t.address); } catch { failed.push(t.address); }
    }
    if (failed.length) notify({ title: `${label}: workers kept their tabs`, body: `Could not park ${failed.join(", ")}.`, level: "error" });
    const run = {
      id: runId, task: task?.id ?? null, project: runProject, title: task?.title ?? p.name, runner, name: p.name,
      config: { leader: p.leader, members: p.members }, space, worktree: wt, terminals, started: Date.now(), reportTo: reportTo ?? null,
    };
    setShared(RUNS_KEY, pruneRuns([run, ...loadRuns()], keptRuns())); // drops only ended runs beyond drover-runs.kept
    if (task) save(update(load(), task.id, { agent: leader, run: run.id, column: "doing", claimedAt: null }));
    return run;
  } catch (e) {
    const error = String(e?.message ?? e);
    if (!reportTo) notify({ title: `${label} not started`, body: error, level: "error" });
    return { error };
  }
}

// Squads ▶ Start. projectId = the "Opens in" project (null: the space's folder, unbound).
// The Drover agent with a project is bound to it, through the same guards as `drover start --project` (a refusal is shown, never an unbound fallback).
// Any other agent or squad only opens in the project's repo. No repo: the focused space's folder (else Herdr's default) and a hint.
export async function startFromSquads(kind, id, projectId) {
  const owned = ownerError(loadProjects(), projectId); // a project on another machine: its repo paths are not on this one
  if (owned) { notify({ title: "Not started", body: owned, level: "error" }); return { error: owned }; }
  const project = projectId ? loadProjects().find((p) => p.id === projectId) ?? null : null;
  let folder = project ? repoOf({ project: project.id }, loadProjects()) : null;
  if (project && !folder) {
    folder = here();
    notify({ title: `${project.name} has no repo path`, body: `Opened in the current folder. Set the repo path in Projects.`, level: "info" });
  }
  const bind = project && kind === "agent" && id === "drover" ? project.id : null;
  if (!bind) return launch(null, { kind, id }, { folder });
  const guard = startGuard({ tasks: load(), runs: loadRuns(), projects: loadProjects(), binding: shared(BIND_KEY) ?? {}, ...liveState() }, { runner: id, project: bind });
  if (guard.error) { notify({ title: "Drover not started", body: guard.error, level: "error" }); return { error: guard.error }; }
  const setBinding = (v) => setShared(BIND_KEY, { ...(shared(BIND_KEY) ?? {}), [bind]: v });
  setBinding(Date.now()); // before the first await, like startFromAgent
  try { return await launch(null, { kind, id }, { project: bind, folder }); } finally { setBinding(undefined); }
}

export const openUrl = (url) => exec("open", [url]);

// Read-only: makes a local card linked to the source item; never writes upstream.
// GitHub: the description is the issue/PR body, read on click so the list snapshot stays small.
export async function addToBoard(kind, item, tags) {
  const found = bySource(load(), kind, item.id, item.url);
  if (found) return edit(found.id);
  const desc = kind === "github" ? await githubBody(item.url) : "";
  const tasks = load(); // again after the wait: a second click meanwhile already made the card
  const again = bySource(tasks, kind, item.id, item.url);
  if (again) return edit(again.id);
  save(add(tasks, { title: `${item.key} ${item.title}`, desc, column: "backlog", tags, source: { kind, id: item.id, url: item.url } }));
}

// The body of a GitHub issue or PR, or "" (the card is still made, with a notice) when gh fails.
async function githubBody(url) {
  try {
    const r = await exec("gh", [/\/pull\/\d+/.test(url) ? "pr" : "issue", "view", url, "--json=body"], { timeout: 30000 });
    if (r.code !== 0) throw new Error((r.stderr ?? "").trim().split("\n")[0] || "no output");
    return String(JSON.parse(r.stdout).body ?? "");
  } catch (e) {
    notify({ title: "Description not imported", body: `gh: ${e?.message ?? e}`, level: "error" });
    return "";
  }
}

// Agents can't reach shared state, so they drop requests in a folder (mods/bin/drover).
// Every open drover mod watches it; the shared seen list lets only one apply a request.
const INBOX = () => `${appHome()}/data/drover-inbox`;
export const drover = () => `${appHome()}/mods/drover-tasks/bin/drover`;
const SOULS = () => `${appHome()}/mods/drover-agents/souls`;
const ENV_WRAPPER = () => `${appHome()}/mods/drover-agents/bin/drover-env`;

// Does <config>/agents/<id>.json exist? readTextFile (the host's reader, null when absent) is the call that reaches outside appHome;
// the mod fs does not. The content is read only to see that it is there and is dropped at once. A read that fails for any reason
// other than "absent" stops the launch: the file may exist, so the plain agent must not start as the person.
// (A dangling symlink reads as absent; only same-user code can plant one, see scope section 5.)
async function hasAgentEnv(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) return false; // never builds a path from an odd id
  try { return (await readTextFile(envPath(id))) != null; }
  catch (e) { logFailure("env check", e); throw new Error(`Cannot check the environment of agent ${id} (${reasonCode(e)})`); }
}

// ---- Agent environment (identity): the editor side. Values live only in <config>/agents/<id>.json (0600).
// The runtime has no chmod, rename or file mode, so the drover-env-write helper makes the file safe:
// prepare makes the 0700 dir and an empty 0600 tmp, the mod writes the JSON into that tmp, commit checks and renames it.
// A value never goes through argv, stdout or an error. Callers get names and messages only.
const ENV_WRITER = () => `${appHome()}/mods/drover-agents/bin/drover-env-write`;
const envConfigDir = () => `${home()}/.config/drover-herdr`;
const envPath = (id) => `${envConfigDir()}/agents/${id}.json`;
// The mod's fs reaches only its appHome, so the value is written to a stage dir there; the helper moves it into the config dir.
// Reads outside appHome go through readTextFile (null when the file is absent), the way the Jira credential is read.
const envStageDir = () => `${appHome()}/drover-env-stage`;
// A fs or exec failure. Neither the editor nor the log ever gets the host's free text (a message or name could carry a value):
// only a short allowlisted code (e.code when it is a plain code word like EACCES, else "Error"), and for the log a fixed label.
const reasonCode = (e) => (typeof e?.code === "string" && /^[A-Z0-9_]{2,20}$/.test(e.code) ? e.code : "Error");
const logFailure = (where, e) => { try { globalThis.console?.log?.(`drover-agents env: ${where} failed: ${reasonCode(e)}`); } catch {} };
const validId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(String(id));
// Runs the helper. Returns { out } or { error }. A helper that cannot start (exec rejects) is an error too; its raw text is dropped.
const helper = async (...args) => {
  let r;
  try { r = await exec(ENV_WRITER(), [...args, "--config-dir", envConfigDir(), "--stage-dir", envStageDir()]); }
  catch (e) { logFailure(`helper ${args[0]}`, e); return { error: `The environment helper could not run (${reasonCode(e)})` }; }
  if (r?.code === 0) return { out: String(r.stdout ?? "").trim() };
  const reason = String(r?.stderr ?? "").trim().split("\n").pop().replace(/^drover-env-write: /, "");
  return { error: reason.slice(0, 200) || "The environment helper failed" };
};

// Names only: { names } (none when there is no file) or { error }. Never returns a value.
export async function readEnvNames(id) {
  if (!validId(id)) return { names: [] };
  let text;
  try { text = await readTextFile(envPath(id)); }
  catch (e) { logFailure("read", e); return { error: `Cannot read the environment (${reasonCode(e)})` }; }
  if (text == null) return { names: [] };
  const r = parseAgentEnv(text);
  return r.error ? { error: r.error } : { names: r.names };
}

// rows: [{ name, value }]. value "" or null keeps the saved value of that name (never read into the UI: merged here, in memory).
// Writes the full set: names not in rows are dropped; no rows removes the file. Returns { names } or { error }.
export async function writeAgentEnv(id, rows) {
  if (!validId(id)) return { error: "Bad agent id" };
  const seen = new Set();
  for (const r of rows) { if (seen.has(r.name)) return { error: `${r.name} is listed twice` }; seen.add(r.name); }
  const names = rows.map((r) => r.name);
  const problem = envProblem(names);
  if (problem) return { error: problem };
  if (!rows.length) return deleteAgentEnv(id).then((e) => (e ? { error: e } : { names: [] }));
  let saved = null;
  const need = rows.filter((r) => !r.value);
  if (need.length) {
    let text = null;
    try { text = await readTextFile(envPath(id)); } catch (e) { logFailure("read", e); return { error: `Cannot read the saved environment (${reasonCode(e)})` }; }
    const parsed = text == null ? null : parseAgentEnv(text);
    saved = parsed && !parsed.error ? parsed.env : {};
    const missing = need.find((r) => typeof saved[r.name] !== "string");
    if (missing) return { error: `${missing.name} needs a value` };
  }
  const env = {};
  for (const r of rows) env[r.name] = { value: r.value ? String(r.value) : saved[r.name], secret: true };
  const body = JSON.stringify({ version: 1, env });
  const checked = parseAgentEnv(body);
  if (checked.error) return { error: checked.error };
  const prep = await helper("prepare", id);
  if (prep.error) return { error: prep.error };
  const tmp = prep.out;
  if (!new RegExp(`^${id}\\.[0-9a-f]{16}\\.tmp$`).test(tmp)) return { error: "The environment helper gave an unexpected answer" };
  let committed = false;
  try {
    try { await fs.writeFile(`${envStageDir()}/${tmp}`, body); }
    catch (e) { logFailure("write", e); return { error: `Could not write the environment file (${reasonCode(e)})` }; }
    const done = await helper("commit", id, tmp);
    if (done.error) return { error: done.error };
    committed = true;
    return { names };
  } finally {
    if (!committed) await helper("abort", id, tmp); // never leaves a secret-bearing tmp behind
  }
}

// Removes the env file (and a stale tmp). Returns an error text, or null.
export async function deleteAgentEnv(id) {
  if (!validId(id)) return "Bad agent id";
  return (await helper("delete", id)).error ?? null;
}

// { id: count } for the agent list. An unreadable file counts as 0 (the editor shows the problem).
export async function envCounts(ids) {
  const out = {};
  for (const id of ids) out[id] = (await readEnvNames(id)).names?.length ?? 0;
  return out;
}

// Inbox op project-add. Every Git check awaits, so the store is read only after the last await and the name/equality recheck plus the write
// happen in one synchronous block: a project the Projects dialog or another request saved meanwhile is never overwritten or duplicated.
const gitOut = (cwd, args) => exec("git", ["-C", cwd, ...args], { timeout: 10000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
async function projectAdd(cmd) {
  const q = projectAddRequest(cmd);
  if (q.error) return `error: ${q.error}`;
  const { name, repo, folders } = q.value;
  let branch = q.value.branch, warning = "";
  if (branch) {
    const f = await exec("git", ["check-ref-format", "--branch", branch], { timeout: 10000 }).catch(() => ({ code: 1, stdout: "" }));
    if (f.code !== 0 || String(f.stdout).trim() !== branch) return `error: ${branch} is not a valid branch name`;
  }
  if ((await gitOut(repo, ["rev-parse", "--git-dir"])).code !== 0) return `error: ${repo} is not a git repository on this machine`;
  const head = await gitOut(repo, ["symbolic-ref", "--short", "HEAD"]);
  const current = head.code === 0 ? String(head.stdout).trim() : "";
  const committed = (await gitOut(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).code === 0;
  if (!committed && current) { // unborn HEAD: the branch exists only as a name
    if (branch && branch !== current) return `error: branch ${branch} does not exist; this repo has no commit yet and its branch is ${current}`;
    branch = current;
    warning = " · no commit yet; the first start needs one";
  } else if (branch) {
    if ((await gitOut(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).code !== 0) return `error: branch ${branch} does not exist in ${repo}`;
  } else branch = current || "main";
  // ---- no await below: re-read, recheck, write ----
  const projects = loadProjects();
  const same = projectNamed(projects, name);
  const req = { name, repo, branch, folders };
  if (same) {
    const diff = projectDiff(same, req);
    return diff.length ? `error: a project named ${same.name} exists (${same.id}) with a different ${diff.join(", ")}; nothing changed` : `ok: ${same.id} exists`;
  }
  const r = addProject(projects, { name, repos: [repo], folders, branch });
  if (r.error) return `error: ${r.error}`;
  setShared(PROJECTS_KEY, r.projects);
  return `ok: ${r.project.id} project ${r.project.name}${warning}`;
}

// Arrival times of the pending request files, for `ttlMs`: ONE batched exec per drain pass, before any read or unlink.
// The mod fs has no stat, so the host runs it: GNU `stat -c '%Y %n'`, else BSD `stat -f '%m %N'`, as argv (never a shell string).
// Returns Map path -> mtime in seconds; a file it cannot stat is absent (arrivalOf then falls back to the epoch in the name).
async function mtimesOf(paths) {
  const want = new Set(paths), rows = new Map();
  for (const argv of [["-c", "%Y %n"], ["-f", "%m %N"]]) { // GNU first: BSD's `-f` would print filesystem info on GNU
    try {
      const r = await exec("stat", [...argv, ...paths], { timeout: 10000 });
      for (const line of String(r?.stdout ?? "").split("\n")) { const m = /^(\d+) (.+)$/.exec(line); if (m && want.has(m[2])) rows.set(m[2], Number(m[1])); }
    } catch {}
    if (rows.size) break;
  }
  return rows;
}

async function drain() {
  const names = (await fs.readdir(INBOX())).filter((n) => n.endsWith(".json"));
  const mtimes = names.length ? await mtimesOf(names.map((n) => `${INBOX()}/${n}`)) : new Map();
  for (const name of names) {
    const path = `${INBOX()}/${name}`;
    let text;
    try { text = await fs.readFile(path, "utf8"); await fs.unlink(path); } catch { continue; }
    // No await between check and mark: a 2nd mod that read the same file sees the name and skips.
    // A request that is then refused (bad, expired, stale) is marked and answered like any other: once.
    const s = firstSight(shared(SEEN_KEY), name);
    if (!s.fresh) continue;
    setShared(SEEN_KEY, s.seen);
    let cmd = null;
    try { cmd = JSON.parse(text); } catch {}
    let reply;
    // The only await before the gate (the Jira site for `link`), so the compare and the apply below stay in one turn.
    const jira = cmd?.op === "link" ? await jiraSite().catch(() => "") : "";
    // ---- no await from here to the apply: bad -> expired -> stale (against the rev of the card as it is NOW) -> apply ----
    const tasks = load();
    const gate = cmd && typeof cmd === "object" ? inboxGate(cmd, tasks, { arrival: arrivalOf(name, mtimes.get(path)), now: Date.now() }) : null;
    if (gate) {
      reply = `error: ${gate.error}`;
    } else if (cmd?.op === "protocol") {
      // The probe. A sender must get `ok: protocol 2` before it sends ifRev or ttlMs: an OLD consumer ignores both fields and applies the
      // request unconditionally (it answers this probe `error: Unknown drover command`). Changes no state.
      reply = `ok: protocol ${PROTOCOL}`;
    } else if (cmd?.op === "wake") {
      // Two open mods can read the same file before either unlinks it: the file name dedupes.
      if (loadWakes().some((w) => w.src === name)) continue;
      const r = addWake(loadWakes(), { ...cmd, source: "agent" });
      if (!r.error) setShared(WAKE_KEY, r.list.map((w) => (w.id === r.wake.id ? { ...w, src: name } : w)));
      reply = r.error ? `error: ${r.error}` : `ok: ${r.wake.id} to ${r.wake.target} at ${new Date(r.wake.due).toLocaleString()}`;
    } else if (/^(wakes|wake-(off|on|rm))$/.test(cmd?.op ?? "")) {
      const r = wakeOp(loadWakes(), cmd);
      if (r.list) setShared(WAKE_KEY, r.list);
      reply = r.reply;
    } else if (cmd?.op === "start") {
      reply = await startFromAgent(cmd);
    } else if (cmd?.op === "next") {
      reply = nextFor(cmd.from);
    } else if (cmd?.op === "project-add") {
      reply = await projectAdd(cmd);
    } else if (cmd?.op === "add") {
      const pk = projectKey(loadProjects(), cmd.project);
      const owned = pk.error ? null : ownerError(loadProjects(), pk.id);
      const r = pk.error ? pk : owned ? { error: owned } : addCommand(load(), cmd, pk.id);
      if (!r.error) setShared(KEY, r.tasks);
      reply = r.error ? `error: ${r.error}` : `ok: ${r.task.id} added to ${r.task.column}`;
    } else {
      if (cmd?.op === "note" || cmd?.op === "link") cmd = { ...cmd, by: terminalName(loadRuns(), String(cmd.by ?? "")) || "you" }; // an address becomes the agent's name
      if (cmd?.op === "move") cmd = { ...cmd, fromDrover: isLiveDrover(loadRuns(), String(cmd.from ?? ""), liveState().alive) }; // always set here: a request file cannot claim it
      if (cmd?.op === "link") cmd = { ...cmd, jiraSite: jira }; // always set here: a request file cannot claim it
      const pk = cmd?.op === "project" ? projectKey(loadProjects(), cmd.project) : { id: null };
      // A retained card of a remote project is not edited here either: stored ownership counts, not only the destination.
      const owned = pk.error ? null : ownerError(loadProjects(), pk.id) ?? ownerError(loadProjects(), typeof cmd?.id === "string" ? tasks.find((x) => x.id === cmd.id)?.project : null);
      const r = pk.error ? pk : owned ? { error: owned } : applyCommand(tasks, cmd.op === "project" ? { ...cmd, project: pk.id } : cmd);
      if (!r.error) setShared(KEY, r.tasks);
      reply = r.error ? `error: ${r.error}` : cmd.op === "project" ? `ok: ${r.task.id} project ${r.task.project ?? "none"}` : cmd.op === "link" ? `ok: ${r.task.id} source ${r.task.source?.url ?? "none"}` : cmd.op === "note-edit" || cmd.op === "note-rm" ? `ok: ${r.task.id} ${cmd.noteId} ${cmd.op === "note-rm" ? "removed" : "edited"}` : cmd.op === "note" || cmd.op === "edit" ? `ok: ${r.task.id} ${cmd.op === "note" ? `note ${r.task.notes.length}` : "edited"}` : `ok: ${r.task.id} -> ${r.task.column}`;
    }
    await fs.writeFile(path.replace(/\.json$/, ".result"), reply);
  }
}

const liveState = () => ({ live: liveStatuses(agents(), terminals()), alive: new Set(terminals().map((x) => x.address)) });

// Called from the Room and Runs timers: saves "first observed ended" times; writes only when something changed.
// No terminals at all means Herdr is not ready yet, not that every run ended: write nothing then.
export function observeEnded(now = Date.now()) {
  const { live, alive } = liveState();
  if (!alive.size) return false;
  const runs = loadRuns(), next = markEnded(runs, live, alive, now);
  if (next !== runs) setShared(RUNS_KEY, next);
  reapOrphans(next, alive); // background: the stamps are written before its first await
  return next !== runs;
}

// A closed space or leader tab leaves its parked workers (no pane) running: kill each, then stamp `reaped` so it
// never repeats. Stamped only after the kill succeeded, or after the live list confirmed the terminal is gone;
// a failed kill is "unknown" and is retried on the next tick. `reaping` stops overlapping ticks from killing twice.
const reaping = new Set();
async function reapOrphans(runs, alive) {
  const spaceIds = new Set(spaces().map((s) => s.id)), todo = new Set();
  for (const r of runs) for (const a of orphanedWorkers(r, alive, spaceIds)) if (!reaping.has(a)) todo.add(a);
  for (const a of todo) {
    reaping.add(a);
    try {
      if (alive.has(a)) await herdr(["terminal.kill", "--terminal", a]);
      setShared(RUNS_KEY, loadRuns().map((r) => ((r.terminals ?? []).some((t) => t.address === a)
        ? { ...r, terminals: r.terminals.map((t) => (t.address === a ? { ...t, reaped: true } : t)) } : r)));
    } catch {} finally { reaping.delete(a); }
  }
  return todo.size > 0;
}

// `drover next`: the free slots of the caller's project and the Ready cards to start. Starts nothing.
function nextFor(from) {
  const runs = loadRuns(), project = projectOfDrover(runs, String(from ?? ""));
  if (!project) return "error: you are not bound to a project (queue mode needs a Drover started with a project)";
  const { live, alive } = liveState();
  const rec = reconcile(load(), runs, alive, Date.now(), project);
  if (rec.lines.length) setShared(KEY, rec.tasks);
  const tasks = rec.tasks;
  return [nextReport(tasks, loadProjects(), project, Math.max(0, maxRuns() - activeFor(runs, tasks, project, live, alive))), ...rec.lines].join("\n");
}

// `drover start <T-…|-> <squad|agent> [--worktree]` from a coordinator agent.
async function startFromAgent(cmd) {
  const cfg = loadConfig();
  const kind = cfg.squads.some((q) => q.id === cmd.runner) ? "squad" : cfg.agents.some((a) => a.id === cmd.runner) ? "agent" : null;
  if (!kind) return `error: no squad or agent ${cmd.runner} (see: drover squads)`;
  const task = cmd.task ? load().find((t) => t.id === cmd.task) : null;
  if (cmd.task && !task) return `error: no task ${cmd.task}`;
  const pk = projectKey(loadProjects(), cmd.project);
  if (pk.error) return `error: ${pk.error}`;
  const bind = { ...cmd, project: pk.id };
  const owned = ownerError(loadProjects(), task ? task.project : pk.id);
  if (owned) return `error: ${owned}`;
  const guard = startGuard({ tasks: load(), runs: loadRuns(), projects: loadProjects(), binding: shared(BIND_KEY) ?? {}, ...liveState() }, bind);
  if (guard.error) return `error: ${guard.error}`;
  // No await between the guard and the claim: a 2nd start of the same card sees "claiming" and stops.
  const queueProject = projectOfDrover(loadRuns(), String(cmd.from ?? ""));
  const c = task ? claim(load(), task.id, queueProject ?? undefined, undefined, liveState().alive) : null;
  if (c?.error) return `error: ${c.error}`;
  if (c) setShared(KEY, c.tasks);
  // Reserve the project before the first await (shared, so other open mods see it); clear it when the launch ends.
  const reserved = cmd.runner === "drover" ? (task ? task.project : bind.project) : null;
  const setBinding = (v) => setShared(BIND_KEY, { ...(shared(BIND_KEY) ?? {}), [reserved]: v });
  if (reserved) setBinding(Date.now());
  const r = await launch(c?.task ?? task, { kind, id: cmd.runner }, { worktree: Boolean(cmd.worktree), reportTo: cmd.from || null, project: bind.project });
  if (reserved) setBinding(undefined);
  if (r.error) {
    if (c) setShared(KEY, release(load(), task.id, c.prev).tasks);
    return `error: ${r.error}`;
  }
  const lead = r.terminals[r.terminals.length - 1];
  return `ok: ${r.id} leader ${lead.address} (${lead.name})` +
    r.terminals.slice(0, -1).map((m) => ` · ${m.role.split(/[.:(]/)[0].trim()} ${m.address}`).join("") +
    (r.worktree ? ` · worktree ${r.worktree.path} on ${r.worktree.branch}` : "");
}

export function watchInbox(cx) {
  cx.timer?.every?.(30000, () => { observeEnded(); }); // reaps parked workers of a closed space even with no Room or Runs view open
  cx.spawn(async (cx) => {
    await loadPolicy("drover-runs", "drover-wakeups", "drover-room").catch(() => {});
    await fs.mkdir(INBOX(), { recursive: true }).catch(() => {});
    for (;;) {
      await drain().catch(() => {});
      cx.notify();
      await watchFolder(INBOX());
    }
  });
}

// Wakeup delivery. Runs in the Tasks panel and the Wakeups mod; the "sending" claim stops a double send.
// A task target resolves to its agent at delivery time; a parked terminal's status comes from the terminal list; one without a status counts as "running".
export function wakeTarget(target) {
  const address = target.startsWith("T-") ? load().find((x) => x.id === target)?.agent : target;
  if (!address) return { address: null, status: undefined };
  return { address, status: liveStatuses(agents(), terminals()).get(address) ?? (terminals().some((x) => x.address === address) ? "running" : undefined) };
}

export function deliverWakes(cx) {
  const put = (id, status, reason) => setShared(WAKE_KEY, setStatus(loadWakes(), id, status, reason));
  for (const w of loadWakes()) {
    const { address, status } = wakeTarget(w.target);
    const d = decide(w, status);
    if (d.action === "wait" && d.reason !== w.reason) setShared(WAKE_KEY, loadWakes().map((x) => (x.id === w.id ? { ...x, reason: d.reason } : x)));
    if (d.action === "expire") put(w.id, "expired", d.reason);
    if (d.action === "skip") setShared(WAKE_KEY, reschedule(loadWakes(), w.id, d.reason));
    if (d.action === "fail") put(w.id, "failed", d.reason);
    if (d.action !== "send") continue;
    put(w.id, "sending", null);
    cx.spawn(async () => {
      let r;
      try { r = await hc(["send", address, w.text]); } catch (e) { r = { code: 1, stderr: String(e?.message ?? e) }; }
      if (r.code === 0 && (w.every || w.sched)) setShared(WAKE_KEY, reschedule(loadWakes(), w.id, `sent to ${address}`));
      else if (r.code === 0) put(w.id, "sent", `to ${address}`);
      else put(w.id, "failed", `hc send failed (may have arrived): ${(r.stderr ?? "").trim().split("\n")[0]}`);
    });
  }
}

export function watchWakes(cx) {
  // Async work runs in cx.spawn with the fresh context it hands over: a callback's cx is dead after an await.
  const tick = (cx) => cx.spawn(async (cx) => { await loadPolicy("drover-wakeups").catch(() => {}); deliverWakes(cx); cx.notify(); });
  cx.timer.every(15000, tick);
  tick(cx);
}

// What a wakeup row shows: its task (direct, or through the run of the target terminal) and agent.
export function wakeInfo(w, runs = loadRuns(), tasks = load()) {
  const run = w.target.startsWith("T-") ? null : runs.find((r) => r.terminals.some((m) => m.address === w.target));
  const task = tasks.find((x) => x.id === (w.target.startsWith("T-") ? w.target : run?.task)) ?? null;
  const { address, status } = wakeTarget(w.target);
  const member = runs.flatMap((r) => r.terminals).find((m) => m.address === address);
  const agent = agents().find((a) => a.address === address);
  return { task, address, status, name: member?.name ?? agent?.tab_name ?? null };
}

// Jira: the site comes from Drover Config (drover-jira.site, empty by default: nothing is shipped) and the only
// credential file is below. Never prints the token.
// jiraFetch(site, path, init, stillCurrent): stillCurrent() is checked again after the credential read, right before fetch;
// false throws JIRA_STALE (the caller drops it).
export const JIRA_STALE = Symbol("jira-stale");
export const JIRA_NO_SITE = "Set the Jira site in Drover Config";
const JIRA_CREDENTIALS = "/.config/drover-herdr/atlassian.json";
const JIRA_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

// The configured site ("" when not configured). Works in any mod: binds the config reader and loads the mod.json layer once.
export async function jiraSite() {
  bindCfg({ shared, modSettings });
  if (!cfgReady("drover-jira")) await loadCfg("drover-jira");
  return cfg("drover-jira", "site");
}

// An empty site throws JIRA_NO_SITE before the credential file is read or any request is made.
export async function jiraFetch(site, path, init = {}, stillCurrent) {
  if (!site) throw new Error(JIRA_NO_SITE);
  if (!JIRA_HOST.test(site)) throw new Error(`The Jira site must be a host name such as acme.atlassian.net, not ${JSON.stringify(site)}.`);
  const raw = await readTextFile(home() + JIRA_CREDENTIALS).catch(() => null);
  let cred = null;
  try { cred = JSON.parse(raw ?? ""); } catch {}
  if (!cred?.email || !cred?.apiToken) throw new Error(`No Jira credential. Create ~${JIRA_CREDENTIALS} (see docs/guides/jira-setup.md).`);
  if (stillCurrent && !stillCurrent()) throw JIRA_STALE;
  const r = await fetch(`https://${site}${path}`, { ...init, headers: { Authorization: "Basic " + base64(`${cred.email}:${cred.apiToken}`), Accept: "application/json", "Content-Type": "application/json", ...init.headers } });
  if (r.url && !r.url.startsWith(`https://${site}/`)) throw new Error("Jira redirected elsewhere; refused.");
  if (!r.ok) throw new Error(httpProblem(r.status));
  return r.json();
}

// E11: the issue a run works on and the PRs on its branch. Read-only. Errors are per part,
// so a gh failure never hides the Jira issue and the other way round.
export const ROOM_KEY = "drover.room";
// Open PRs whose head holds the run branch's commits (the branch was merged into another PR branch).
// Skips a branch already in the PR base, else every PR off main would match.
// ponytail: checks only the 20 newest open PRs and only commits already fetched locally.
async function carriedBy(wt, live) {
  live();
  const r = await exec("gh", ["pr", "list", "--state", "open", "--limit", "20",
    "--json=number,title,state,isDraft,url,createdAt,headRefName,headRefOid,baseRefName"], { cwd: wt.path, timeout: 30000 });
  if (r.code !== 0) return [];
  const has = async (ref) => (live(), await exec("git", ["merge-base", "--is-ancestor", wt.branch, ref], { cwd: wt.path, timeout: 10000 })).code === 0;
  const out = [];
  for (const p of JSON.parse(r.stdout)) {
    if (p.headRefName !== wt.branch && await has(p.headRefOid) && !(await has(`origin/${p.baseRefName}`))) out.push({ ...p, via: p.headRefName });
  }
  return out;
}

// current(): a screen's "still wanted" check (on, same generation). It is tested before every request, and a load that is no
// longer wanted throws CONTEXT_STALE (not an error part): the caller drops it. Callers with no screen pass nothing.
export const CONTEXT_STALE = Symbol("context-stale");
export async function loadContext(run, task, current = () => true) {
  const live = () => { if (!current()) throw CONTEXT_STALE; };
  live();
  await loadPolicy("drover-room").catch(() => {});
  live();
  const out = { at: Date.now(), issue: null, prs: null, errors: [] };
  const src = task?.source;
  let linked = [];
  try {
    if (src?.kind === "jira") {
      const key = jiraKey(src.url);
      if (!key) throw new Error(`Can't read a Jira key from ${src.url}`);
      live();
      const site = await jiraSite();
      live();
      out.issue = jiraIssue(await jiraFetch(site, `/rest/api/3/issue/${key}?fields=summary,status,assignee,project,issuetype,parent`, undefined, current), site);
    } else if (src?.kind === "github") {
      const pr = /\/pull\/\d+/.test(src.url);
      const fields = pr ? "number,title,state,assignees,url" : "number,title,state,assignees,url,closedByPullRequestsReferences";
      live();
      const r = await exec("gh", [pr ? "pr" : "issue", "view", src.url, `--json=${fields}`], { timeout: 30000 });
      if (r.code !== 0) throw new Error(`gh: ${(r.stderr ?? "").trim().split("\n")[0]}`);
      out.issue = githubIssue(JSON.parse(r.stdout), src.url);
      linked = pr ? [out.issue.url] : out.issue.linked; // a PR source also shows under Pull requests
    }
  } catch (e) { if (e === CONTEXT_STALE || e === JIRA_STALE) throw CONTEXT_STALE; out.errors.push(`Issue: ${e?.message ?? e}`); }
  if (src?.kind === "github" && !out.issue) return out; // linked PRs unknown: prs stays null so mergeContext keeps the last good list
  try {
    const rows = [];
    const json = "--json=number,title,state,isDraft,url,createdAt";
    const wt = run?.worktree; // no run (the task editor before any run): only linked PRs
    if (wt?.branch) {
      const args = ["pr", "list", "--head", wt.branch, "--state", "all", json];
      let cwd = wt.path;
      // exec rejects (not a non-zero code) when the cwd is missing.
      const ask = (dir) => exec("gh", args, { cwd: dir, timeout: 30000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      live();
      let r = await ask(cwd);
      // A finished run's worktree folder is removed and a spawn in a missing cwd fails: ask again from the repo (the branch stays).
      if (r.code !== 0 && wt.repo && wt.repo !== wt.path) { cwd = wt.repo; live(); r = await ask(cwd); }
      if (r.code !== 0) throw new Error(`gh: ${(r.stderr ?? "").trim().split("\n")[0]}`);
      rows.push(...JSON.parse(r.stdout).map((p) => ({ ...p, from: "branch" })));
      if (!rows.length) rows.push(...(await carriedBy({ ...wt, path: cwd }, live)).map((p) => ({ ...p, from: "branch" })));
    }
    for (const url of linked.slice(0, cfg("drover-room", "pr_cap"))) {
      live();
      const r = await exec("gh", ["pr", "view", url, json], { timeout: 30000 });
      if (r.code !== 0) throw new Error(`gh: ${(r.stderr ?? "").trim().split("\n")[0]}`); // null prs: mergeContext keeps the last good list
      rows.push({ ...JSON.parse(r.stdout), from: "linked" });
    }
    out.prs = prItems(rows);
  } catch (e) { if (e === CONTEXT_STALE) throw e; out.errors.push(`Pull requests: ${e?.message ?? e}`); }
  return out;
}

// Keeps the last good part when a refresh fails it, with the error beside it.
export function mergeContext(prev, next) {
  const failed = (part) => next.errors.some((e) => e.startsWith(part));
  return { ...next, issue: next.issue ?? (failed("Issue") ? prev?.issue ?? null : null), prs: next.prs ?? (next.errors.length ? prev?.prs ?? null : null), good: next.errors.length ? prev?.good ?? null : next.at };
}

// The `settings` block of a mod's installed mod.json (Better Config writes it; Herdr reloads the mod on save).
export async function modSettings(name) {
  try {
    const s = JSON.parse((await readTextFile(`${appHome()}/mods/${name}/mod.json`)) ?? "{}").settings;
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

// keys.json under appHome: the owner's file. readKeys is the text (null when absent); setShortcut backs it up, then writes only Drover's binding.
export const readKeys = () => readTextFile(`${appHome()}/keys.json`);
export const keysIo = () => ({
  read: readKeys,
  write: (path, text, expected) => writeTextFile(path, text, expected),
  path: `${appHome()}/keys.json`,
  now: () => new Date().toISOString().replace(/[:.]/g, "-"),
});
export const setShortcut = (shortcut, on) => applyKey(keysIo(), shortcut, on);
