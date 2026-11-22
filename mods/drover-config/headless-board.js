// The headless board writer (A3a, T-MWO2HE4FPJK): one board per machine, read and written by a CLI over `hc exec`. Node and fs only, no Herdr import.
// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod (copies.txt), and it is one of the files `drover machines install` ships.
//
// Board files: <dir>/board.<gen>.json, <gen> a decimal integer. The current board is the highest gen. A generation is a full state derived from the one
// before and is never deleted or overwritten (no pruning in this slice). A commit writes a temp file in the same directory, fsyncs it, then
// link()s it to board.<gen+1>.json: link is atomic and fails with EEXIST if the name exists, so a writer that lost a race, or was paused across any
// number of commits, finds its target taken and retries from a fresh read. No lock. The mutation is acknowledged only after the link and the directory fsync.
// A process kill leaves the old generation or the whole new one (mutation and nonce record together); it is not a power-loss proof.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ownerError } from "./remote.js";
import { addCommand, addProjectKey, update, applyCommand, protocolFields, inboxGate, projectKey, projectAddRequest, addProject, noteIds, list as normTasks, NOTE_KINDS, reviewTextError, revOf } from "./store.js";

export const SCHEMA = 1;
export const CLI = "drover-headless";
export const OPS = ["add", "edit", "note", "move", "archive", "project-add", "import", "move-out"];
export const RETENTION_MS = 24 * 60 * 60 * 1000; // how long a nonce answers its stored result
export const FUTURE_SKEW_MS = 30000; // an issuedAt further ahead than this is refused
export const TTL_MAX_MS = 600000;
export const MAX_TRIES = 20;
export const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

const GEN_FILE = /^board\.(0|[1-9][0-9]*)\.json$/;
const TEMP_FILE = /^\.tmp-[0-9]+-[a-z0-9]+$/;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// A fixed-code failure: `code` is stable, `error` is for people.
const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
const boardError = (code, message) => Object.assign(new Error(message), { boardCode: code });

export const boardDir = () => process.env.DROVER_BOARD_DIR || path.join(os.homedir(), ".local/share/drover-herdr");

const emptyState = () => ({ tasks: [], projects: [], agents: { agents: [], squads: [] }, nonces: {} });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Generation numbers found in the directory, ascending. Names that do not match are ignored.
export function boardFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return names.map((n) => GEN_FILE.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

const pickAgents = (a) => ({
  agents: (Array.isArray(a?.agents) ? a.agents : []).filter((x) => typeof x?.id === "string").map((x) => ({ id: x.id, name: String(x.name ?? x.id) })),
  squads: (Array.isArray(a?.squads) ? a.squads : []).filter((x) => typeof x?.id === "string").map((x) => ({ id: x.id, name: String(x.name ?? x.id) })),
});

// The newest generation as { gen, state }; an empty directory is gen 0 and an empty board. A corrupt newest is an error, never a fallback to the one before.
export function readBoard(dir) {
  const gens = boardFiles(dir);
  if (!gens.length) return { gen: 0, state: emptyState() };
  const gen = gens.at(-1);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, `board.${gen}.json`), "utf8")); } catch { throw boardError("board-corrupt", `board.${gen}.json is not valid JSON`); }
  if (!isObj(doc) || !Array.isArray(doc.tasks) || !Array.isArray(doc.projects)) throw boardError("board-corrupt", `board.${gen}.json has no tasks and projects`);
  if (doc.schema !== SCHEMA) throw boardError("board-schema", `board.${gen}.json has schema ${JSON.stringify(doc.schema)}, this tool reads ${SCHEMA}`);
  const state = { tasks: doc.tasks, projects: doc.projects, agents: pickAgents(doc.agents), nonces: isObj(doc.nonces) ? doc.nonces : {} };
  if (isObj(doc.migrated)) state.migrated = doc.migrated;
  return { gen, state };
}

const fileOf = (gen, state) => JSON.stringify({ schema: SCHEMA, gen, writer: CLI, tasks: state.tasks, projects: state.projects, agents: pickAgents(state.agents), nonces: state.nonces, ...(state.migrated ? { migrated: state.migrated } : {}) });

// ---------------------------------------------------------------------------------------------------------- orphan temps
// Removes only `.tmp-<pid>-<random>` files older than an hour (a writer that died between create and unlink). Nothing else is ever touched.
export async function sweepOrphans(dir, { now = Date.now } = {}) {
  const removed = [];
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return { removed }; }
  const t = now();
  for (const n of names.filter((x) => TEMP_FILE.test(x)).sort()) {
    try {
      const st = await fs.promises.stat(path.join(dir, n));
      if (st.isFile() && t - st.mtimeMs > TEMP_MAX_AGE_MS) { await fs.promises.unlink(path.join(dir, n)); removed.push(n); }
    } catch { /* gone already, or not ours to remove */ }
  }
  return { removed };
}

