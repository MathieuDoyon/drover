// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// The herdr side of the store: tasks persist in shared state (shared.json, written atomically).
import { shared, setShared, openOverlay, exec, hc, readTextFile, writeTextFile, notify, focused, appHome, home, watchFolder, spaces, panes, agents, terminals, keys as hostKeys } from "herdr";
import * as fs from "fs/promises";
import { KEY, SEEN_KEY, PROJECTS_KEY, firstSight, list, add, update, bySource, addCommand, addProjectKey, applyCommand, columnName, repoOf, projectOf, projectKey, projectAddRequest, projectDiff, PROTOCOL, inboxGate, arrivalOf, addProject, projectNamed, nextReport, claim, release, editSize, CLAIMING, clearClaimToken } from "./store.js";
import { base64, httpProblem, jiraIssue, jiraKey, githubIssue, prItems } from "./sources.js";
import { ownerError, bindRemote, bindings as remoteBindings, mergeRemote, cacheKey } from "./remote.js";
import { createExecReader, createExecWriter, probeExec, controls as execControls, opGate, skewReason, UI_OPS } from "./remote-exec.js";
import { createNeedsCache } from "./needs.js";
import { cleanAsk, terminalIdOk } from "./asks.js";
import { createHealth, HEALTH_PY, readResult } from "./health.js";
import { LOCAL, createLocalRead, judge, limitsFor, sampleOfRow, reservedWarning } from "./loadhold.js";
import { validate as validateLine, activeFor } from "./runline.js";
import { WAKE_KEY, reschedule, retryWake, addWake, decide, setStatus, wakeOp } from "./wake.js";
import { DISMISS_KEY, dismiss, restore, prune, helpMessage } from "./dismiss.js";
import { apply as applyKey } from "./keys.js";
import * as HE from "./herd-export.js";
import { resolveWorkFolder, moveOffers, parseMove } from "./workfolder.js";
import { bind as bindCfg, load as loadCfg, ready as cfgReady, cfg, KEY as CONFIG_KEY, configGet, configSet } from "./config.js";
import { soulHash } from "./herd-export.js";
import { lessonPaths, boundText } from "./lessons.js";
import { exportName } from "./herd-share.js";
import { createLock, lockKey } from "./accept.js";
import { linkedRun } from "./taskrun.js";
import { classifyChecks, reviewOf, proofPathOf, buildEvidence, ghCall, ghProblem, repoOfUrl, ENV_BIN } from "./evidence.js";
import { AGENTS_KEY, RUNS_KEY, config, plan, argv, leaderPrompt, createCardsPrompt, memberPrompt, worktreeOf, terminalName, startGuard, projectOfDrover, isLiveDrover, slotSnapshot, slotsOf, reconcile, runFolder, markEnded, orphanedWorkers, terminalRecord, agentKind, newUuid, withSessionFlag, withMarker, pickCodexSession, liveStatuses, memberStatus, resumeCandidates, resumeToken, resumeGuard, resumePrompt, resumedTerminal, resumedRun, linkResumed, sessionMarker, claimTtl, launchArgv, parseAgentEnv, envProblem, BIND_KEY, droverChoices, defaultDrover, maxRuns, keptRuns, pruneRuns } from "./runs.js";

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

// B3a: the read-only proof dialog of a Review card (hosted by drover-todos, see drover-todos/proof.js). It names the card by id AND project and reads this machine only.
export const openProof = ({ id, project }) => openOverlay({ mod: "drover-todos", kind: "dialog", modal: true, width: 720, height: 0.8, props: { proof: { id, project: project ?? null } } });

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
const remoteShared = { getShared: (k) => shared(k), setShared: (k, v) => setShared(k, v ?? undefined) };
const remoteBound = (machine, projectId, id) => remoteBindings(loadProjects()).some((b) => b.machine === machine && b.projectId === projectId && b.id === id);
const execRemote = createExecReader({ run: remoteRun, active: () => screenOn(), ...remoteShared, bound: remoteBound, log: (m) => globalThis.console?.log?.(m) });
const bindingOf = (machine, projectId) => loadProjects().find((p) => p.remote?.machine === machine && p.remote.projectId === projectId)?.remote;
// The reader of every binding: the exec transport (drover-headless over hc exec) is the only one. bind checks the machine over exec before it saves the binding.
export const remote = {
  bind: (project, args, ctx) => bindRemote({ run: remoteRun, probeExec: (machine, projectId) => probeExec(remoteRun, machine, projectId) }, project, args, ctx),
  detach: (machine, projectId) => execRemote.detach(machine, projectId),
  sync: (list) => execRemote.sync(list),
  suspend: () => execRemote.suspend(),
  tick: () => execRemote.tick(),
  read: (machine, projectId) => execRemote.read(machine, projectId),
  retry: (machine, projectId) => execRemote.retry(machine, projectId),
  view: (machine, projectId) => execRemote.view(machine, projectId),
};
export const loadProjects = () => (Array.isArray(shared(PROJECTS_KEY)) ? shared(PROJECTS_KEY) : []);

// Local cards plus the cached cards of every remote-bound project (read-only; see remote.js). { tasks, remotes } where remotes carry each banner.
export const loadMerged = () => { const ps = loadProjects(); return remoteBindings(ps).length ? mergeRemote(load(), ps, remote.view) : { tasks: load(), remotes: [] }; };
// Board / Tasks timer: keeps the tracked bindings equal to the projects' and reads the due ones (a mod copy polls on its own while it is open).
// enabled(): the owning screen's switch. Off: no read, and a read in flight is dropped (the local inbox consumer is separate and keeps running).
export function watchRemote(cx, enabled = () => true) {
  screenOn = enabled;
  const tick = (cx) => {
    if (!enabled()) { remote.suspend(); return; }
    const list = remoteBindings(loadProjects());
    remote.sync(list); // the whole binding, id included: the commit-time check compares it
    if (list.length && cx.spawn) cx.spawn(async (cx) => { if ((await remote.tick()).length) cx.notify(); });
    execWriter?.tick(); // ends a write wait past its deadline and drops an old held envelope
  };
  cx.timer?.every?.(1000, tick);
  tick(cx);
}
// ---- Machines in the sidebar (T-MWO2HEHGIEC): a polled health cache. health.js is pure; this is its host side. ----
// The list is local (`hc machine ls --json`). A read is the mod host's exec of `hc exec --on <m> ... python3 -c <fixed script>`: argv only (the host has no stdin).
// The host call carries a ms timeout above hc's own 20 s, so it always settles. Nothing here writes to a machine, and render only reads machineView().
const MACHINE_LIST_MS = 8000, MACHINE_EXEC_MS = 22000;
let machineScreen = () => true;
const makeHealth = () => createHealth({
  list: async () => {
    const r = await hc(["machine", "ls", "--json"], { timeout: MACHINE_LIST_MS });
    if (!r || r.code !== 0) throw new Error("machine ls");
    const o = JSON.parse(r.stdout);
    if (!Array.isArray(o?.machines)) throw new Error("machine ls shape");
    return o.machines.map((m) => ({ name: m?.name, state: m?.state }));
  },
  exec: (argv) => exec("hc", argv, { timeout: MACHINE_EXEC_MS }),
  now: () => Date.now(),
  enabled: () => cfg("drover-tasks", "machine_polling") === true,
  active: () => machineScreen(),
});
let health = makeHealth();
export const machineView = () => health.view();
export const resetMachineHealth = () => { health = makeHealth(); };
export const retryMachine = (name) => health.retry(name);
// The sidebar's own 1 s timer: health.tick() starts what is due (list, reads) and repaints only when the shown result changed. enabled(): the screen's switch.
export function watchMachines(cx, enabled = () => true) {
  machineScreen = enabled;
  let last = "";
  const tick = (cx) => {
    health.tick();
    const v = health.view();
    const sig = JSON.stringify({ ...v, machines: v.machines.map((m) => ({ ...m, ageMs: m.ageMs === null ? null : Math.floor(m.ageMs / 60000) })) });
    if (sig !== last) { last = sig; cx.notify?.(); }
  };
  cx.timer?.every?.(1000, tick);
  tick(cx);
}
// ---- The load hold (T-MWO2HEU32E4, Remote v2 A5): a NEW start waits while the machine is over its limits (loadhold.js judges; this is the host side). ----
// Advisory: a raw `hc run --on` or a hand-opened terminal bypasses it. Only an action asks (launch, the resume paths): no render path reads anything here.
// The laptop is read by one bounded local python3 (never hc, never --on), cached 60 s with one read in flight. A remote machine would use the A4 cache only
// (holdFor(name) with no row = unknown = allowed with a warning), so the future remote entry point calls the same function.
const newLocalHealth = () => createLocalRead({ exec: (cmd, args, o) => exec(cmd, args, o), now: () => Date.now(), script: HEALTH_PY, parse: readResult });
let localHealth = newLocalHealth();
export const resetLocalHealth = () => { localHealth = newLocalHealth(); };
const holdSettings = () => ({ load: cfg("drover-runs", "hold_load"), memory: cfg("drover-runs", "hold_memory"), disk: cfg("drover-runs", "hold_disk"), machines: cfg("drover-runs", "hold_machines") });
// -> { hold: string|null, warn: string|null }. Awaits the drover-runs mod.json layer first: a Picker or Todos launch never loaded another mod's policy.
export async function holdFor(machine = LOCAL, { row } = {}) {
  await loadPolicy("drover-runs").catch(() => {});
  const settings = holdSettings(), limits = limitsFor(settings, machine);
  if (machine !== LOCAL) return judge({ ...sampleOfRow(row ?? machineView().machines.find((m) => m.name === machine)), limits, label: machine });
  const x = await localHealth();
  const h = judge({ sample: x.sample, ageMs: x.sample ? x.ageMs : null, limits, label: "this computer" });
  const clash = /(^|;)\s*local\s*:/.test(settings.machines) ? reservedWarning(machineView().machines.map((m) => m.name)) : null;
  return clash ? { ...h, warn: [h.warn, clash].filter(Boolean).join(" · ") } : h;
}
// What `drover next` says, from the cache only (no read, no await): the reason a start would be held now, or null.
export function heldNote() {
  const x = localHealth.peek();
  if (!x) return null;
  const h = judge({ sample: x.sample, ageMs: x.sample ? x.ageMs : null, limits: limitsFor(holdSettings(), LOCAL), label: "this computer" });
  return h.hold ? `held: ${h.hold}` : null;
}
// A new process-opening start asks here first, before any claim, worktree, work folder or terminal. { error } = held; { warning } = allowed, health unknown.
async function startGate() {
  const h = await holdFor(LOCAL);
  if (h.hold) return { error: `held: ${h.hold}. Advisory: it only holds new starts made here; runs already going are not touched` };
  return h.warn ? { warning: h.warn } : {};
}
// What the Needs-you cache reads, once: every card (local and remote), runs, and the live agents and terminals. Called by a cache refresh only, never by render.
export function needsWorld() {
  const m = loadMerged();
  return { tasks: m.tasks, remotes: m.remotes, runs: loadRuns(), agents: agents(), terminals: terminals(), wakes: loadWakes(), asksScan, dismissed: shared(DISMISS_KEY) };
}
// ---- The asks reader (T-MWO3FDT7NKL, B4b): WHY a blocked agent waits. Owned by the Tasks mod (started at its init, not by Runs, not by render). ----
// A 1 s timer starts one scan of <appHome>/data/drover-asks through the read-only helper (host exec, 2 s deadline, one in flight; a scan older than the
// reader's own guard is abandoned and its late answer ignored). The last confirmed scan lives in memory (asksScan); an unknown scan (error, timeout,
// bad output) changes nothing. needsWorld() hands the memory to the cache, which decides what still holds. The reader only reads: it writes, deletes and answers nothing.
const ASKS_DEADLINE_MS = 2000, ASKS_ABANDON_MS = 5000;
let asksScan = null, asksSig = "", asksFlight = null, asksGen = 0;
const asksListeners = new Set();
export const asksSnapshot = () => asksScan;
export const resetAsks = () => { asksScan = null; asksSig = ""; asksFlight = null; asksGen++; asksListeners.clear(); };
const asksDir = () => `${appHome()}/data/drover-asks`;
const asksHelper = () => `${appHome()}/mods/drover-tasks/bin/drover-asks-read`;
// -> { ok: true, files: Map } for a confirmed scan, else null (unknown). Every entry goes through the allowlist again.
function readAsksScan(r) {
  if (!r || r.code !== 0) return null;
  let o;
  try { o = JSON.parse(String(r.stdout ?? "").trim()); } catch { return null; }
  if (!o || o.ok !== true || !Array.isArray(o.asks)) return null;
  const files = new Map();
  for (const a of o.asks) {
    const ask = a && terminalIdOk(a.terminal) ? cleanAsk(a) : null;
    if (!ask || files.has(a.terminal)) return null; // an entry we cannot accept is a scan we cannot trust: unknown, never a dropped ask read as a clear
    files.set(a.terminal, ask);
  }
  return { ok: true, files };
}
function askScanNow() {
  const gen = ++asksGen;
  asksFlight = { gen, at: Date.now() };
  Promise.resolve().then(() => exec(asksHelper(), [asksDir()], { timeout: ASKS_DEADLINE_MS })).catch(() => null).then((r) => {
    if (gen !== asksGen) return; // abandoned: a late answer counts for nothing
    asksFlight = null;
    const next = readAsksScan(r);
    if (!next) return; // unknown: nothing changes
    const sig = JSON.stringify([...next.files].sort(([a], [b]) => (a < b ? -1 : 1)));
    asksScan = next;
    if (sig === asksSig) return;
    asksSig = sig;
    for (const f of [...asksListeners]) try { f(); } catch {}
  });
}
// onChange: called when a confirmed scan differs from the last one (the screen refreshes its cache and repaints). gate(): the screen's switch.
export function startAsks(cx, { gate = () => true, onChange = () => {} } = {}) {
  asksListeners.add(onChange);
  const tick = () => {
    if (!gate()) return;
    if (asksFlight) { if (Date.now() - asksFlight.at <= ASKS_ABANDON_MS) return; asksGen++; asksFlight = null; }
    askScanNow();
  };
  cx.timer?.every?.(1000, tick);
  tick();
}
// ---- end asks reader
// What the Runs screen's cache reads (one read of each). resume: also the resume state of every run (a few shared keys per run), asked only while ended runs are shown.
export function runsWorld({ resume = false } = {}) {
  return { runs: loadRuns(), tasks: load(), projects: loadProjects(), agents: agents(), terminals: terminals(),
    ...(resume ? { resumeOf: (id) => { const state = resumeState(id); return { state, can: state === "none" && canResume(id) }; } } : {}) };
}
// What the Jump palette reads, once per refresh (never in render): every card (local + the already loaded remote cache: no watch, no probe), projects, runs, agents AND terminals.
export function jumpWorld() {
  return { tasks: loadMerged().tasks, projects: loadProjects(), runs: loadRuns(), agents: agents(), terminals: terminals() };
}
// A screen's Needs-you cache: refreshed once now and every second by its own timer (live agent status has no event), repainting only when the result changed.
// gate(): the screen's switch (false: no refresh, no remote read). remote: this screen also keeps the remote boards fresh (a mod copy may be the only one open).
export function startNeeds(cx, { read = needsWorld, gate = () => true, remote = false } = {}) {
  const cache = createNeedsCache({ read });
  // The shared Dismiss map is bounded by the clock only (30 days, newest 200), never by what a read returned: a read can be empty or partial for a moment.
  const sweep = () => {
    const cur = shared(DISMISS_KEY);
    if (cur == null) return;
    const kept = prune(cur, Date.now());
    if (kept !== cur) setShared(DISMISS_KEY, kept);
  };
  cx.timer.every(1000, (cx) => { if (gate() && cache.refresh()) cx.notify(); if (gate()) sweep(); });
  cache.refresh();
  sweep();
  if (remote) watchRemote(cx, gate);
  return cache;
}
// ---- Remote project, step 2: writes over the exec transport (T-MWO2UYPADZC). remote-write.js builds the request, remote-exec.js sends it. ----
// Each mod copy that polls (Board, Tasks) owns one writer. Origin: this laptop's stable tag in every nonce.
const ORIGIN_KEY = "drover.remote-origin";
const originTag = () => {
  let origin = shared(ORIGIN_KEY);
  if (!/^[A-Za-z0-9]{1,16}$/.test(origin ?? "")) { origin = `D${Math.random().toString(36).slice(2, 9).padEnd(7, "0")}`; setShared(ORIGIN_KEY, origin); }
  return origin;
};
const remoteBinding = (localId) => remoteBindings(loadProjects()).find((b) => b.localId === localId) ?? null;
// No probe, no freeze, no queue. The controls are the ones the remote reported in its ops list, and only on a fresh view.
let execWriter = null;
const execWriterOf = () => (execWriter ??= createExecWriter({
  exec: (cmd, args, opts) => exec(cmd, args, opts), origin: originTag(), log: (m) => globalThis.console?.log?.(m),
  link: (machine, projectId) => { const v = execRemote.view(machine, projectId); return { state: v.state, ops: v.ops, skew: v.skew }; },
}));
// What a Board/Tasks control needs: { remote, enabled, reason, controls, opTips, fields: { on, tip } }.
export function remoteWriteState(localId) {
  const b = remoteBinding(localId);
  if (!b) return { remote: false, enabled: false, reason: "Not a remote project" };
  const v = execRemote.view(b.machine, b.projectId);
  const ctl = execControls(v.ops);
  const rb = bindingOf(b.machine, b.projectId);
  const reason = rb?.writes === false ? "writes are off"
    : v.state === "never" ? `${b.machine} has not answered yet`
    : v.state === "stale" ? `${b.machine} unreachable: showing a saved copy, nothing can be sent`
    : skewReason(b.machine, v.skew);
  // `enabled`/`reason` are freshness, the writes switch and the clock: they gate every control. Each op then has its own gate (controls, opTips), which controlState(ws, op) applies.
  const opTips = Object.fromEntries(UI_OPS.map((o) => [o, opGate(v.ops, o)]));
  return { remote: true, enabled: reason === null, reason, controls: ctl, opTips, fields: { on: reason === null && ctl.edit, tip: ctl.edit ? null : opTips.edit } };
}
// A card change on a remote project: only remote-write.js builds the request. The board is re-read after a save.
export async function remoteSend(localId, op, cx) {
  const b = remoteBinding(localId);
  if (!b) return { status: "refused", message: "Not a remote project" };
  const done = (o) => ({ ...o, machine: b.machine });
  if (bindingOf(b.machine, b.projectId)?.writes === false) return done({ status: "refused", message: "writes are off; nothing was sent" });
  let rev;
  if (op?.op !== "add") {
    const t = execRemote.view(b.machine, b.projectId).tasks.find((x) => x?.id === op?.id);
    if (!t) return done({ status: "refused", message: "That card is not in the saved copy: reload the board; nothing was sent" });
    rev = op.ifRev !== undefined ? op.ifRev : Number.isSafeInteger(t.rev) && t.rev >= 0 ? t.rev : 0;
    if (!(Number.isSafeInteger(rev) && rev >= 0)) return done({ status: "refused", message: "Bad revision; nothing was sent" });
  }
  const o = await execWriterOf().send(b.machine, b.projectId, op, { rev });
  if (o.status === "saved" || o.status === "stale") await remote.retry(b.machine, b.projectId);
  cx?.notify?.();
  return done(o);
}
// Re-read one remote project's board now (the destination of a move, or after a stale answer). Resolves when the read ended.
export async function remoteReload(localId) {
  const b = remoteBinding(localId);
  if (b) await remote.retry(b.machine, b.projectId);
}
// The writes switch: remote.writes (the binding keeps its id). Off refuses every write to that machine at once; nothing is queued.
export function setRemoteWrites(localId, on) {
  const b = remoteBinding(localId);
  if (!b) return { error: "Not a remote project" };
  setShared(PROJECTS_KEY, loadProjects().map((p) => (p.id === localId ? { ...p, remote: { ...p.remote, writes: Boolean(on) } } : p)));
  return { ok: true, writes: Boolean(on) };
}
// Forget the exec writer (a test, or a reset of the remote layer): its held envelopes go with it.
export function resetRemoteWriter() { execWriter = null; }
// The exec writer answers each send before it returns (saved, stale, refused, failed or unknown, held for a safe repeat): no outcome arrives late.
export const takeRemoteOutcomes = () => [];
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