// ---------------------------------------------------------------------------------------------------------- the commit loop
const NO_LINK = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"]);
// The real syncs. Every failure propagates (as E_SYNC): a filesystem that cannot fsync a directory (EINVAL, ENOTSUP, EPERM) cannot give the
// acknowledgement this tool promises, so it is refused rather than weakened. `io` ({ fsyncFile, fsyncDir }) is the seam tests inject faults through.
const REAL_IO = {
  fsyncFile: (fh) => fh.sync(),
  async fsyncDir(dir) { const fd = await fs.promises.open(dir, "r"); try { await fd.sync(); } finally { await fd.close(); } },
};
const syncFailed = (what, e) => boardError("E_SYNC", `${what} could not be synced (${e?.code ?? "error"}); nothing is acknowledged`);

// mutate(state, nowMs, targetGen) -> { error } | { replay: { gen, result } } | { state, result, recheck? } | { state: null, result } (answer without a commit).
// recheck(nowMs) -> { error } | null runs with a fresh clock right before the link. Only after the link and the directory fsync is the result acknowledged.
async function commit(dir, mutate, { now = Date.now, hooks = {}, io } = {}) {
  const sys = { ...REAL_IO, ...io };
  // Whatever the answer, it crosses the directory-sync barrier first: a replay or a no-op answer may describe a link that is not yet durable.
  const barrier = async () => { try { await sys.fsyncDir(dir); } catch (e) { throw syncFailed("the board folder", e); } };
  const hook = async (step, ctx) => { if (typeof hooks?.[step] === "function") await hooks[step]({ step, ...ctx }); };
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await sweepOrphans(dir, { now });
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const { gen, state } = readBoard(dir);
    const target = gen + 1;
    const ctx = { attempt, target };
    await hook("read", ctx);
    const m = mutate(state, now(), target);
    if (m.error) return m;
    if (m.replay) { await barrier(); return { ok: true, gen: m.replay.gen ?? gen, replayed: true, attempts: attempt, result: m.replay.result }; }
    if (m.state === null) { await barrier(); return { ok: true, gen, replayed: false, attempts: attempt, result: m.result, committed: false }; }
    const temp = path.join(dir, `.tmp-${process.pid}-${randomBytes(5).toString("hex")}`);
    const final = path.join(dir, `board.${target}.json`);
    const fh = await fs.promises.open(temp, "wx", 0o600);
    try {
      await hook("tempCreate", ctx);
      await fh.writeFile(fileOf(target, m.state));
      await hook("write", ctx);
      try { await sys.fsyncFile(fh); } catch (e) { throw syncFailed("the new generation", e); }
      await hook("fsync", ctx);
    } catch (e) { await fh.close().catch(() => {}); await fs.promises.unlink(temp).catch(() => {}); throw e; }
    await fh.close();
    try {
      await hook("beforeLink", ctx);
      const late = m.recheck?.(now());
      if (late?.error) { await fs.promises.unlink(temp).catch(() => {}); return late; }
      try { await fs.promises.link(temp, final); }
      catch (e) {
        if (e.code === "EEXIST") { await fs.promises.unlink(temp).catch(() => {}); continue; } // somebody else took N+1: read again
        await fs.promises.unlink(temp).catch(() => {});
        if (NO_LINK.has(e.code)) return fail("no-link", `this filesystem cannot hard-link in ${dir} (${e.code}); the board needs it`);
        throw e;
      }
    } catch (e) { await fs.promises.unlink(temp).catch(() => {}); throw e; }
    await hook("afterLink", ctx);
    await fs.promises.unlink(temp);
    await hook("afterUnlink", ctx);
    await hook("dirFsync", ctx);
    await barrier();
    return { ok: true, gen: target, replayed: false, attempts: attempt, result: m.result };
  }
  return fail("busy", `the board kept changing: gave up after ${MAX_TRIES} tries; nothing was applied`);
}

const guard = async (fn) => {
  try { return await fn(); } catch (e) {
    if (e?.boardCode) return fail(e.boardCode, e.message);
    return fail("io", `${e?.code ?? "error"}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
};

// ---------------------------------------------------------------------------------------------------------- envelope
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v) ?? "null");
export const fingerprint = (env) => createHash("sha256").update(canon(env)).digest("hex");

function checkEnvelope(env) {
  if (!isObj(env)) return fail("bad-envelope", "the payload must be one JSON object");
  if (typeof env.nonce !== "string" || !NONCE.test(env.nonce)) return fail("bad-envelope", "bad nonce: 8-128 characters of A-Z a-z 0-9 _ -");
  if (!Number.isSafeInteger(env.issuedAt)) return fail("bad-envelope", "bad issuedAt: whole milliseconds since the epoch");
  if (!Number.isSafeInteger(env.ttlMs) || env.ttlMs < 1 || env.ttlMs > TTL_MAX_MS) return fail("bad-envelope", `bad ttlMs: a whole number of milliseconds, 1 to ${TTL_MAX_MS}`);
  if (typeof env.op !== "string" || !env.op) return fail("bad-envelope", "bad op: a string");
  return null;
}
const expiredError = (env, t) => {
  if (env.issuedAt - t > FUTURE_SKEW_MS) return fail("expired", `expired: issuedAt is ${Math.round((env.issuedAt - t) / 1000)}s in the future; not applied`);
  if (t - env.issuedAt > env.ttlMs) return fail("expired", `expired: issued ${Math.round((t - env.issuedAt) / 1000)}s ago, ttl ${env.ttlMs}ms; not applied`);
  return null;
};

// move-out borrows the archive rev rule (ifRev required, same stale text); store.js REV_OPS is untouched.
export function moveOutGate(cmd, tasks) {
  if (cmd?.ifRev === undefined) return { error: "move-out needs ifRev: the card's rev as you last read it" };
  const f = protocolFields({ op: "archive", ifRev: cmd.ifRev });
  if (f.error) return f;
  return inboxGate({ op: "archive", id: cmd.id, ifRev: f.ifRev }, tasks, { arrival: 0, now: 0 });
}

const refusal = (error) => (/^stale:/.test(error) ? fail("stale", error) : fail("refused", error));
const assigneeCtx = (state) => ({ agents: state.agents.agents.map((a) => a.id), squads: state.agents.squads.map((s) => s.id) });
const cardResult = (t) => ({ id: t.id, column: t.column, rev: revOf(t) });

// The inbox's project-ownership guard (io.js savedOwned) as one pure check: every card the result adds or changes is checked against its stored
// project AND its new one. A project bound to another machine is read-only here. -> an error text, or null.
export function ownershipError(projects, before, after) {
  if (!projects.some((p) => p?.remote)) return null;
  const stored = new Map(before.map((x) => [x.id, x]));
  for (const x of after) {
    const old = stored.get(x.id);
    if (old && JSON.stringify(old) === JSON.stringify(x)) continue;
    const e = ownerError(projects, x.project) ?? (old ? ownerError(projects, old.project) : null);
    if (e) return e;
  }
  return null;
}

// Applies one op to the state. Pure. -> { error } | { state, result } | { state: null, result } (nothing to commit).
function dispatch(env, state, t) {
  if (env.op !== "move-out") { const g = inboxGate(env, state.tasks, { arrival: env.issuedAt, now: env.issuedAt }); if (g) return g; } // bad or stale ifRev (the ttl was checked above)
  const withTasks = (tasks, result) => ({ state: { ...state, tasks }, result });
  const withProjects = (projects, result) => ({ state: { ...state, projects }, result });
  switch (env.op) {
    case "add": {
      const pk = addProjectKey(state.tasks, state.projects, env);
      if (pk.error) return { error: pk.error };
      const r = addCommand(state.tasks, env, pk.id, t, assigneeCtx(state));
      return r.error ? { error: r.error } : withTasks(r.tasks, cardResult(r.task));
    }
    case "edit": case "note": case "move": case "archive": {
      let cmd = env.op === "move" ? { ...env, fromDrover: false } : { ...env }; // a payload cannot claim to be a Drover
      if (env.op === "edit" && env.project !== undefined) {
        const pk = typeof env.project === "string" ? projectKey(state.projects, env.project) : { error: "bad project: give a project id, name or none" };
        if (pk.error) return { error: pk.error };
        cmd = { ...cmd, project: pk.id };
      }
      const r = applyCommand(state.tasks, cmd, t, assigneeCtx(state));
      return r.error ? { error: r.error } : withTasks(r.tasks, { ...cardResult(r.task), ...(env.op === "note" ? { notes: r.task.notes.length } : {}) });
    }
    case "project-add": {
      const req = projectAddRequest(env);
      if (req.error) return { error: req.error };
      const r = addProject(state.projects, { name: req.value.name, repos: [req.value.repo], folders: req.value.folders, branch: req.value.branch || "main" }, t); // no git is probed here
      return r.error ? { error: r.error } : withProjects(r.projects, { id: r.project.id, name: r.project.name, branch: r.project.branch });
    }
    case "import": return importCard(env, state, t);
    case "move-out": return moveOut(env, state, t);
    default: return { error: "Unknown drover command" };
  }
}

function importCard(env, state, t) {
  if (typeof env.movedFrom !== "string" || !env.movedFrom || env.movedFrom.length > 200) return { error: "bad movedFrom: a string of 1-200 characters" };
  if (!isObj(env.task)) return { error: "bad task: give the card as an object" };
  const have = state.tasks.find((x) => x.movedFrom === env.movedFrom);
  if (have) return { state, result: { id: have.id, already: true } }; // nothing to change, but the nonce is still recorded (a nonce-only generation)
  const src = env.task;
  let pk = { id: null };
  if (src.project !== undefined && src.project !== null && src.project !== "") { pk = projectKey(state.projects, src.project); if (pk.error) return { error: pk.error }; if (!pk.id) pk = { id: null }; }
  const r = addCommand(state.tasks, { title: src.title, desc: src.desc, tags: src.tags, priority: src.priority, column: src.column }, pk.id, t, assigneeCtx(state));
  if (r.error) return { error: r.error };
  const rawNotes = Array.isArray(src.notes) ? src.notes : [];
  if (rawNotes.length > 1000) return { error: "too many notes: at most 1000" };
  const notes = [];
  for (const n of rawNotes) {
    const text = String(n?.text ?? "").trim();
    if (!text) return { error: "Note is empty" };
    if (n.kind != null && n.kind !== "" && !NOTE_KINDS.includes(n.kind)) return { error: `Unknown note kind ${n.kind}: use ${NOTE_KINDS.join(", ")}` };
    const badReview = reviewTextError(n.kind, text);
    if (badReview) return { error: badReview };
    notes.push({ at: Number.isSafeInteger(n.at) ? n.at : t, by: String(n.by ?? "").trim() || "you", text, ...(n.kind ? { kind: n.kind } : {}) });
  }
  const source = isObj(src.source) && typeof src.source.kind === "string" ? { kind: src.source.kind, id: src.source.id, url: src.source.url } : null;
  const card = { ...r.task, notes: noteIds(notes), source, movedFrom: env.movedFrom, ...(Number.isSafeInteger(src.created) ? { created: src.created } : {}) };
  return { state: { ...state, tasks: [...r.tasks.slice(0, -1), card] }, result: { id: card.id, column: card.column, rev: revOf(card) } };
}

function moveOut(env, state, t) {
  if (typeof env.id !== "string") return { error: "Unknown drover command" };
  const cur = state.tasks.find((x) => x.id === env.id);
  if (!cur) return { error: `Task ${env.id} not found` };
  const g = moveOutGate(env, state.tasks);
  if (g) return g;
  if (cur.archived) return { error: `Task ${env.id} is archived` };
  if (cur.column === "doing" && cur.agent) return { error: `Task ${env.id} is in progress with an agent attached: stop it first` };
  const r = update(state.tasks, env.id, { archived: true, movedOut: true }, t);
  return r.error ? { error: r.error } : { state: { ...state, tasks: r.tasks }, result: { id: r.task.id, task: r.task } };
}

// ---------------------------------------------------------------------------------------------------------- submit
// One op: validated, applied and committed (or answered from the nonce table). -> { ok, gen, replayed, attempts, result } | { ok:false, code, error }
export async function submit(env, { dir = boardDir(), now = Date.now, hooks, io } = {}) {
  const bad = checkEnvelope(env);
  if (bad) return bad;
  const fp = fingerprint(env);
  return guard(() => commit(dir, (state, t, target) => {
    const rec = state.nonces[env.nonce];
    if (isObj(rec) && Number.isFinite(rec.at) && t - rec.at <= RETENTION_MS) { // an aged record is treated as absent
      return rec.fp === fp ? { replay: { gen: rec.gen, result: rec.result } } : fail("nonce-reused", "this nonce was used with another payload; not applied");
    }
    const late = expiredError(env, t);
    if (late) return late;
    if (!OPS.includes(env.op)) return fail("unknown-op", "Unknown drover command");
    const r = dispatch(env, state, t);
    if (r.error) return refusal(r.error);
    const owned = r.state && ownershipError(state.projects, state.tasks, r.state.tasks);
    if (owned) return refusal(owned);
    if (r.state === null) return r;
    const nonces = Object.fromEntries(Object.entries(state.nonces).filter(([, v]) => isObj(v) && Number.isFinite(v.at) && t - v.at <= RETENTION_MS));
    return { state: { ...r.state, nonces: { ...nonces, [env.nonce]: { fp, at: t, gen: target, result: r.result } } }, result: r.result, recheck: (t2) => expiredError(env, t2) };
  }, { now, hooks, io }));
}

// ---------------------------------------------------------------------------------------------------------- read verbs
const tasksHash = (tasks) => createHash("sha256").update(JSON.stringify(tasks)).digest("hex").slice(0, 16);
export const versionInfo = () => ({ cli: CLI, schema: SCHEMA, ops: [...OPS] });
export function revInfo(dir = boardDir()) {
  const { gen, state } = readBoard(dir);
  return { gen, tasks: tasksHash(state.tasks), bytes: Buffer.byteLength(JSON.stringify(state.tasks)) };
}
export function tasksInfo(dir = boardDir()) {
  const { gen, state } = readBoard(dir);
  return { gen, rev: tasksHash(state.tasks), tasks: state.tasks };
}
export function projectsInfo(dir = boardDir()) {
  const { gen, state } = readBoard(dir);
  return { gen, projects: state.projects };
}

// ---------------------------------------------------------------------------------------------------------- migrate-in
// Copies the board data of an old shared.json: drover.tasks and drover.projects (ids not yet on the board; claimToken dropped) and the ids and names
// of drover.agents' agents and squads. Nothing else of that file is read. Commit 1 copies, commit 2 writes the `migrated` marker LAST onto the newest state,
// so an edit that landed in between survives and a kill between the two is finished by a rerun. Existing ids are never overwritten.
const KINDS = ["tasks", "projects", "agents", "squads"];
const zero = () => ({ tasks: 0, projects: 0, agents: 0, squads: 0 });
export async function migrateIn(dir, fromPath, { now = Date.now, hooks = {}, io } = {}) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(fromPath, "utf8")); } catch (e) { return fail("bad-source", e?.code === "ENOENT" ? "the source file does not exist" : "the source file is not valid JSON"); }
  if (!isObj(doc)) return fail("bad-source", "the source file is not a JSON object");
  const uniq = (xs) => { const seen = new Set(); return xs.filter((x) => typeof x?.id === "string" && x.id && !seen.has(x.id) && seen.add(x.id)); };
  const src = {
    tasks: uniq(normTasks(Array.isArray(doc["drover.tasks"]) ? doc["drover.tasks"] : [])).map(({ claimToken, ...t }) => t),
    projects: uniq(Array.isArray(doc["drover.projects"]) ? doc["drover.projects"] : []),
    ...pickAgents(isObj(doc["drover.agents"]) ? doc["drover.agents"] : {}),
  };
  const total = Object.fromEntries(KINDS.map((k) => [k, src[k].length]));
  let copied = zero(), skipped = zero();
  const run = (mutate) => commit(dir, mutate, { now, hooks, io });
  const first = await guard(() => run((state) => {
    const have = { tasks: new Set(state.tasks.map((x) => x.id)), projects: new Set(state.projects.map((x) => x.id)), agents: new Set(state.agents.agents.map((x) => x.id)), squads: new Set(state.agents.squads.map((x) => x.id)) };
    const add = Object.fromEntries(KINDS.map((k) => [k, src[k].filter((x) => !have[k].has(x.id))]));
    copied = Object.fromEntries(KINDS.map((k) => [k, add[k].length]));
    skipped = Object.fromEntries(KINDS.map((k) => [k, src[k].length - add[k].length]));
    if (KINDS.every((k) => !add[k].length)) return { state: null, result: null };
    return { state: { ...state, tasks: [...state.tasks, ...add.tasks], projects: [...state.projects, ...add.projects], agents: { agents: [...state.agents.agents, ...add.agents], squads: [...state.agents.squads, ...add.squads] } }, result: null };
  }));
  if (!first.ok) return first;
  if (typeof hooks.betweenCommits === "function") await hooks.betweenCommits({ step: "betweenCommits" });
  const second = await guard(() => run((state, t) => ({ state: { ...state, migrated: { count: total, copied, at: t } }, result: null })));
  if (!second.ok) return second;
  return { ok: true, gen: second.gen, copied, skipped };
}