// ---- Session ids (resume needs them). Only ids and file paths are handled here: grep runs with -l, so no transcript text is ever read.
// Claude gets a Drover-made --session-id. Codex has no such flag: its launch prompt carries a per-terminal marker and the rollout file that holds it names the session.
export const sessionSettle = { tries: 20, ms: 1500 }; // Codex writes its rollout a moment after start: bounded retries
// The label is what Reader reads. A missing hc or a failed label never fails a launch, and nothing is logged (no ids in logs).
async function labelSession(address, id) {
  try { await hc(["label", address, `revive.session=${id}`]); } catch { /* best effort */ }
}
// Rollout files sit in sessions/YYYY/MM/DD (host-local day): yesterday, today and tomorrow in both UTC and local time cover midnight and zone skew.
function codexDays(now) {
  const two = (n) => String(n).padStart(2, "0"), days = new Set();
  for (const off of [-1, 0, 1]) {
    const d = new Date(now + off * 86400000);
    days.add(`${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}`);
    days.add(`${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`);
  }
  return [...days];
}
// The session id of the one rollout file that holds the marker, or null (nothing yet, 2+ files, grep failed: never a guess).
async function findCodexSession(token) {
  try {
    const roots = codexDays(Date.now()).map((d) => `${home()}/.codex/sessions/${d}`);
    const ls = await exec("ls", ["-d", ...roots], { timeout: 10000 });
    const have = new Set(String(ls?.stdout ?? "").split("\n").map((l) => l.trim()));
    // Every root must be accounted for: listed, or named in a "No such file" line (a day folder that does not exist yet). Any other failure
    // (permission, timeout) may hide a second candidate, so the match could not be called unique: unknown.
    const absent = String(ls?.stderr ?? "").split("\n").filter((l) => /No such file or directory/.test(l));
    if (!roots.every((r) => have.has(r) || absent.some((l) => l.includes(r)))) return null;
    const dirs = roots.filter((r) => have.has(r));
    if (!dirs.length) return null;
    const r = await exec("grep", ["-r", "-l", "-F", "-s", "--include=rollout-*.jsonl", "-e", token, ...dirs], { timeout: 30000 });
    if (r?.code !== 0) return null; // 1 = no match yet; anything else is unknown, even with output
    return pickCodexSession(String(r.stdout ?? "").split("\n"));
  } catch { return null; }
}
// Re-reads the shared runs, sets the id on that run's terminal only, and writes. A pruned run is not brought back; the other fields (ended, parked, reaped) stay.
function patchSession(runId, address, session, kind) {
  const runs = loadRuns();
  const mine = (r) => r.id === runId && r.terminals?.some((x) => x.address === address); // run ids come from the clock: the address tells two same-millisecond runs apart
  const t = runs.find(mine)?.terminals.find((x) => x.address === address);
  if (!t || t.session) return false;
  setShared(RUNS_KEY, runs.map((r) => (!mine(r) ? r : { ...r, terminals: r.terminals.map((x) => (x.address === address ? { ...x, session, kind } : x)) })));
  return true;
}
// Detached from launch(): never awaited by it. The runtime that launched owns the search: if it is reloaded first, the id stays unknown.
async function discoverSessions(runId, pending) {
  await Promise.all(pending.map(async ({ address, token, source }) => { // source = the id a resume continued: replaced only while it is still the session
    try {
      for (let i = 0; i < sessionSettle.tries; i++) {
        const id = await findCodexSession(token);
        if (id) { if (source ? patchSourceSession(runId, address, source, id) : patchSession(runId, address, id, "codex")) await labelSession(address, id); return; }
        if (i < sessionSettle.tries - 1) await exec("sleep", [String(sessionSettle.ms / 1000)]); // no setTimeout in a mod: the host runs the wait
      }
    } catch { /* unknown stays unknown */ }
  }));
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

// ---- Lessons loader (T-MWMS8RGSWJC, #57 L4). Called by launch() only, never by a render. The runtime fs follows symlinks and reads whole
// files, so the read-only helper drover-lessons-read does the bounded, symlink-safe reading. Any failure gives no lessons, never a failed launch.
const LESSONS_BIN = () => `${appHome()}/mods/drover-agents/bin/drover-lessons-read`;
const LESSONS_TIMEOUT_MS = 5000;
const lessonsFailed = (e) => { try { globalThis.console?.log?.(`drover-agents lessons: read failed: ${reasonCode(e)}`); } catch {} };
// runProj: the run's project (task-bound runs too; ctx.project is null for them), or null. agentIds: the squad's agents. Returns ctx.lessons or null.
async function loadLessons(runProj, agentIds) {
  try {
    if (!home()) return null;
    const configDir = WORKFOLDER_ROOT();
    const rel = (p) => p.slice(configDir.length + 1);
    const layers = lessonPaths(configDir, { org: runProj?.org, project: runProj?.id });
    const orgRel = layers.org ? Object.fromEntries(Object.entries(layers.org).map(([k, p]) => [k, rel(p)])) : null;
    const projectRel = layers.project ? rel(layers.project) : null;
    const agentRel = {};
    for (const id of agentIds ?? []) { const p = lessonPaths(configDir, { agent: id }).agent; if (p) agentRel[id] = rel(p); }
    const asked = [...Object.values(orgRel ?? {}), ...(projectRel ? [projectRel] : []), ...Object.values(agentRel)];
    if (!asked.length) return null;
    const r = await exec(LESSONS_BIN(), ["--root", configDir, ...asked], { timeout: LESSONS_TIMEOUT_MS });
    if (r?.code !== undefined && r.code !== 0) throw new Error(`exit ${r.code}`);
    const got = JSON.parse(r?.stdout ?? "");
    if (!got || typeof got !== "object" || Array.isArray(got)) throw new Error("bad answer");
    const text = (path) => { const v = path ? got[path] : null; return v && typeof v.text === "string" ? boundText(v.text, { truncated: v.truncated === true }) : null; };
    const lessons = {
      configDir, orgSlug: orgRel ? runProj.org : null, projectId: projectRel ? runProj.id : null,
      org: orgRel ? Object.fromEntries(Object.entries(orgRel).map(([k, p]) => [k, text(p)])) : null,
      project: text(projectRel), agents: Object.fromEntries(Object.entries(agentRel).map(([id, p]) => [id, text(p)])),
    };
    const any = Object.values(lessons.org ?? {}).some((t) => t !== null) || lessons.project !== null || Object.values(lessons.agents).some((t) => t !== null);
    return any ? lessons : null;
  } catch (e) { lessonsFailed(e); return null; }
}

// gate: a start that already asked startGate() (drover start does, before its claim) passes the answer, so it is neither asked nor noticed twice.
export async function launch(task, runner, { worktree, reportTo, project, create, folder: chosen, note, gate: asked } = {}) {
  const label = task?.id ?? "Run";
  try {
    const owned = ownerError(loadProjects(), task?.project ?? project);
    if (owned) throw new Error(owned);
    const p = plan(loadConfig(), runner);
    if (p.error) throw new Error(p.error);
    if (worktree && !task) throw new Error("A worktree needs a task.");
    const boss = reportTo ? panes().find((x) => x.terminal === reportTo) : null;
    if (reportTo && !boss) throw new Error(`Coordinator ${reportTo} is not on screen.`);
    const gate = asked ?? await startGate(); // T-MWO2HEU32E4: before the work folder, the worktree and any terminal
    if (gate.error) throw new Error(gate.error);
    if (gate.warning && !asked) notify({ title: `${label}: started`, body: gate.warning, level: "info" }); // also with Report to Drover on: the Picker only reads r.error
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
    ctx.lessons = create ? null : await loadLessons(runProj, [p.leader.id, ...p.members.map((m) => m.id)]); // the one-shot card creator gets no block
    const pending = []; // Codex terminals whose session id is looked up after the run is saved
    const open = async (agent, prompt) => {
      const kind = agentKind(agent.command);
      let cmd = argv(agent.command), session = null, token = null;
      if (kind === "claude") { const id = newUuid(), flagged = withSessionFlag(cmd, id); if (flagged) { cmd = flagged; session = id; } } // a profile's own session/resume flag stays: id unknown
      else if (kind === "codex") { token = newUuid().replace(/-/g, ""); prompt = withMarker(prompt, token); }
      const cwd = wt && !terminals.length ? wt.path : folder; // the folder this terminal opens in; null = Herdr's default, not recorded
      const name = `${task ? task.id + " " : ""}${agent.role === "leader" ? agent.name : agent.role.split(/[.:(]/)[0].trim()}`.slice(0, 40);
      // Env file present: the wrapper runs the agent. A wrapper failure exits non-zero and the plain agent never starts.
      const args = ["--argv", JSON.stringify(launchArgv(agent.id, cmd, ENV_WRAPPER(), await hasAgentEnv(agent.id))), "--task", prompt];
      const out = wt && !terminals.length
        ? await herdr(["space.new", "--name", `${task.id} ${task.title}`.slice(0, 40), "--folder", wt.path, "--tab", name, ...args])
        : await herdr(["tab.new", "--name", name, ...(space ? ["--space", space] : []), ...(folder ? ["--folder", folder] : []), ...args]);
      if (out.space) space = out.space;
      terminals.push(terminalRecord(out.terminal, agent, Date.now(), undefined, { session, kind, cwd }));
      if (session) await labelSession(out.terminal, session);
      if (token) pending.push({ address: out.terminal, token });
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
    if (task) {
      // The squad that works the card becomes its assignee, unless the owner already chose one (read now: the card may have changed during the awaits above).
      const current = load().find((x) => x.id === task.id);
      save(update(load(), task.id, { agent: leader, run: run.id, column: "doing", claimedAt: null, ...(current && !current.assignee && runner ? { assignee: { kind: runner.kind, id: runner.id } } : {}) }));
    }
    if (pending.length && home()) void discoverSessions(run.id, pending); // after the run is saved; launch does not wait for it
    return gate.warning ? { ...run, warning: gate.warning } : run;
  } catch (e) {
    const error = String(e?.message ?? e);
    if (!reportTo) notify({ title: `${label} not started`, body: error, level: "error" });
    return { error };
  }
}

// ---- Resume a gone squad (T-MWLGPS2QJQL). Building blocks only: S2 composes them into the whole-squad flow.
// The run's worktree, again. Reuses a live one, recreates a gone one from the run's branch (never -b), refuses anything else with the reason.
// Git state is read from `worktree list --porcelain` (never from localized messages). No prune: only THIS path's stale registration is removed.
const git = (args, repo) => exec("git", args, { cwd: repo });
const isDir = async (p) => (await exec("test", ["-d", p]))?.code === 0;
function worktreeEntries(text) {
  return String(text ?? "").split(/\n\s*\n/).map((b) => {
    const e = {};
    for (const l of b.split("\n")) { if (l.startsWith("worktree ")) e.path = l.slice(9); else if (l.startsWith("branch ")) e.branch = l.slice(7); }
    return e;
  }).filter((e) => e.path);
}
// What is really at the path: a worktree whose root is that path, of the run's repo (same common git dir), on the run's branch.
// The registry says only that git knows the path; the folder may since have been replaced by anything.
async function verifyWorktree(path, branch, repo, registered) {
  const q = (cwd, args) => git(["rev-parse", "--path-format=absolute", ...args], cwd);
  const [top, common, mine, head] = await Promise.all([q(path, ["--show-toplevel"]), q(path, ["--git-common-dir"]), q(repo, ["--git-common-dir"]), git(["symbolic-ref", "--quiet", "HEAD"], path)]);
  const out = (r) => String(r?.stdout ?? "").trim();
  if (top?.code !== 0 || out(top) !== registered) throw new Error(`${path} is not the root of a worktree (something else is there now), so it was not reused`);
  if (common?.code !== 0 || mine?.code !== 0 || out(common) !== out(mine)) throw new Error(`${path} belongs to another repository than ${repo}, so it was not reused`);
  if (head?.code !== 0 || out(head) !== `refs/heads/${branch}`) throw new Error(`${path} is not on branch ${branch} (it has ${out(head).replace("refs/heads/", "") || "a detached HEAD"}), so it was not reused`);
}
export async function ensureWorktree(run) {
  const w = run.worktree;
  if (!w) { // no worktree on the run: reopen in the folder it recorded
    const t = (run.terminals ?? []).find((m) => m.role === "leader" && m.cwd) ?? (run.terminals ?? []).find((m) => m.cwd);
    if (!t?.cwd) throw new Error("this run recorded no folder to reopen in");
    if (!(await isDir(t.cwd))) throw new Error(`the folder ${t.cwd} is gone`);
    return { path: t.cwd, branch: null, repo: null, created: false };
  }
  const { repo, branch, path } = w, ref = `refs/heads/${branch}`;
  if (!(await isDir(repo))) throw new Error(`the repo ${repo} is gone`);
  const ls = await git(["worktree", "list", "--porcelain"], repo);
  if (ls?.code !== 0) throw new Error(`cannot read the worktrees of ${repo}`);
  const all = worktreeEntries(ls.stdout), here = all.find((e) => e.path === path), elsewhere = all.find((e) => e.branch === ref && e.path !== path);
  if (elsewhere) throw new Error(`branch ${branch} is checked out at ${elsewhere.path}`);
  const present = await isDir(path);
  if (here) {
    if (here.branch !== ref) throw new Error(`${path} is a worktree of another branch (${String(here.branch ?? "detached").replace("refs/heads/", "")}), not ${branch}`);
    if (present) { await verifyWorktree(path, branch, repo, here.path); return { path, branch, repo, created: false }; }
    const rm = await git(["worktree", "remove", "--force", path], repo); // drops only this missing path's registration
    if (rm?.code !== 0) throw new Error(`could not drop the stale registration of ${path}`);
  } else if (present) throw new Error(`${path} exists and is not a worktree of ${branch}`);
  if ((await git(["show-ref", "--verify", "--quiet", ref], repo))?.code !== 0) throw new Error(`branch ${branch} no longer exists in ${repo}`);
  const add = await git(["worktree", "add", path, branch], repo);
  if (add?.code !== 0) throw new Error(`git worktree add failed: ${String(add?.stderr ?? "").trim().split("\n").pop()}`);
  return { path, branch, repo, created: true };
}

// Durable attempt record, shared (drover.resumes[<old run id>]): written BEFORE the first open and updated with each opened address,
// so a crashed attempt can be recovered by hand (Recover) and found by its token. token rides in every first message.
export const RESUMES_KEY = "drover.resumes";
export const resumeSettle = { tries: 20, ms: 1000 }; // the barrier: polls of the live list (ms apart; the host runs the wait)
export const killSettle = { tries: 50, ms: 300 }; // 15 s: Codex takes seconds to exit after a kill
const resumes = () => { const r = shared(RESUMES_KEY); return r && typeof r === "object" && !Array.isArray(r) ? r : {}; };
// The lease: an attempt is alive while its heartbeat (renewed by its own work: every check, open, poll and park) is younger than this.
const staleAfter = () => claimTtl + 2 * resumeSettle.tries * resumeSettle.ms;
const beatOf = (a) => a?.heartbeat ?? a?.started ?? 0;
export const attemptOf = (runId) => resumes()[runId] ?? null;
export function beginAttempt(runId, taskId, now = Date.now()) {
  const cur = attemptOf(runId);
  if (cur) { // a record is never replaced on its own: a crashed attempt needs one manual Recover (it may still own terminals)
    return fresh(cur, now) ? { error: `${runId} is already being resumed` }
      : { error: `${runId} has an earlier resume attempt that stopped: it needs recovery (Recover, or drover resume ${runId} --recover)`, recoveryNeeded: true, recovery: cur };
  }
  const id = "A-" + newUuid().slice(0, 8);
  const a = { id, attemptIds: [id], token: newUuid().replace(/-/g, ""), card: taskId, started: now, heartbeat: now, opened: [] };
  setShared(RESUMES_KEY, { ...resumes(), [runId]: a });
  return a;
}
export function attemptOpened(runId, attemptId, address, now = Date.now()) {
  const cur = attemptOf(runId);
  if (!cur || cur.id !== attemptId || cur.opened.includes(address)) return false;
  setShared(RESUMES_KEY, { ...resumes(), [runId]: { ...cur, opened: [...cur.opened, address], launching: null, heartbeat: now } }); // the intent is resolved: the address is recorded
  return true;
}
export function endAttempt(runId, attemptId) {
  const cur = attemptOf(runId);
  if (!cur || cur.id !== attemptId) return false;
  const { [runId]: _gone, ...rest } = resumes();
  setShared(RESUMES_KEY, rest);
  return true;
}

// The card's claim, owned by one attempt: claim() plus a token. No await between the guard and this call.
export function claimForResume(taskId, attemptId) {
  const c = claim(load(), taskId, undefined, undefined, liveState().alive);
  if (c.error) return c;
  const t = update(c.tasks, taskId, { claimToken: attemptId });
  if (t.error) return t;
  setShared(KEY, t.tasks);
  return { prev: c.prev };
}
export const holdsClaim = (taskId, attemptId) => { const t = load().find((x) => x.id === taskId); return !!t && t.agent === CLAIMING && t.claimToken === attemptId; };
// Only the attempt that holds the claim releases it: a late attempt never clears a replacement claim.
export function releaseResumeClaim(taskId, prev, attemptId) {
  if (!holdsClaim(taskId, attemptId)) return false;
  setShared(KEY, clearClaimToken(release(load(), taskId, prev).tasks, taskId));
  return true;
}

// Codex may write a NEW rollout when it resumes. The effective `session` is replaced only while it still equals the id this attempt resumed (sourceSession),
// so history, another terminal or a later change is never overwritten. A pruned run is not brought back.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function patchSourceSession(runId, address, source, session) {
  if (!UUID_RE.test(String(session))) return false;
  const runs = loadRuns();
  const mine = (r) => r.id === runId && r.terminals?.some((x) => x.address === address);
  const t = runs.find(mine)?.terminals.find((x) => x.address === address);
  if (!t || t.sourceSession !== source || t.session !== source) return false;
  setShared(RUNS_KEY, runs.map((r) => (!mine(r) ? r : { ...r, terminals: r.terminals.map((x) => (x.address === address ? { ...x, session } : x)) })));
  return true;
}

// The live list as evidence. An EMPTY list is the host not being ready (observeEnded treats it so), never "everything exited":
// known=false then, and nothing may be concluded from it.
const liveSnapshot = () => { const { alive } = liveState(); return { alive, known: alive.size > 0 }; };
// Readiness of one reopened terminal: an AGENT status (idle/working/done, not a bare shell) on 2 reads in a row, then the first message delivered,
// then the status read AGAIN (the terminal may have exited or blocked during the delivery read). blocked, gone or no answer within the bound = failed.
// Nothing is ever typed into the terminal (a dialog is the person's).
const READY = new Set(["idle", "working", "done"]);
const sleep = (ms) => exec("sleep", [String(ms / 1000)]); // no setTimeout in a mod: the host runs the wait
async function delivered(address, token) {
  try {
    const r = await hc(["get", address, "--json"]);
    if (r?.code !== 0) return false;
    const rec = JSON.parse(r.stdout);
    if (rec?.first_message && typeof rec.first_message === "object") return rec.first_message.sent === true; // the host tracks it
    return (rec?.argv ?? []).some((a) => String(a).includes(resumeToken(token))); // the task rides in argv: the process got it at start
  } catch { return false; }
}
const statusNow = (address) => { const { live, alive } = liveState(); return memberStatus(address, live, alive); };
// One terminal's status from a source that cannot lag: the cached list when it shows the terminal, else the terminal's own record (hc get).
// A terminal opened a moment ago is not on the cached list yet: that is UNKNOWN, never "gone". "gone" only when the host says it is no longer live.
async function freshStatus(address) {
  const { live, alive } = liveState();
  if (alive.has(address)) return live.get(address) ?? "running";
  try {
    const r = await hc(["get", address, "--json"]);
    if (r?.code !== 0) return "unknown";
    const rec = JSON.parse(r.stdout);
    if (typeof rec?.state !== "string") return "unknown";
    if (rec.state !== "live") return "gone";
    return typeof rec.status === "string" && rec.status ? rec.status : "running";
  } catch { return "unknown"; }
}
// Codex's Hooks trust screen ("plugin contents changed; hook approval required"): Herdr gives such a terminal no agent status, so the barrier would only time out.
// The message AND an active control of the screen are both needed: the bare phrase may be quoted in a resumed transcript. Pure; case and spacing do not matter.
export function trustScreen(text) {
  if (typeof text !== "string") return false;
  const t = text.toLowerCase().replace(/\s+/g, " ");
  const message = t.includes("hook approval required") || /\bhooks? needs? review\b/.test(t);
  const control = t.includes("esc close") || (t.includes("esc back") && t.includes("t trust"));
  return message && control;
}
export const TRUST_ERROR = "Codex is waiting on its hooks trust screen (hook approval required). Trust the hooks once in a normal Codex session, then resume again";
// The terminal's own screen, read-only (no history, no keys). A failed or unreadable read is no evidence.
async function onTrustScreen(address) {
  try {
    const r = await hc(["read", address, "--lines", "0"]);
    return r?.code === 0 && trustScreen(String(r.stdout ?? ""));
  } catch { return false; }
}
async function barrier(address, token, beat) {
  let ok = 0, sent = false;
  for (let i = 0; i < resumeSettle.tries; i++) {
    beat?.(); // the lease: this attempt is still working
    const st = await freshStatus(address);
    if (st === "gone") return { error: "the terminal exited" };
    if (st === "blocked") return { error: "the terminal is blocked on a dialog (answer it by hand)" };
    if (!READY.has(st) && await onTrustScreen(address)) return { error: TRUST_ERROR, dialog: true }; // no agent status: is it the trust screen?
    ok = READY.has(st) ? ok + 1 : 0;
    if (ok >= 2) {
      sent = await delivered(address, token);
      const again = await freshStatus(address); // a fresh read at the return point, after the await
      if (again === "gone") return { error: "the terminal exited while its first message was being checked" };
      if (again === "blocked") return { error: "the terminal is blocked on a dialog (answer it by hand)" };
      if (sent && READY.has(again)) return { ok: true };
      if (!READY.has(again)) ok = 0;
    }
    if (i < resumeSettle.tries - 1) await sleep(resumeSettle.ms);
  }
  return { error: ok >= 2 || sent ? "its first message was not delivered" : "it did not report an agent status (not ready)" };
}
// terminal.kill, then PROOF it is gone: the host's own record of THAT terminal (hc get) says it is no longer live.
// The cached list proves nothing (it lags in both directions), and no answer is not an answer. false = unknown: the caller fails closed (never a second session of one id).
async function hostSaysDead(address) {
  try {
    const r = await hc(["get", address, "--json"]);
    if (r?.code !== 0) return false; // no answer is not an answer
    const st = JSON.parse(r.stdout)?.state;
    return typeof st === "string" && st !== "live";
  } catch { return false; }
}
async function killConfirmed(address) {
  try { await herdr(["terminal.kill", "--terminal", address]); } catch { /* the proof below decides */ }
  for (let i = 0; i < killSettle.tries; i++) {
    if (await hostSaysDead(address)) return true;
    if (i < killSettle.tries - 1) await sleep(killSettle.ms);
  }
  return false;
}

// Reopens ONE terminal of a gone run: the agent's current command first, the run's frozen command if that fails (same session, same resume flag only).
// o: { cwd, prompt (carries the attempt token), token, name, space | spaceName (open a new space),
//      check(): SYNC, returns a reason (or throws) to stop: asked right before every open and after the barrier,
//      intent(): SYNC, called right before each open (persist the launch intent: an open whose answer is lost is then recoverable by token),
//      beat(): SYNC, renews the attempt's lease on each poll,
//      onOpen(address): SYNC, record ownership; returning false = rejected (the terminal is killed and the resume stops) }.
// A failed attempt is killed and confirmed gone before the next one; an unconfirmed kill stops everything (failClosed): never 2 sessions of one id.
// Returns { address, space, source, model, argv } or { error, killed, cancelled?, failClosed? }.
export async function resumeTerminal(run, terminal, o) {
  if (!o.gated) { const g = await startGate(); if (g.error) return { error: g.error, killed: [] }; } // a squad resume checks once for all its terminals
  const c = resumeCandidates(loadConfig(), run, terminal);
  if (c.error) return { error: c.error, killed: [] };
  const killed = [], errors = [], who = `${terminal.name ?? terminal.agent}`;
  const stopReason = () => { try { return o.check?.() || null; } catch (e) { return `the check failed: ${String(e?.message ?? e)}`; } };
  const undo = async (address, why) => { // a terminal we opened must not outlive a stop
    if (!(await killConfirmed(address))) return { error: `${who}: ${why}; terminal ${address} may still be alive (kill not confirmed)`, killed, cancelled: true, failClosed: true, address };
    killed.push(address);
    return { error: `${who}: ${why}`, killed, cancelled: true };
  };
  for (const cand of c.candidates) {
    let out;
    try {
      const args = ["--argv", JSON.stringify(launchArgv(cand.agent.id, cand.argv, ENV_WRAPPER(), await hasAgentEnv(cand.agent.id))), "--task", o.prompt];
      const why = stopReason(); // the last synchronous look before the irreversible open
      if (why) return { error: `${who}: ${why}`, killed, cancelled: true };
      o.intent?.(); // written before the open is issued
      out = o.spaceName
        ? await herdr(["space.new", "--name", o.spaceName, ...(o.cwd ? ["--folder", o.cwd] : []), "--tab", o.name, ...args])
        : await herdr(["tab.new", "--name", o.name, ...(o.space ? ["--space", o.space] : []), ...(o.cwd ? ["--folder", o.cwd] : []), ...args]);
    } catch (e) { errors.push(`${cand.source}: ${String(e?.message ?? e)}`); continue; } // nothing opened
    const address = out.terminal;
    if (o.onOpen?.(address) === false) return undo(address, "its ownership could not be recorded (the attempt was replaced)"); // before any await after the open
    const r = await barrier(address, o.token, o.beat);
    if (r.ok) {
      const why = stopReason();
      if (why) return undo(address, why);
      return { address, space: out.space ?? o.space ?? null, source: cand.source, model: cand.model, argv: cand.argv };
    }
    errors.push(`${cand.source}: ${r.error}`);
    const why = stopReason(); // a stop during the barrier: no fallback
    if (!(await killConfirmed(address))) return { error: `${who}: terminal ${address} may still be alive (kill not confirmed), so no second one was opened; ${errors.join("; ")}`, killed, failClosed: true, address };
    killed.push(address);
    if (why) return { error: `${who}: ${why}`, killed, cancelled: true };
    if (r.dialog) break; // the frozen command would stop at the same screen
  }
  return { error: `${who} (${terminal.address}) did not resume: ${errors.join("; ")}`, killed };
}

// ---- Resume a whole gone squad (T-MWLGPS2QJQL S2). Composes the building blocks above.
const resuming = new Set(); // run ids resumed by THIS runtime (the shared drover.resumes record covers the other mods)
const fresh = (a, now = Date.now()) => !!a && now - beatOf(a) <= staleAfter();
// Runs with an attempt on record (live or crashed), from any mod (the durable record), plus this runtime's own.
const inFlight = () => new Set([...resuming, ...Object.keys(resumes())]); // a lapsed record counts too: it needs a manual Recover
// Can the Resume button be offered for this run now? Same guard as the real thing; an unreadable live list says no.
export function canResume(runId) {
  const { alive, known } = liveSnapshot();
  return known && resumeGuard({ tasks: load(), runs: loadRuns(), alive, resuming: inFlight() }, runId).ok === true;
}
// Stop for an attempt: the durable flag is read by the attempt's own checks before its next open/park/publish.
export function cancelResume(runId) {
  const cur = attemptOf(runId);
  if (!cur) return false;
  setShared(RESUMES_KEY, { ...resumes(), [runId]: { ...cur, cancel: true } });
  return true;
}
const noteAttempt = (runId, id, patch) => { const cur = attemptOf(runId); if (cur?.id === id) setShared(RESUMES_KEY, { ...resumes(), [runId]: { ...cur, ...patch } }); };
// A resume keeps the claim alive: its age counts from the last open, so a slow barrier never lets the claim expire under it.
function refreshClaim(taskId, attemptId) {
  if (!holdsClaim(taskId, attemptId)) return;
  const r = update(load(), taskId, { claimedAt: Date.now() });
  if (!r.error) setShared(KEY, r.tasks);
}
const short = (role) => String(role ?? "").split(/[.:(]/)[0].trim();

// Reopens a gone run's whole squad: members first (each with its barrier), then the leader whose first message holds the new address
// map and what changed, then the members are parked. The new run is saved only at the very end; anything failing before that kills
// ONLY this attempt's terminals, releases the claim (only with this attempt's token) and leaves the old run untouched.
// ref: a run id (R-…) or a card id (T-…, its newest run). Returns { run } or { error }.
export async function resumeSquad(ref, { quiet = false } = {}) {
  ref = String(ref ?? "");
  const gate = await startGate(); // reopening a gone squad starts new processes: held like any start, before the claim (T-MWO2HEU32E4)
  const all = loadRuns();
  const run = /^T-/.test(ref) ? all.filter((r) => r.task === ref).sort((a, b) => (b.started ?? 0) - (a.started ?? 0))[0] : all.find((r) => r.id === ref);
  const refuse = (error) => { if (!quiet) notify({ title: `${run?.task ?? ref} not resumed`, body: error, level: "error" }); return { error }; }; // a refused click must say why (the CLI prints it itself)
  if (!run) return refuse(`no run for ${ref}`);
  if (gate.error) return refuse(gate.error);
  if (gate.warning && !quiet) notify({ title: `${run.task ?? ref} resumed`, body: gate.warning, level: "info" });
  // ---- no await from here to the claim: a second click, the CLI and another mod all see the claim and the attempt record
  if (!liveSnapshot().known) return refuse("Herdr's terminal list is not ready: try again in a moment");
  const g = resumeGuard({ tasks: load(), runs: all, alive: liveState().alive, resuming: inFlight() }, run.id);
  if (g.error) return refuse(g.error);
  const task = g.task;
  const owned = ownerError(loadProjects(), task.project);
  if (owned) return refuse(owned);
  const a = beginAttempt(run.id, task.id);
  if (a.error) return refuse(a.error);
  const c = claimForResume(task.id, a.id);
  if (c.error) { endAttempt(run.id, a.id); return refuse(c.error); }
  noteAttempt(run.id, a.id, { prev: c.prev });
  resuming.add(run.id);
  // ----
  const opened = [], dead = new Set(), pending = [], newT = [];
  const known = new Map(); // address -> the last FRESH status (hc get); stop() is synchronous, so it reads this when the cached list does not show a new terminal yet
  const refreshNew = async () => { for (const t of newT) known.set(t.address, await freshStatus(t.address)); };
  let lastBeat = 0;
  const beat = (force = false) => { const t = Date.now(); if (force || t - lastBeat >= 5000) { lastBeat = t; noteAttempt(run.id, a.id, { heartbeat: t }); } };
  // Synchronous: asked before every open and after every barrier. A reason = stop (cancel, replaced attempt or claim, the card Done/archived/deleted).
  const stop = () => {
    const rec = attemptOf(run.id);
    if (!rec || rec.id !== a.id) return "the attempt was replaced";
    if (rec.cancel) return "cancelled: stopped by the person";
    const gg = resumeGuard({ tasks: load(), runs: loadRuns(), alive: liveState().alive, resuming: new Set(), attempt: a.id }, run.id);
    if (gg.error) return gg.error;
    if (!holdsClaim(task.id, a.id)) return "the claim on the card was replaced";
    const cur = load().find((x) => x.id === task.id); // the card must still sit where the claim put it: any move by the owner aborts (their column is kept)
    if (cur.column !== "doing" || cur.project !== task.project) return `the card was moved to ${columnName(cur.column)}`;
    if (newT.length) { // every terminal this attempt already opened must still be there and not stuck on a dialog; an unknown list is NOT evidence
      if (!liveSnapshot().known) return "Herdr's terminal list is not ready: could not confirm the new terminals are up";
      const { live, alive } = liveState();
      for (const t of newT) {
        const st = alive.has(t.address) ? memberStatus(t.address, live, alive) : known.get(t.address) ?? "unknown"; // not listed (yet) = what the terminal itself last said
        if (st === "gone") return `${t.name} (${t.address}) exited before the squad was complete`;
        if (st === "blocked") return `${t.name} (${t.address}) is blocked on a dialog (answer it by hand)`;
      }
    }
    refreshClaim(task.id, a.id); beat(true);
    return null;
  };
  const onOpen = (address) => { opened.push(address); const ok = attemptOpened(run.id, a.id, address); if (ok) refreshClaim(task.id, a.id); return ok; };
  const intent = () => noteAttempt(run.id, a.id, { launching: Date.now(), heartbeat: Date.now() });
  const must = () => { const why = stop(); if (why) throw new Error(why); };
  // The final check. An unknown (empty) list is NOT a pass: it is retried a bounded number of times, then the resume fails.
  const verifyGroup = async () => {
    for (let i = 0; i < resumeSettle.tries; i++) {
      beat(true);
      if (liveSnapshot().known) {
        let unsure = false;
        for (const t of newT) {
          const st = await freshStatus(t.address);
          known.set(t.address, st);
          if (st === "gone") throw new Error(`${t.name} (${t.address}) exited before the squad was complete`);
          if (st === "blocked") throw new Error(`${t.name} (${t.address}) is blocked on a dialog (answer it by hand)`);
          if (st === "unknown") unsure = true;
        }
        if (!unsure) return;
      }
      if (i < resumeSettle.tries - 1) await sleep(resumeSettle.ms);
    }
    throw new Error("Herdr's terminal list is not ready: could not confirm the squad is up");
  };
  const use = (r) => { for (const k of r.killed ?? []) dead.add(k); if (r.error) throw new Error(r.error); return r; };
  const rollback = async (why) => {
    const stuck = [];
    for (const addr of opened) if (!dead.has(addr)) { if (await killConfirmed(addr)) dead.add(addr); else stuck.push(addr); }
    if (attemptOf(run.id)?.id === a.id && attemptOf(run.id).launching) { // an open whose answer never came back may have spawned a terminal: find it by token
      const snap = liveSnapshot();
      if (!snap.known || (await sweepOwned(a.token, snap.alive, snap.alive)).stuck) stuck.push("a terminal of an unfinished open");
    }
    resuming.delete(run.id);
    if (stuck.length) return `${why}; ${stuck.join(", ")} may still be alive: the claim stays until you press Recover`; // record + claim kept for a manual Recover
    releaseResumeClaim(task.id, c.prev, a.id);
    endAttempt(run.id, a.id);
    return why;
  };
  try {
    const leaderOld = run.terminals.find((t) => t.role === "leader");
    if (!leaderOld) throw new Error(`${run.id} has no leader recorded`);
    const wt = await ensureWorktree(run);
    must();
    const folderOf = (t) => (run.worktree ? wt.path : t.cwd ?? wt.path);
    const changes = [];
    if (wt.created) changes.push(`the worktree was recreated from branch ${wt.branch} at ${wt.path}`);
    let space = null;
    const map = [];
    const open = async (t, kind) => {
      let prompt = resumePrompt(kind, { task, role: t.role, token: a.token, map, changes, leader: { old: leaderOld.address } });
      let marker = null;
      if (t.kind === "codex") { marker = newUuid().replace(/-/g, ""); prompt = `${prompt}\n\n${sessionMarker(marker)}`; } // lets discovery find a new rollout
      const name = `${task.id} ${t.role === "leader" ? t.name : short(t.role)}`.slice(0, 40);
      const r = use(await resumeTerminal(run, t, { cwd: folderOf(t), prompt, token: a.token, name, ...(space ? { space } : { spaceName: `${task.id} ${task.title}`.slice(0, 40) }), check: stop, onOpen, intent, beat, gated: true }));
      if (r.space) space = r.space;
      if (t.kind === "claude" && t.session) await labelSession(r.address, t.session); // Reader reads this label; Codex is labeled by discovery below
      if (marker) pending.push({ address: r.address, token: marker, source: t.session });
      const rec = resumedTerminal(r.address, t, { model: r.model, started: Date.now(), cwd: folderOf(t) });
      if (r.source === "frozen") changes.push(`${t.name} could not start with its current settings, so it runs its saved command`);
      if (t.model && r.model && t.model !== r.model) changes.push(`${t.name} now runs ${r.model} (it ran ${t.model})`);
      return { rec, address: r.address };
    };
    for (const t of run.terminals.filter((x) => x !== leaderOld)) {
      const m = await open(t, "member");
      newT.push(m.rec); await refreshNew(); map.push({ role: t.role, name: t.name, old: t.address, address: m.address });
    }
    const lead = await open(leaderOld, "leader");
    newT.push(lead.rec); await refreshNew();
    must();
    // Floating workers, as launch() does: park each member once the leader's tab is open. Recorded only when Herdr confirms the pane is gone.
    const failed = [];
    for (const t of newT) {
      if (t.role === "leader") continue;
      try { if (await parkConfirmed(t.address)) t.parked = true; else failed.push(t.address); } catch { failed.push(t.address); }
      beat();
    }
    if (failed.length) notify({ title: `${task.id}: workers kept their tabs`, body: `Could not park ${failed.join(", ")}.`, level: "error" });
    await verifyGroup(); // after the last await: the evidence is a known list that shows every new terminal up
    must();
    // ---- the commit: no await. The new run, the old run's link and the card in one go.
    // The run first (bound to this attempt), then the card: a crash between them is adopted by a manual Recover, never killed.
    const nrun = { ...resumedRun(run, { id: "R-" + Date.now().toString(36).toUpperCase(), started: Date.now(), space, terminals: newT,
      worktree: run.worktree ? { ...run.worktree, path: wt.path } : null }), resumeAttempt: a.id };
    const u = update(load(), task.id, { agent: lead.address, run: nrun.id, column: "doing", claimedAt: null });
    if (u.error) throw new Error(u.error);
    setShared(RUNS_KEY, pruneRuns(linkResumed(loadRuns(), nrun), keptRuns()));
    setShared(KEY, clearClaimToken(u.tasks, task.id));
    endAttempt(run.id, a.id);
    resuming.delete(run.id);
    if (pending.length && home()) void discoverSessions(nrun.id, pending);
    return { run: nrun, ...(gate.warning ? { warning: gate.warning } : {}) };
  } catch (e) {
    const error = await rollback(String(e?.message ?? e));
    if (!quiet || /blocked/i.test(error)) notify({ title: `${task.id} not resumed`, body: error, level: "error" });
    return { error };
  }
}

// The inbox op behind `drover resume <R-…|T-…> [--recover|--cancel]`.
async function resumeOp(cmd) {
  const ref = String(cmd.ref ?? "");
  if (!/^[RT]-[A-Z0-9]+$/.test(ref)) return `error: give a run id (R-…) or a card id (T-…)`;
  if (cmd.recover === true && cmd.cancel === true) return "error: --recover and --cancel are one or the other";
  const reply = (r) => (r.error ? `error: ${r.error}` : `ok: ${r.ok}`);
  if (cmd.recover === true) return reply(await recoverResume(ref, { quiet: true }));
  if (cmd.cancel === true) {
    const runId = asRunId(ref);
    if (runId && resumeState(runId) === "needs-recovery") return reply(await recoverResume(ref, { adopt: false, quiet: true })); // a crashed attempt: abandon it
    return runId && cancelResume(runId) ? `ok: cancel requested for ${runId}` : `error: no resume in progress for ${ref}`;
  }
  const r = await resumeSquad(ref, { quiet: true });
  if (r.error) return `error: ${r.error}`;
  const lead = r.run.terminals[r.run.terminals.length - 1];
  return `ok: ${r.run.id} leader ${lead.address} (${lead.name})` + r.run.terminals.slice(0, -1).map((m) => ` · ${short(m.role)} ${m.address}`).join("") + (r.run.worktree ? ` · worktree ${r.run.worktree.path} on ${r.run.worktree.branch}` : "") + (r.warning ? ` · warning: ${r.warning}` : "");
}

// Who started this terminal? "owned" = its argv carries the attempt's token, "foreign" = it does not, "unknown" = the read failed or is malformed.
// Unknown is never treated as foreign: recovery then keeps the record and the claim.
async function ownership(address, token) {
  try {
    const r = await hc(["get", address, "--json"]);
    if (r?.code !== 0) return "unknown";
    const argv = JSON.parse(r.stdout)?.argv;
    if (!Array.isArray(argv)) return "unknown";
    return argv.some((x) => String(x).includes(resumeToken(token))) ? "owned" : "foreign";
  } catch { return "unknown"; }
}
// Kills what an attempt owns among `addrs` (alive ones only). { stuck: true } when one is unknown or a kill is not confirmed;
// { lost: true } when `fence()` says this caller no longer owns the attempt (re-asked after every await, before every kill).
async function sweepOwned(token, addrs, alive, fence = () => true) {
  let stuck = false;
  const killed = [];
  for (const addr of addrs) {
    if (!alive.has(addr)) continue;
    if (!fence()) return { lost: true, killed };
    const own = await ownership(addr, token);
    if (!fence()) return { lost: true, killed };
    if (own === "unknown") { stuck = true; continue; }
    if (own === "owned") { if (await killConfirmed(addr)) killed.push(addr); else stuck = true; }
  }
  return { stuck, killed };
}

// ---- Recovery is MANUAL (T-MWLGPS2QJQL, option B): nothing here runs on a tick. A crashed attempt keeps its claim and its record until the
// person presses Recover (or Cancel), or runs `drover resume <R-…> --recover|--cancel`. It is fenced: the takeover writes a new attempt id
// into the record and the claim (so the old attempt, if it is somehow still running, stops at its next check and can neither publish nor
// release), and every continuation re-asks that it still owns both.
//   needs-recovery = a record whose heartbeat lapsed and no live resume in this window; live = beating (or running here); recovering = a Recover is on it.
export function resumeState(runId) {
  const rec = attemptOf(runId);
  if (!rec) return "none";
  if (rec.recovering && fresh(rec)) return "recovering";
  return resuming.has(runId) || fresh(rec) ? "live" : "needs-recovery";
}
const asRunId = (ref) => (/^T-/.test(ref) ? Object.entries(resumes()).find(([, a]) => a.card === ref)?.[0] : attemptOf(ref) ? ref : undefined);
// adopt: finish a squad the attempt had already published (when the card still allows it); false (Cancel) always cleans the published squad up.
export async function recoverResume(ref, { adopt = true, quiet = false } = {}) {
  ref = String(ref ?? "");
  const runId = asRunId(ref), rec = runId ? attemptOf(runId) : null;
  const done = (r) => { if (!quiet) notify({ title: r.error ? `${ref} not recovered` : `${ref} recovered`, body: r.error ?? r.ok, level: r.error ? "error" : "info" }); return r; };
  if (!rec) return { error: `no resume to recover for ${ref}` };
  const st = resumeState(runId);
  if (st === "live") return done({ error: resuming.has(runId) ? `${runId} is resuming in this window: cancel it instead` : `${runId} is still running (its heartbeat is recent): cancel it, or recover after it stops` });
  if (st === "recovering") return done({ error: `${runId} is already being recovered` });
  // ---- no await up to here: the takeover (the fence). A second click, another mod copy and the old attempt all see the new id.
  const rid = "A-" + newUuid().slice(0, 8), cardId = rec.card, claimHeld = holdsClaim(cardId, rec.id);
  setShared(RESUMES_KEY, { ...resumes(), [runId]: { ...rec, id: rid, attemptIds: [...(rec.attemptIds ?? [rec.id]), rid], recovering: true, heartbeat: Date.now() } });
  if (claimHeld) { const u = update(load(), cardId, { claimToken: rid }); if (!u.error) setShared(KEY, u.tasks); }
  const mine = () => attemptOf(runId)?.id === rid && (!claimHeld || holdsClaim(cardId, rid));
  const giveBack = () => { if (attemptOf(runId)?.id === rid) noteAttempt(runId, rid, { recovering: null, heartbeat: 0 }); }; // can be tried again at once
  try {
    const snap = liveSnapshot();
    if (!snap.known) { giveBack(); return done({ error: "Herdr's terminal list is not ready: nothing was changed, try again" }); }
    const ids = rec.attemptIds ?? [rec.id];
    const pub = loadRuns().find((r) => r.resumedFrom === runId && ids.includes(r.resumeAttempt));
    const t = load().find((x) => x.id === cardId);
    if (adopt && pub && t?.run === pub.id) { endAttempt(runId, rid); return done({ ok: `${pub.id} was already complete; the attempt record is closed` }); } // both writes landed
    // Adoption is the same commit as a normal resume, so it asks the same questions now: the owner's move, Done, archive or delete win.
    if (adopt && pub && t && !t.archived && t.column === "doing" && claimHeld && holdsClaim(cardId, rid) && (t.project ?? null) === (pub.project ?? null)) {
      const leader = pub.terminals[pub.terminals.length - 1]?.address ?? null;
      const u = update(load(), cardId, { agent: leader, run: pub.id, column: "doing", claimedAt: null });
      if (u.error) { giveBack(); return done({ error: u.error }); }
      setShared(KEY, clearClaimToken(u.tasks, cardId));
      endAttempt(runId, rid);
      return done({ ok: `adopted ${pub.id} (leader ${leader})` });
    }
    // Not adopting: clean up. What this attempt owns is found by its token: the recorded terminals, the published squad (if any) and,
    // when an open was in flight, every live terminal that carries the token.
    const addrs = new Set([...(rec.opened ?? []), ...(pub?.terminals ?? []).map((x) => x.address)]);
    if (rec.launching) for (const x of snap.alive) addrs.add(x);
    const sw = await sweepOwned(rec.token, addrs, snap.alive, mine);
    if (sw.lost) return done({ error: "another window took this recovery over: nothing more was done here" });
    if (sw.stuck) { giveBack(); return done({ error: "could not tell whose a terminal is, or could not confirm a kill: nothing was freed, try again" }); }
    if (!mine()) return done({ error: "another window took this recovery over: nothing more was done here" });
    if (pub) setShared(RUNS_KEY, loadRuns().filter((x) => x.id !== pub.id).map((x) => { if (x.id !== runId) return x; const { resumedBy: _r, ...rest } = x; return rest; }));
    if (claimHeld) releaseResumeClaim(cardId, rec.prev ?? { column: "todo" }, rid); // the owner's column is kept when they moved, finished or archived the card
    else if (pub) { // both publish writes had landed: undo only what the published squad set on the card, and only while the card still points at it
      const cur = load().find((x) => x.id === cardId), lead = pub.terminals[pub.terminals.length - 1]?.address;
      // Only the squad's own state: still on its run, and its leader or nobody is the agent. A CLAIMING card is a newer launch in flight (claim() keeps the old run id until it saves): never touched.
      if (cur && cur.run === pub.id && cur.agent !== CLAIMING && (cur.agent == null || cur.agent === lead)) {
        const u = update(load(), cardId, { run: runId, ...(cur.agent === lead ? { agent: null } : {}), ...(cur.column === "doing" && !cur.archived ? { column: rec.prev?.column ?? "todo" } : {}) });
        if (!u.error) setShared(KEY, u.tasks);
      }
    }
    endAttempt(runId, rid);
    const note = rec.launching && !sw.killed.length ? " An open was in flight when it stopped and no terminal carrying its token was found: if one appears later, close it by hand." : "";
    return done({ ok: `${pub ? `the published squad ${pub.id} was cleaned up; ` : ""}${sw.killed.length ? `killed ${sw.killed.join(", ")}; ` : ""}${claimHeld ? `released ${cardId}` : "record closed"}.${note}` });
  } catch (e) { giveBack(); return done({ error: String(e?.message ?? e) }); }
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

// ---- Share (Export / Import dialogs). The facts the pure core needs, read here: it has no fs.
// Local soul hashes: sha-256 of souls/<name>.md + souls/_herd.md as installed. A soul file that is absent or unreadable is left out
// (the core then treats the name as "not here"). Without _herd.md nothing can be hashed.
export async function localSoulHashes(names) {
  const out = {};
  let herd;
  try { herd = await readTextFile(`${SOULS()}/_herd.md`); } catch (e) { logFailure("soul read", e); return out; }
  if (herd == null) return out;
  for (const n of names) {
    if (!/^[a-z0-9-]{1,64}$/.test(String(n))) continue;
    try { const t = await readTextFile(`${SOULS()}/${n}.md`); if (t != null) out[n] = soulHash(t, herd); } catch (e) { logFailure("soul read", e); }
  }
  return out;
}

// The agent ids (of the given list) that have an env file: a Set, or { error } when any read fails (never treated as absent).
// Only existence is looked at: the content is dropped at once.
export async function envIdsFor(ids) {
  const found = new Set();
  const list = [...new Set(ids)].filter(validId);
  try {
    for (let i = 0; i < list.length; i += 25) {
      const chunk = list.slice(i, i + 25);
      const got = await Promise.all(chunk.map(async (id) => (await readTextFile(envPath(id))) != null));
      chunk.forEach((id, n) => { if (got[n]) found.add(id); });
    }
  } catch (e) { logFailure("env check", e); return { error: reasonCode(e) }; }
  return found;
}

// Exports go to one fixed folder (the runtime has no save dialog). Made 0700 by drover-workfolder, below the config root.
export const exportsDir = () => `${WORKFOLDER_ROOT()}/exports`;
export async function readImportFile(path) {
  const p = String(path ?? "").trim();
  if (!p) return { error: "Type the path of a file" };
  if (!p.startsWith("/") && !p.startsWith("~/")) return { error: "Use an absolute path (or one that starts with ~/)" };
  try {
    const text = await readTextFile(p.startsWith("~/") ? `${home()}${p.slice(1)}` : p);
    return text == null ? { error: "No such file" } : { text };
  } catch (e) { logFailure("import read", e); return { error: `Cannot read the file (${reasonCode(e)})` }; }
}
// { path } or { error }. A same-day export is replaced (writeTextFile checks it still holds what was read).
export async function saveExport(now, text) {
  const dir = exportsDir(), path = `${dir}/${exportName(now)}`;
  try { await ensureWorkFolder({ mode: "global", path: dir }); } catch (e) { return { error: String(e?.message ?? e).slice(0, 200) }; }
  try {
    const before = await readTextFile(path);
    await writeTextFile(path, text, before);
  } catch (e) { logFailure("export write", e); return { error: `Could not save the export (${reasonCode(e)})` }; }
  return { path };
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

// ---- agents export / import over the inbox (protocol 4, T-MWJHXZ6Q72Q). The CLI only carries text: validation, secret scan, clash rules and the
// apply all run here, in herd-export.js. Only the safe defaults are reachable (add new, skip identical, keep mine); copy, overwrite and the
// acknowledgements are UI-only. A confirm names a nonce, kept in shared state, so a re-delivered request answers `already applied`.
const NONCE_KEY = "drover.agents-import-seen";
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SAFE_ACTIONS = ["add", "skip", "keep"];

// The soul hashes of this machine: { localSouls } or { error }. Export needs only these (it never opens an environment file).
async function soulFacts() {
  const dir = SOULS(), localSouls = {};
  try {
    const herd = await fs.readFile(`${dir}/_herd.md`, "utf8");
    for (const f of await fs.readdir(dir)) {
      const m = /^([a-z0-9-]{1,64})\.md$/.exec(f);
      if (m) localSouls[m[1]] = HE.soulHash(await fs.readFile(`${dir}/${f}`, "utf8"), herd);
    }
  } catch (e) { logFailure("soul read", e); return { error: `Cannot read the soul files (${reasonCode(e)})` }; }
  return { localSouls };
}

// Import facts: the soul hashes and which of the ids have an environment file. { ctx } or { error }. A failed check is an error,
// never "absent". The message carries no id: the ids of a request are not scanned yet.
async function importFacts(ids) {
  const s = await soulFacts();
  if (s.error) return s;
  const envIds = new Set();
  try { for (const id of ids) if (await hasAgentEnv(id)) envIds.add(id); }
  catch (e) { return { error: `Cannot check the agent environment files (${reasonCode(e)})` }; }
  return { ctx: { localSouls: s.localSouls, envIds, supported: HE.VERSION, home: home() } };
}

// Every id the core may ask about: the ones in this config and the valid ids of the file (when it parses).
function idsFor(text) {
  const ids = new Set(loadConfig().agents.map((a) => a.id));
  try {
    const d = JSON.parse(text);
    for (const a of Array.isArray(d?.agents) ? d.agents : []) if (typeof a?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(a.id)) ids.add(a.id);
  } catch {}
  return ids;
}

// A request the CLI could not have made: any choice other than the safe actions, any acknowledgement.
function unsafeChoices(choices) {
  if (choices == null) return false;
  if (typeof choices !== "object" || Array.isArray(choices)) return true;
  return Object.values(choices).some((c) => !c || typeof c !== "object" || Object.keys(c).some((k) => k !== "action") || !SAFE_ACTIONS.includes(c.action));
}

// Fixed words per warning code: a warning's own text may carry a soul name or a program name of the file, which no scan has seen.
const WARN = {
  "soul-differs": "your soul file of that name differs from the sender's; the agent will use yours",
  "soul-dropped": "no such local soul: the agent imports without a soul and only its instructions apply",
  "needs-env": "environment variables must be re-added after the import",
  "home-path": "a home folder path appears in this text",
  "unknown-harness": "the program is not claude, codex or pi: it will run on this machine when the agent starts",
  "command-changed": "the command of an existing agent changes",
  "instructions-changed": "the instructions of an existing agent change",
  "name-clash": "another agent has the same name",
};
const rowId = (r) => r.id || `#${r.key.split("#")[1] ?? "?"}`;
// The preview: every action, the warnings, and for each row that is not blocked the full text that would run or be read.
function planText(p) {
  const lines = [];
  for (const r of p.rows) {
    if (r.action === "blocked") { lines.push(`blocked ${r.kind} ${rowId(r)}: ${r.blocked.map((b) => [b.code, b.field, b.rule].filter((x) => /^[a-z0-9-]{1,32}$/.test(String(x ?? ""))).join(" ")).join(", ")}`); continue; }
    lines.push(r.pendingAck?.length && ["add", "copy", "overwrite"].includes(r.action)
      ? `held ${r.kind} ${r.id} (needs an acknowledgement in the Squads screen: ${r.pendingAck.join(", ")})`
      : `${r.action} ${r.kind} ${r.id}`);
    for (const w of r.warnings ?? []) lines.push(`  warning: ${WARN[w.code] ?? "see the Squads screen"}`);
    if (r.kind === "agent") {
      lines.push(`  command: ${r.item.command}`, `  instructions: ${JSON.stringify(r.item.instructions)}`);
      if (r.item.soul) lines.push(`  soul: ${r.item.soul}`);
    } else {
      lines.push(`  leader: ${r.item.leader}; members: ${r.item.members.map((m) => `${m.agent} (${JSON.stringify(m.role)})`).join(", ") || "none"}`);
    }
  }
  return lines;
}

// What the CLI token binds: the plan's own token (file, destination, choices) and the effective rows, so a change of a local fact
// (a soul installed, an environment file removed) that turns a held or blocked row into a write is stale too.
const cliToken = (p) => HE.sha256(`${p.token}|${HE.stableJson(p.rows)}`);
// A confirm carries an ABSOLUTE expiry (ms since the epoch), at most a day ahead. The consumer refuses it after that moment, however the
// file arrived (a requeue gets a fresh mtime, so a relative ttl would not do). A receipt is kept until its request's expiry plus a margin
// for clock skew, so a nonce is always on record while its request can still be valid. Only live receipts count towards the limit.
const EXPIRY_MAX = 86400000;
const RECEIPT_MARGIN = 3600000;
const RECEIPT_LIMIT = 20000;
const liveReceipts = (now) => (Array.isArray(shared(NONCE_KEY)) ? shared(NONCE_KEY) : []).filter((e) => e && typeof e.n === "string" && Number.isFinite(e.exp) && e.exp + RECEIPT_MARGIN > now);

function agentsImport(cmd, facts) {
  const reply = agentsImportReply(cmd, facts);
  // Last line of defense for the no-echo contract: a result is never sent with a secret-shaped value in it.
  return HE.scanSecrets(reply).length ? "error: the result was withheld because it would contain a secret-shaped value" : reply;
}

function agentsImportReply(cmd, facts) {
  if (typeof cmd.file !== "string" || !cmd.file) return "error: agents-import needs the file text";
  if (unsafeChoices(cmd.choices)) return "error: copy, overwrite and acknowledgements are not available from the CLI: use the Squads screen";
  const confirming = cmd.confirm === true;
  const now = Date.now();
  if (confirming) {
    if (typeof cmd.token !== "string" || !/^[0-9a-f]{64}$/.test(cmd.token)) return "error: --confirm needs the token of a dry run";
    if (typeof cmd.nonce !== "string" || !NONCE_RE.test(cmd.nonce)) return "error: a confirm needs a nonce (8-64 letters, digits, - or _)";
    if (!Number.isSafeInteger(cmd.expiresAt) || cmd.expiresAt > now + EXPIRY_MAX) return `error: a confirm needs expiresAt: a time in ms, at most ${EXPIRY_MAX / 3600000} hours ahead`;
    const receipts = liveReceipts(now); // expired receipts are pruned (not counted) before anything else
    if (receipts.some((e) => e.n === cmd.nonce)) return "ok: already applied (this request was delivered before; nothing changed)";
    if (cmd.expiresAt < now) return "error: expired: this confirm is past its expiry; nothing applied, run the dry run again";
    if (receipts.length >= RECEIPT_LIMIT) return "error: too many live import receipts; nothing applied";
  }
  if (facts.error) return `error: ${facts.error}`;
  // ---- no await from here to the write: the config is read now and the plan, the token and the apply see the same one ----
  const cfg = loadConfig();
  const p = HE.plan(cfg, cmd.file, facts.ctx, {});
  if (!p.ok) return `error: ${p.errors.join("; ")}`;
  const token = cliToken(p);
  if (!confirming) {
    return ["ok: dry run, nothing written", ...planText(p), `token: ${token}`, "confirm with the same file: drover agents import <file> --confirm <token>"].join("\n");
  }
  if (token !== cmd.token) return "stale: the file, the configuration or this machine's souls and environment files changed since the dry run; nothing written, run the dry run again";
  const r = HE.apply(cfg, p, facts.ctx);
  if (r.stale) return "stale: the configuration changed since the dry run; nothing written, run the dry run again";
  if (r.error) return `error: ${r.error}`;
  if (r.applied.length) setShared(AGENTS_KEY, r.config);
  setShared(NONCE_KEY, [...liveReceipts(now), { n: cmd.nonce, exp: cmd.expiresAt }]);
  const lines = [`ok: applied ${r.applied.length}${r.applied.length ? ` (${r.applied.map((a) => `${a.action} ${a.key.split(":")[0]} ${a.id}`).join(", ")})` : ""}`];
  for (const k of r.held) lines.push(`held ${k.replace(":", " ")}: needs an acknowledgement in the Squads screen`);
  if (r.applied.some((a) => a.key.startsWith("agent:"))) lines.push("added agents start with no environment");
  return lines.join("\n");
}

// Reply: a header line, the warnings, `---`, then the file text (JSON lines never start with `---`: the strings are escaped).
// Reads the config and the soul hashes only: never an environment file.
function agentsExport(cmd, facts) {
  const list = (v) => v === undefined ? undefined : Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  const agents = list(cmd.agents), squads = list(cmd.squads);
  if (agents === null || squads === null) return "error: agents and squads must be lists of ids";
  if (facts.error) return `error: ${facts.error}`;
  const opts = { souls: facts.localSouls, app: "", now: Date.now(), home: home() };
  if (agents !== undefined) opts.agents = agents;
  if (squads !== undefined) opts.squads = squads;
  const sum = HE.exportSummary(HE.exportHerd(loadConfig(), opts));
  return sum.error ?? [...sum.header, "---", sum.file].join("\n");
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
    // The other await before the gate: the soul hashes and env-file checks of agents-import / agents-export (read once, the write below is synchronous).
    // And one more for config-get / config-set: the mod.json layer of drover-runs (an inherited value), so the value reported is the one the scheduler uses.
    if (cmd?.op === "config-get" || cmd?.op === "config-set") await loadPolicy("drover-runs").catch(() => {});
    const herd = cmd?.op === "agents-import" ? await importFacts(idsFor(cmd.file)) : cmd?.op === "agents-export" ? await soulFacts() : null;
    // ---- no await from here to the apply: bad -> expired -> stale (against the rev of the card as it is NOW) -> apply ----
    const tasks = load();
    const gate = cmd && typeof cmd === "object" ? inboxGate(cmd, tasks, { arrival: arrivalOf(name, mtimes.get(path)), now: Date.now() }) : null;
    if (gate) {
      reply = `error: ${gate.error}`;
    } else if (cmd?.op === "protocol") {
      // The probe. A sender must get `ok: protocol 2` or more before it sends ifRev or ttlMs (3 before the edit/add fields): an OLD consumer ignores both fields and applies the
      // request unconditionally (it answers this probe `error: Unknown drover command`). Changes no state.
      reply = `ok: protocol ${PROTOCOL}`;
    } else if (cmd?.op === "config-get") {
      reply = configGet(cmd, cfg).reply;
    } else if (cmd?.op === "config-set") {
      reply = configSetOp(cmd);
    } else if (cmd?.op === "agents-import") {
      reply = agentsImport(cmd, herd);
    } else if (cmd?.op === "agents-export") {
      reply = agentsExport(cmd, herd);
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
    } else if (cmd?.op === "resume") {
      // A resume takes minutes: it must not hold this loop, or a queued `resume --cancel` would wait for the very thing it cancels.
      const out = path.replace(/\.json$/, ".result");
      void resumeOp(cmd).then((r) => fs.writeFile(out, r)).catch((e) => fs.writeFile(out, `error: ${String(e?.message ?? e)}`).catch(() => {}));
      continue;
    } else if (cmd?.op === "next") {
      reply = nextFor(cmd.from);
    } else if (cmd?.op === "line") {
      reply = lineOp(cmd);
    } else if (cmd?.op === "project-add") {
      reply = await projectAdd(cmd);
    } else if (cmd?.op === "add") {
      const pk = addProjectKey(load(), loadProjects(), cmd);
      const owned = pk.error ? null : ownerError(loadProjects(), pk.id);
      const r = pk.error ? pk : owned ? { error: owned } : addCommand(load(), cmd, pk.id, undefined, assigneeCtx());
      if (!r.error) setShared(KEY, r.tasks);
      reply = r.error ? `error: ${r.error}` : `ok: ${r.task.id} added to ${columnName(r.task.column)}`;
    } else {
      if (cmd?.op === "note" || cmd?.op === "link") cmd = { ...cmd, by: terminalName(loadRuns(), String(cmd.by ?? "")) || "you" }; // an address becomes the agent's name
      if (cmd?.op === "move") cmd = { ...cmd, fromDrover: isLiveDrover(loadRuns(), String(cmd.from ?? ""), liveState().alive) }; // always set here: a request file cannot claim it
      if (cmd?.op === "link") cmd = { ...cmd, jiraSite: jira }; // always set here: a request file cannot claim it
      // `edit` may carry a project (protocol 3): it is resolved and ownership-checked exactly like op `project` (source below, destination here).
      const withProject = cmd?.op === "project" || (cmd?.op === "edit" && cmd.project !== undefined);
      const pk = !withProject ? { id: null } : typeof cmd.project === "string" || cmd.op === "project" ? projectKey(loadProjects(), cmd.project) : { error: "bad project: give a project id, name or none" };
      // A retained card of a remote project is not edited here either: stored ownership counts, not only the destination.
      const owned = pk.error ? null : ownerError(loadProjects(), pk.id) ?? ownerError(loadProjects(), typeof cmd?.id === "string" ? tasks.find((x) => x.id === cmd.id)?.project : null);
      const r = pk.error ? pk : owned ? { error: owned } : applyCommand(tasks, withProject ? { ...cmd, project: pk.id } : cmd, undefined, assigneeCtx());
      if (!r.error) setShared(KEY, r.tasks);
      reply = r.error ? `error: ${r.error}` : cmd.op === "project" ? `ok: ${r.task.id} project ${r.task.project ?? "none"}` : cmd.op === "link" ? `ok: ${r.task.id} source ${r.task.source?.url ?? "none"}` : cmd.op === "note-edit" || cmd.op === "note-rm" ? `ok: ${r.task.id} ${cmd.noteId} ${cmd.op === "note-rm" ? "removed" : "edited"}` : cmd.op === "note" || cmd.op === "edit" ? `ok: ${r.task.id} ${cmd.op === "note" ? `note ${r.task.notes.length}` : "edited"}` : `ok: ${r.task.id} -> ${columnName(r.task.column)}`;
    }
    await writeReply(path.replace(/\.json$/, ".result"), reply);
  }
}

// A reader (the CLI, the remote writer) takes a .result the moment it exists, and fs.writeFile creates it empty first.
// So the reply is staged in a hidden temp next to it and moved into place (rename is atomic). The runtime fs has no rename: `mv -f`, argv only.
// Any failure falls back to the plain write: a reply is never lost. The temp is always removed (best effort).
let replySeq = 0;
async function writeReply(out, reply) {
  const at = out.lastIndexOf("/") + 1;
  const tmp = `${out.slice(0, at)}.${out.slice(at).replace(/\.result$/, "")}.${(++replySeq).toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, reply);
    if ((await exec("mv", ["-f", tmp, out]))?.code === 0) return;
  } catch {}
  await fs.unlink(tmp).catch(() => {});
  await fs.writeFile(out, reply);
}

// line (drover line): what a run says it is doing. Synchronous: the membership check and the write share one turn. Validated here again (a hand-written
// request file skips the CLI); errors name a rule, never the text. `by` is a claimed terminal (same trust as `note`): it guards against mistakes only.
function lineOp(cmd) {
  const id = typeof cmd.id === "string" && /^T-[A-Z0-9]+$/.test(cmd.id) ? cmd.id : "";
  const v = validateLine(cmd.text, cmd.progress);
  if (!v.ok) return `error: ${v.error}`;
  const { live, alive } = liveState();
  const runs = loadRuns();
  const by = typeof cmd.by === "string" ? cmd.by : "";
  const hit = activeFor(runs, id, by, live, alive);
  if (!hit) return `error: no active run for ${id || "that card"} from this terminal`;
  const line = { text: v.text, ...(v.progress === null ? {} : { progress: v.progress }), at: Date.now(), by: terminalName(runs, by) || by };
  setShared(RUNS_KEY, runs.map((r) => (r === hit.run ? { ...r, line } : r)));
  return `ok: ${hit.run.id} line set`;
}

// config-set (protocol 5): the only config write an agent has. Local only (never in the remote writer's ops). Synchronous: the compare and the write share one turn.
// `from` is a claimed terminal, not a verified identity: the announcement says so. Raising the limit is policy (the soul rule) plus this visibility, not authentication.
function configSetOp(cmd) {
  if (cmd.ttlMs === undefined) return "error: config-set needs ttlMs: a queued change to a global setting must expire";
  const r = configSet(shared(CONFIG_KEY), cmd, cfg);
  if (!r.shared) return r.reply;
  setShared(CONFIG_KEY, r.shared);
  const who = terminalName(loadRuns(), String(cmd.from ?? "")) || "unknown";
  notify({ title: "Parallel runs changed", body: `${r.name} ${r.from} -> ${r.to} (requested by ${who}, unverified). Reset it in Drover > Config.`, level: "info" });
  return r.reply;
}

// The agents and squads of THIS machine, for assignee checks (ids only; nothing else of the config leaves this function).
const assigneeCtx = () => { const c = loadConfig(); return { agents: c.agents.map((a) => a.id), squads: c.squads.map((q) => q.id) }; };

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
  const rec = reconcile(load(), runs, alive, Date.now(), project, new Set(Object.values(resumes()).map((a) => a.card)));
  if (rec.lines.length) setShared(KEY, rec.tasks);
  const tasks = rec.tasks;
  const snap = slotsOf(slotSnapshot(runs, tasks, live, alive), project);
  return [nextReport(tasks, loadProjects(), project, snap.free, snap.waiting), ...(heldNote() ? [heldNote()] : []), ...rec.lines].join("\n");
}

// `drover start <T-…|-> <squad|agent> [--worktree]` from a coordinator agent.
export async function startFromAgent(cmd) {
  const cfg = loadConfig();
  const kind = cfg.squads.some((q) => q.id === cmd.runner) ? "squad" : cfg.agents.some((a) => a.id === cmd.runner) ? "agent" : null;
  if (!kind) return `error: no squad or agent ${cmd.runner} (see: drover squads)`;
  // The load check comes first (T-MWO2HEU32E4): nothing below is read or claimed until it answers, so a held refusal writes nothing.
  // Everything after this await is synchronous up to the claim, so the guard still sees the state it claims on.
  const gate = await startGate();
  if (gate.error) return `error: ${gate.error}`;
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
  const r = await launch(c?.task ?? task, { kind, id: cmd.runner }, { worktree: Boolean(cmd.worktree), reportTo: cmd.from || null, project: bind.project, gate });
  if (reserved) setBinding(undefined);
  if (r.error) {
    if (c) setShared(KEY, release(load(), task.id, c.prev).tasks);
    return `error: ${r.error}`;
  }
  const lead = r.terminals[r.terminals.length - 1];
  return `ok: ${r.id} leader ${lead.address} (${lead.name})` +
    r.terminals.slice(0, -1).map((m) => ` · ${m.role.split(/[.:(]/)[0].trim()} ${m.address}`).join("") +
    (r.worktree ? ` · worktree ${r.worktree.path} on ${r.worktree.branch}` : "") +
    (r.warning ? ` · warning: ${r.warning}` : "");
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

// ---- Needs-you actions (T-MWXRH2E0KIS). Handlers call these; render never does. ----
export const dismissNeed = (a) => setShared(DISMISS_KEY, dismiss(shared(DISMISS_KEY), a, Date.now()));
export const restoreNeed = (key) => setShared(DISMISS_KEY, restore(shared(DISMISS_KEY), key));
export const removeWake = (id) => setShared(WAKE_KEY, loadWakes().filter((w) => w.id !== id));
export const retryWakeNow = (id) => setShared(WAKE_KEY, retryWake(loadWakes(), id));
// Ask a live agent to help with a blocked card: the fixed template (dismiss.js), through hc argv. A remote card is never sent.
export async function sendHelp(address, task, reason) {
  if (task.remote || !terminalIdOk(address)) return false;
  try { await sendToAgent(address, helpMessage(task, reason)); notify({ title: "Sent", body: `${task.id} to ${address}`, level: "info" }); return true; }
  catch (e) { notify({ title: "Not sent", body: String(e?.message ?? e), level: "error" }); return false; }
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

// B3a: the proof of one Review card, read when the dialog opens (never in render). READ-ONLY: git rev-parse/cat-file/log/diff and gh GETs
// (repo view, pr list, pr view, api GET), each gh call as argv through `/usr/bin/env -u <every selector> gh …` (no shell) so it uses the app's own stored login.
// Identity: head A is the PR head read in ONE `gh pr view` (with the checks); the base OID comes from that PR (never `origin/<base>`); log and diff
// use those OIDs only. Without a PR, A is the worktree HEAD, read once. Anything that cannot be proven is `unknown`, never "fine".
const SHA40 = /^[0-9a-f]{40}$/;
const PR_URL_IN = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const ghRun = (args, cwd) => { const c = ghCall(args); return exec(c.cmd, c.args, { ...(cwd ? { cwd } : {}), timeout: 30000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) })); };
const gitRead = (args, cwd) => exec("git", args, { ...(cwd ? { cwd } : {}), timeout: 15000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
const jsonOf = (r) => { try { return JSON.parse(r.stdout); } catch { return undefined; } };
const PR_FIELDS = "number,url,state,baseRefName,baseRefOid,headRefName,headRefOid,statusCheckRollup";

// The PR numbers a pr note names. ONLY a PR-qualified reference counts: a full PR URL or `pull/N`, "PR #N", "pull request #N". A bare "#N" is
// ignored (it could be an issue): it is never an explicit PR and never an ambiguity. Write "PR #N" in a pr note to be recognized.
const prNumbers = (text) => [...new Set([...text.matchAll(/\b(?:(?:PR|pull\s+request)\s*#|pull\/)(\d+)\b/gi)].map((m) => Number(m[1])))];
export async function loadEvidence(task, run, current = () => true) {
  const live = () => { if (!current()) throw CONTEXT_STALE; };
  live();
  const notes = Array.isArray(task?.notes) ? task.notes : [];
  const handoffNote = [...notes].reverse().find((n) => n?.kind === "handoff");
  const wt = run?.worktree ?? null;
  const base = { at: Date.now(), summary: { title: String(task?.title ?? ""), desc: String(task?.desc ?? "") }, handoff: handoffNote ? { text: String(handoffNote.text ?? ""), by: handoffNote.by ?? null, at: handoffNote.at ?? null } : null, proof: proofPathOf(notes), actor: null, localDiffers: false };
  const done = (parts, extra = {}) => ({ ...base, changes: { state: "unavailable", reason: "no PR head to compare" }, ...extra, evidence: buildEvidence({ checks: classifyChecks(undefined, { noPr: parts.pr?.state === "none" }), verdict: reviewOf(notes, parts.head ?? null), ...parts }) });
  const unknown = (reason, parts = {}) => done({ pr: { state: "unknown", reason }, ...parts });

  // The PR the card names is authoritative; a branch search is only for a card that names none.
  const fromSource = task?.source?.kind === "github" && /\/pull\/\d+/.test(task.source.url ?? "") ? (String(task.source.url).match(PR_URL_IN) ?? [])[0] ?? null : null;
  const noteUrls = notes.filter((n) => n?.kind === "pr").flatMap((n) => String(n.text ?? "").match(PR_URL_IN) ?? []);
  const fromNote = noteUrls.at(-1) ?? null;
  if (fromSource && fromNote && fromSource !== fromNote) return unknown("ambiguous");
  // A pr note that names the PR by number only ("PR #5") is explicit too, in the recorded repo (read below). Two numbers, or a number that is
  // not the URL's, are ambiguous; an explicit reference that cannot be resolved is unknown, never a fall-through to "no PR".
  let namedNum = null;
  const refsOf = (n) => (n?.kind === "pr" ? prNumbers(String(n.text ?? "")) : []);
  const newestRefs = [...notes].reverse().map(refsOf).find((l) => l.length) ?? [];
  if (!fromSource && !fromNote) {
    if (newestRefs.length > 1) return unknown("ambiguous");
    namedNum = newestRefs[0] ?? null;
  } else {
    const urlNum = Number((fromSource ?? fromNote).match(/\/pull\/(\d+)/)[1]);
    if (newestRefs.some((x) => x !== urlNum)) return unknown("ambiguous");
  }
  const named = fromSource ?? fromNote;

  const envOk = (await exec("test", ["-x", ENV_BIN]).catch(() => ({ code: 1 }))).code === 0;
  live();
  if (!envOk) return unknown("identity"); // gh's selectors cannot be removed: no gh request at all
  if (!named && !namedNum && !wt?.branch) return unknown("no-branch");
  const folderOk = wt?.path ? await isDir(wt.path) : false;
  live();
  const cwd = folderOk ? wt.path : wt?.repo ?? null; // a finished run's worktree folder is gone: gh asks from the repo, qualified by the recorded branch

  let url = named, repo = named ? repoOfUrl(named) : null;
  if (named && !repo) return unknown("unexpected");
  if (!named && namedNum && !cwd) return unknown("no-repo"); // nowhere to read the repo from
  if (!named) {
    const rv = await ghRun(["repo", "view", "--json=nameWithOwner"], cwd);
    live();
    if (rv.code !== 0) return unknown(ghProblem(rv.stderr));
    repo = jsonOf(rv)?.nameWithOwner;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) return unknown("unexpected");
    if (namedNum) url = `https://github.com/${repo}/pull/${namedNum}`;
    else {
    const ls = await ghRun(["pr", "list", "--head", wt.branch, "--state", "all", "-R", repo, "--json=number,url,state"], cwd);
    live();
    if (ls.code !== 0) return unknown(ghProblem(ls.stderr), { repo });
    const rows = jsonOf(ls);
    if (!Array.isArray(rows)) return unknown("unexpected", { repo });
    if (rows.length > 1) return unknown("ambiguous", { repo });
    if (rows.length === 0) { // no PR in any state: the evidence is the worktree commit, read once
      if (!folderOk) return unknown("worktree-gone", { repo });
      const h = await gitRead(["rev-parse", "HEAD"], wt.path);
      live();
      const head = h.code === 0 ? h.stdout.trim() : "";
      if (!SHA40.test(head)) return unknown("unexpected", { repo });
      return done({ repo, pr: { state: "none" }, head, headSource: "worktree" }, { changes: { state: "unavailable", reason: "no PR, so no base to compare" } });
    }
    url = rows[0].url;
    if (repoOfUrl(url) !== repo) return unknown("repo-mismatch", { repo });
    }
  }

  // ONE read of the PR: its head, its checks and (when this gh offers it) its base OID all come from the same answer.
  let pv = await ghRun(["pr", "view", url, `--json=${PR_FIELDS}`], cwd);
  if (pv.code !== 0 && /unknown json field/i.test(pv.stderr ?? "")) pv = await ghRun(["pr", "view", url, `--json=${PR_FIELDS.replace("baseRefOid,", "")}`], cwd);
  live();
  if (pv.code !== 0) return unknown(ghProblem(pv.stderr), { repo });
  const p = jsonOf(pv);
  if (!p || typeof p !== "object" || repoOfUrl(p.url) !== repo || !Number.isInteger(p.number) || !SHA40.test(p.headRefOid ?? "")) return unknown(p && repoOfUrl(p.url) !== repo ? "repo-mismatch" : "unexpected", { repo });
  let baseSha = SHA40.test(p.baseRefOid ?? "") ? p.baseRefOid : null;
  if (!baseSha) { // GET the PR's base: never the local origin/<base>, which can be arbitrarily stale
    const api = await ghRun(["api", `repos/${repo}/pulls/${p.number}`, "--jq=.base.sha"], cwd);
    live();
    const sha = api.code === 0 ? String(api.stdout).trim() : "";
    if (SHA40.test(sha)) baseSha = sha;
  }
  const head = p.headRefOid;
  const who = await ghRun(["api", "user", "--jq=.login"], cwd);
  live();
  const login = who.code === 0 ? String(who.stdout).trim() : "";
  const extra = { actor: /^[\w-]{1,39}(\[bot\])?$/.test(login) ? login : null };
  if (folderOk) { // shown only: the local branch differs from the PR head (A is still what everything uses)
    const h = await gitRead(["rev-parse", "HEAD"], wt.path);
    live();
    extra.localDiffers = h.code === 0 && SHA40.test(h.stdout.trim()) && h.stdout.trim() !== head;
  }
  let changes;
  if (!baseSha) changes = { state: "unavailable", reason: "PR base not known" };
  else if (!cwd) changes = { state: "unavailable", reason: "no local checkout" };
  else {
    const hasA = (await gitRead(["cat-file", "-e", `${head}^{commit}`], cwd)).code === 0;
    const hasB = hasA && (await gitRead(["cat-file", "-e", `${baseSha}^{commit}`], cwd)).code === 0;
    live();
    if (!hasA) changes = { state: "unavailable", reason: "head not fetched" };
    else if (!hasB) changes = { state: "unavailable", reason: "base not fetched" };
    else {
      const lg = await gitRead(["log", "--oneline", `${baseSha}..${head}`], cwd);
      const df = await gitRead(["diff", "--stat", `${baseSha}...${head}`], cwd);
      live();
      changes = lg.code === 0 && df.code === 0 ? { state: "ok", commits: lg.stdout.split("\n").filter(Boolean), files: df.stdout.trimEnd() } : { state: "unavailable", reason: "git could not list the changes" };
    }
  }
  return done({ repo, pr: { state: "found", number: p.number, url: p.url, prState: p.state }, base: p.baseRefName ?? null, baseSha, head, headSource: "pr", checks: classifyChecks(p.statusCheckRollup) }, { ...extra, changes });
}

// ---- B3b: the Accept chain's real deps ----
// The only place that can merge, close an issue, move a card or write the accept record. accept.js never imports this file: it is handed `deps`.
// gh runs through ghCall (the app's own login), as argv, never a shell. Every ref is validated before gh: a bad repo, number, head or URL never reaches exec.
// Never --admin, --auto, --delete-branch, never a push. A gh failure becomes one bounded word; the raw text is never kept.
export const ACCEPT_KEY = "drover.accept";
export const acceptDir = () => `${appHome()}/data/drover-accept`;
let acceptOverride = null;
export const useAcceptDeps = (d) => { acceptOverride = d; }; // tests inject a fake; the app never calls it
const goodRef = (r) => Boolean(r) && /^[\w.-]+\/[\w.-]+$/.test(r.repo ?? "") && Number.isInteger(r.number) && r.number > 0 && SHA40.test(r.head ?? "") && r.url === `https://github.com/${r.repo}/pull/${r.number}`;
const goodIssue = (r) => Boolean(r) && /^[\w.-]+\/[\w.-]+$/.test(r.repo ?? "") && Number.isInteger(r.number) && r.number > 0;
const goodLabels = (ls) => Array.isArray(ls) && ls.every((l) => typeof l === "string" && l.length > 0 && l.length <= 100 && !/[\r\n]/.test(l));
const mergeWord = (stderr) => {
  const s = String(stderr ?? "");
  if (/not mergeable|conflict/i.test(s)) return "conflict";
  if (/head branch was modified|expected head|head sha|match-head/i.test(s)) return "head-moved";
  if (/required status check/i.test(s)) return "checks-required";
  if (/approving review|review is required|reviews? required/i.test(s)) return "review-required";
  if (/merge queue/i.test(s)) return "queue-rejected";
  const w = ghProblem(s);
  return w === "auth" || w === "offline" ? w : "unexpected";
};
const readWord = (stderr) => { const w = ghProblem(stderr); return w === "auth" || w === "offline" ? w : "unexpected"; };
const lines1 = (s) => String(s).replace(/[\r\n]+/g, " ").trim();

export const acceptRecords = () => ({
  get: (key) => (shared(ACCEPT_KEY) ?? {})[key] ?? null,
  set: (key, rec) => { const all = { ...(shared(ACCEPT_KEY) ?? {}) }; if (rec == null) delete all[key]; else all[key] = rec; setShared(ACCEPT_KEY, all); },
});

export function acceptDeps() {
  if (acceptOverride) return acceptOverride;
  const stored = (id, project) => load().find((x) => x.id === id && (x.project ?? null) === (project ?? null)) ?? null;
  return {
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
    token: () => newUuid().replace(/-/g, ""),
    task: stored,
    cards: () => load(),
    readEvidence: (task) => loadEvidence(task, linkedRun(task, loadRuns())),
    readPr: async (ref) => {
      if (!goodRef(ref)) return { ok: false, word: "unexpected" };
      const v = await ghRun(["pr", "view", ref.url, "--json=state,isDraft,mergeable,title,body,headRefOid"]);
      if (v.code !== 0) return { ok: false, word: readWord(v.stderr) };
      const pr = jsonOf(v);
      if (!pr || typeof pr !== "object") return { ok: false, word: "unexpected" };
      const list = await ghRun(["api", `repos/${ref.repo}/pulls/${ref.number}/commits`, "--paginate", "--jq=.[] | .commit.message | @json"]);
      if (list.code !== 0) return { ok: false, word: readWord(list.stderr) };
      let commits;
      try { commits = String(list.stdout).split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return { ok: false, word: "unexpected" }; }
      if (!commits.every((c) => typeof c === "string")) return { ok: false, word: "unexpected" };
      const cnt = await ghRun(["api", `repos/${ref.repo}/pulls/${ref.number}`, "--jq=.commits"]);
      if (cnt.code !== 0) return { ok: false, word: readWord(cnt.stderr) };
      const commitCount = Number(String(cnt.stdout).trim());
      return { ok: true, state: pr.state, isDraft: pr.isDraft === true, mergeable: pr.mergeable ?? null, title: String(pr.title ?? ""), body: String(pr.body ?? ""), headRefOid: pr.headRefOid ?? null, commits, commitCount };
    },
    // The one merge: the bound PR URL, squash, pinned to the bound head. Nothing else is ever added to this argv.
    merge: async (ref) => {
      if (!goodRef(ref)) return { ok: false, word: "unexpected" };
      const r = await ghRun(["pr", "merge", ref.url, "--squash", "--match-head-commit", ref.head]);
      return r.code === 0 ? { ok: true } : { ok: false, word: mergeWord(r.stderr) };
    },
    readBack: async (ref) => {
      if (!goodRef(ref)) return { ok: false, word: "unexpected" };
      const r = await ghRun(["pr", "view", ref.url, "--json=state,headRefOid"]);
      if (r.code !== 0) return { ok: false, word: readWord(r.stderr) };
      const p = jsonOf(r);
      return p && typeof p.state === "string" && SHA40.test(p.headRefOid ?? "") ? { ok: true, state: p.state, head: p.headRefOid } : { ok: false, word: "unexpected" };
    },
    readIssue: async (ref) => {
      if (!goodIssue(ref)) return { ok: false, word: "unexpected" };
      const r = await ghRun(["issue", "view", String(ref.number), "-R", ref.repo, "--json=state,labels"]);
      if (r.code !== 0) return { ok: false, word: readWord(r.stderr) };
      const i = jsonOf(r);
      return i && typeof i.state === "string" && Array.isArray(i.labels) ? { ok: true, state: i.state, labels: i.labels.map((l) => String(l?.name ?? "")).filter(Boolean) } : { ok: false, word: "unexpected" };
    },
    // An issue the PR already closed: only the status: labels go (one issue edit), never a second close or a comment.
    removeLabels: async (a) => {
      if (!goodIssue(a) || !goodLabels(a.labels) || !a.labels.length) return { ok: false, word: "unexpected" };
      const e = await ghRun(["issue", "edit", String(a.number), "-R", a.repo, ...a.labels.flatMap((l) => ["--remove-label", l])]);
      return e.code === 0 ? { ok: true } : { ok: false, word: readWord(e.stderr) };
    },
    // _herd.md section 7: close the linked issue with a one-line comment. ONE gh op: the status: labels are a separate dep (removeLabels), so the chain
    // can judge eligibility again between the two writes.
    closeIssue: async (a) => {
      if (!goodIssue(a)) return { ok: false, word: "unexpected" };
      const c = await ghRun(["issue", "close", String(a.number), "-R", a.repo, "-c", lines1(a.comment).slice(0, 200)]);
      return c.code === 0 ? { ok: true } : { ok: false, word: readWord(c.stderr) };
    },
    // The owner's click is the owner's move. The card must still be in Review; the result of the store is what is saved.
    moveDone: async (id, project) => {
      const cur = stored(id, project);
      if (!cur || cur.column !== "review") return false;
      return Boolean(save(update(load(), id, { column: "done" })));
    },
    note: async (id, project, text, kind) => {
      if (!stored(id, project)) return;
      save(applyCommand(load(), { op: "note", id, text, kind: kind === "decision" ? "decision" : "log", by: "accept" }));
    },
    records: acceptRecords(),
    lock: createLock(fs, acceptDir()),
    onStep: () => {},
  };
}
export { lockKey };

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
// Herdr's own effective bindings (defaults, keys.json, terminal section): the clash check must see what a keys.json text alone cannot. Called when the
// Shortcuts list loads and again right before a flip, never in render. A failed lookup (a throw, or not a list) gives null: keys.js then refuses to enable, it never reads null as "no clash".
export const builtinKeys = () => { try { const k = hostKeys(); return Array.isArray(k) ? k : null; } catch { return null; } };
export const setShortcut = (shortcut, on, builtin) => applyKey(keysIo(), shortcut, on, builtin);
