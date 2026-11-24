// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// The exec transport of a project bound to another machine (T-MWO2UYPADZC): the laptop reads and writes that machine's board through
// `hc exec --on <machine>` running drover-headless, instead of reading shared.json and dropping files in the inbox.
// Pure logic: the hc runners and the shared-state accessors are injected, and so is the clock (the mod runtime offers no byte or timer helpers).
//  - Reads: version (the ops the remote supports), rev (a poll), tasks + projects only when the rev changed. The cache is { at, tasks, picks, ops, rev, gen }.
//  - Writes: ONE envelope, its JSON on STDIN of the remote program, never in a remote command line or script text (the remote argv holds the verb and nothing else).
//    Limit: the mod host's exec has no stdin option, so on THIS computer the JSON is a local argv item of a local sh (as the inbox's STAGE_SCRIPT does), which pipes it to `hc exec --stdin`.
//    There is no queue: a write on a view that is not fresh, or whose clock is over 30 s away, is refused ("nothing was sent"). A write whose answer is lost keeps its envelope;
//    repeating the same action sends the SAME bytes (the remote's nonce makes that safe).
//  - Every message the UI sees is a fixed text: the remote's stderr and error text are never shown or logged.

import { cacheKey, validMachine, validProjectId, POLL_MS, SLOW_MS, SLOW_AFTER, TIMEOUT_MS, readDelay } from "./remote.js";
import { buildPayload } from "./remote-write.js";

export { POLL_MS, SLOW_MS, SLOW_AFTER, TIMEOUT_MS };
export const HEADLESS = ".local/share/drover-herdr/current/bin/drover-headless"; // relative: hc exec starts in the remote home, so no ~ and no home path
export const SEND_TIMEOUT_MS = 10000;
export const VERSION_MS = 300000; // how long a reported ops list is trusted before it is asked again
export const HELD_MS = 24 * 3600000; // an unanswered envelope is held this long (the remote's nonce retention): it answers a retained nonce with its stored result, and refuses by expiry after
export const SKEW_MAX_MS = 30000; // writes are refused beyond this clock difference, in both directions
export const UI_OPS = ["move", "note", "edit", "add", "archive"];

// An exec project is exactly { transport: "exec" } on its remote binding; anything else is the inbox (the default).
export const transport = (remote) => (remote?.transport === "exec" ? "exec" : "inbox");

// hc args for one headless verb. hc exec runs the program as given (no shell) in the remote home.
export const headlessArgv = (machine, words, timeoutSec = Math.ceil(TIMEOUT_MS / 1000)) => ["exec", "--on", machine, "--timeout", String(timeoutSec), HEADLESS, ...words];
export const verbOf = (op) => [op]; // the verb is the op name; the UI ops are move|note|edit|add|archive

// ---- the remote's ops list drives the controls ----
export function opGate(ops, op) {
  if (!Array.isArray(ops)) return "Not reported yet: the remote machine has not said what it supports";
  return ops.includes(op) ? null : `The remote machine does not support ${op}`;
}
export function skewReason(machine, skew) {
  if (!Number.isFinite(skew)) return `${machine} reports no clock, so exec writes are off: update the machine: drover machines install`; // fail closed: reads stay on
  if (Math.abs(skew) <= SKEW_MAX_MS) return null;
  return `The clock of ${machine} is ${Math.round(Math.abs(skew) / 1000)} s ${skew > 0 ? "ahead of" : "behind"} this computer's (limit ${SKEW_MAX_MS / 1000} s): writes are off`;
}
export const controls = (ops) => Object.fromEntries(UI_OPS.map((o) => [o, opGate(ops, o) === null]));

const parse = (r) => { if (r?.code !== 0) return null; try { const j = JSON.parse(String(r.stdout ?? "")); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; } };
const pickName = (v, id) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : id);
const picksOf = (projects) => ({
  assignees: [], // drover-headless does not report agents: the picker offers none for an exec project
  projects: (Array.isArray(projects) ? projects : []).filter((p) => p && validProjectId(p.id) && !p.remote).map((p) => ({ id: p.id, name: pickName(p.name, p.id) })),
});
const hhmm = (at) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// Is this machine ready to be read over exec, and does it hold the project? -> { ops } or { error } (a fixed text). Used by bind and by the transport flip.
export async function probeExec(run, machine, projectId) {
  const ask = async (words) => { try { return parse(await run(headlessArgv(machine, words), { timeout: TIMEOUT_MS })); } catch { return null; } };
  const v = await ask(["version", "--json"]);
  if (!v || !Array.isArray(v.ops)) return { error: `${machine} did not answer drover-headless (run: drover machines doctor ${machine})` };
  const p = await ask(["projects", "--json"]);
  if (!p || !Array.isArray(p.projects)) return { error: `${machine}'s headless board is unreadable (run: drover machines doctor ${machine})` };
  if (!p.projects.some((x) => x?.id === projectId)) return { error: `${machine}'s headless board has no project ${projectId} (run: drover machines migrate-in ${machine})` };
  return { ops: v.ops.filter((o) => typeof o === "string").slice(0, 32) };
}

// run(args, { timeout }) -> Promise<{ code, stdout, stderr }> (hc). bound(machine, projectId, id) and active() as in remote.js createRemote.
// The surface is createRemote's: sync / suspend / tick / retry / view, plus ops().
export function createExecReader({ run, getShared, setShared, now = Date.now, log = () => {}, bound = () => true, active = () => true }) {
  const entries = new Map(); // cacheKey -> { machine, projectId, id, gen, failures, nextAt, inflight, startedAt, ok, error, ops, opsAt, rev, hgen }
  let genSeed = 0;

  async function ask(machine, words) {
    let r;
    const t0 = now();
    try { r = await run(headlessArgv(machine, words), { timeout: TIMEOUT_MS }); } catch { return { error: "hc failed" }; }
    const mid = (t0 + now()) / 2;
    const j = parse(r);
    if (!j) return { error: r?.code === 0 ? "unreadable answer" : `hc exit ${Number.isInteger(r?.code) ? r.code : "unknown"}` }; // fixed codes, never stderr
    return { j, skew: Number.isFinite(j.now) ? Math.round(j.now - mid) : null }; // the remote's clock against the midpoint of the call
  }

  // One pass: version (when the ops are unknown or old), rev, then tasks + projects when something changed. -> { ops, board } or { error }.
  async function pass(e) {
    const t = now();
    let ops = e.ops;
    let opsAt = e.opsAt;
    if (!ops || t - opsAt > VERSION_MS) {
      const v = await ask(e.machine, ["version", "--json"]);
      if (v.error) return v;
      if (!Array.isArray(v.j.ops)) return { error: "unreadable answer" };
      ops = v.j.ops.filter((o) => typeof o === "string").slice(0, 32); opsAt = t;
    }
    const rv = await ask(e.machine, ["rev", "--json"]);
    if (rv.error) return rv;
    const skew = rv.skew;
    const c = getShared(cacheKey(e.machine, e.projectId));
    const cached = c && typeof c === "object" && Array.isArray(c.tasks);
    if (cached && e.rev === rv.j.tasks && e.hgen === rv.j.gen && !e.stale) return { ops, opsAt, skew, same: true };
    const tk = await ask(e.machine, ["tasks", "--json"]);
    if (tk.error) return tk;
    const pj = await ask(e.machine, ["projects", "--json"]);
    if (pj.error) return pj;
    if (!Array.isArray(tk.j.tasks)) return { error: "unreadable answer" };
    const tasks = tk.j.tasks.filter((x) => x && typeof x === "object" && x.project === e.projectId && !x.archived);
    return { ops, opsAt, skew, board: { tasks, picks: picksOf(pj.j.projects), rev: tk.j.rev, gen: tk.j.gen ?? rv.j.gen } };
  }

  function read(machine, projectId) {
    const key = cacheKey(machine, projectId);
    const e = entries.get(key);
    if (!e) return Promise.resolve({ dropped: true });
    if (e.inflight) return e.inflight;
    const gen = e.gen;
    e.startedAt = now();
    const p = (async () => {
      const res = await pass(e);
      const cur = entries.get(key);
      if (!cur || cur.gen !== gen || !bound(machine, projectId, cur.id) || !active()) { if (cur && cur.gen === gen) cur.inflight = null; return { dropped: true }; }
      cur.inflight = null;
      if (res.error) {
        cur.failures++; cur.ok = false; cur.error = res.error; cur.stale = true;
        cur.nextAt = now() + readDelay(cur.failures);
        log(`remote ${machine}/${projectId}: exec read failed (${res.error}), failures ${cur.failures}`);
        return { error: res.error };
      }
      cur.ops = res.ops; cur.opsAt = res.opsAt; cur.skew = res.skew;
      if (res.board) {
        cur.rev = res.board.rev; cur.hgen = res.board.gen; cur.picks = res.board.picks;
        setShared(key, { at: now(), tasks: res.board.tasks, picks: res.board.picks, ops: cur.ops, skew: cur.skew, rev: res.board.rev, gen: res.board.gen });
      } else {
        const c = getShared(key);
        if (c && typeof c === "object") setShared(key, { ...c, at: now(), ops: cur.ops, skew: cur.skew }); // still current: the cache is as young as this poll
      }
      cur.failures = 0; cur.ok = true; cur.error = null; cur.stale = false;
      cur.nextAt = now() + POLL_MS;
      return { ok: true };
    })();
    const wait = new Promise((resolve) => { e.settle = resolve; p.then(resolve, () => resolve({ error: "read failed" })); });
    e.inflight = wait;
    return wait;
  }

  // Past its deadline a read is abandoned: a new generation drops its late answer, and it counts as one failure. Never awaited by the render.
  function abandon(e) {
    e.gen = ++genSeed; e.inflight = null; e.failures++; e.ok = false; e.error = "timeout"; e.stale = true;
    const s = e.settle; e.settle = null; s?.({ error: "timeout" });
    e.nextAt = now() + readDelay(e.failures);
    log(`remote ${e.machine}/${e.projectId}: exec read timed out, failures ${e.failures}`);
  }
  function drop(key) { const e = entries.get(key); entries.delete(key); setShared(key, null); const s = e?.settle; if (e) e.settle = null; s?.({ error: "detached" }); }
  function sync(list) {
    const want = new Map(list.map((b) => [cacheKey(b.machine, b.projectId), b]));
    for (const [key, b] of want) {
      const e = entries.get(key);
      if (e && e.id !== b.id) drop(key);
      if (!entries.has(key)) {
        const c = getShared(key);
        entries.set(key, { machine: b.machine, projectId: b.projectId, id: b.id, gen: ++genSeed, failures: 0, nextAt: 0, inflight: null, ok: false, error: null, ops: Array.isArray(c?.ops) ? c.ops : null, opsAt: 0, rev: null, hgen: null, stale: true });
      }
    }
    for (const key of [...entries.keys()]) if (!want.has(key)) drop(key);
  }
  function suspend() { for (const e of entries.values()) if (e.inflight) { e.gen = ++genSeed; e.inflight = null; const s = e.settle; e.settle = null; s?.({ dropped: true }); } }
  function tick() {
    const t = now();
    const timedOut = [];
    for (const e of entries.values()) if (e.inflight && t - e.startedAt > TIMEOUT_MS) { abandon(e); timedOut.push({ error: "timeout" }); }
    return Promise.all([...timedOut, ...[...entries.values()].filter((e) => !e.inflight && t >= e.nextAt).map((e) => read(e.machine, e.projectId))]);
  }
  const retry = (machine, projectId) => read(machine, projectId);

  const ops = (machine, projectId) => { const e = entries.get(cacheKey(machine, projectId)); return e?.ok && Array.isArray(e.ops) ? [...e.ops] : null; };

  function view(machine, projectId) {
    const key = cacheKey(machine, projectId);
    const e = entries.get(key);
    const c = getShared(key);
    const have = c && typeof c === "object" && Array.isArray(c.tasks);
    if (!have) return { state: "never", tasks: [], ops: null, skew: null, picks: { assignees: [], projects: [], tags: [], loading: true }, banner: `${machine} has not answered yet`, error: e?.error ?? null };
    const tasks = c.tasks.map((x) => ({ ...x, remote: { machine } }));
    const list = (v) => (Array.isArray(v) ? v : []);
    const src = c.picks && typeof c.picks === "object" ? c.picks : e?.picks ?? null;
    const picks = { assignees: list(src?.assignees), projects: list(src?.projects), ...(src ? {} : { loading: true }), tags: [...new Set(tasks.flatMap((x) => (Array.isArray(x.tags) ? x.tags.filter((g) => typeof g === "string") : [])))].sort() };
    const skew = Number.isFinite(c.skew) ? c.skew : null;
    if (e?.ok) return { state: "fresh", at: c.at, tasks, picks, ops: list(c.ops), skew, banner: null };
    return { state: "stale", at: c.at, tasks, picks, ops: list(c.ops), skew, banner: `${machine} unreachable · last update ${hhmm(c.at)} · showing a saved copy`, error: e?.error ?? null };
  }
  return { sync, suspend, read, tick, retry, view, ops, detach: (machine, projectId) => drop(cacheKey(machine, projectId)) };
}

// ---- the write ----
// Local sh script: $1 the JSON, $2 the machine, $3 hc's timeout in seconds, the rest the remote argv (program, verb). The JSON is piped to hc's stdin.
export const WRITE_SCRIPT = 'p=$1; m=$2; t=$3; shift 3; printf %s "$p" | hc exec --on "$m" --timeout "$t" --stdin "$@"';

const MSG = {
  saved: "saved",
  stale: "card changed on the remote machine",
  expired: "not applied, too old",
  refused: "the remote machine refused it",
  failed: "not applied: the remote machine could not write it",
  unknown: "no answer: not known whether it was applied. Repeat within 24 h to retry safely; after 24 h check the card first",
};
const REFUSED = new Set(["bad-envelope", "nonce-reused", "unknown-op", "refused"]);
// Codes that are only ever returned BEFORE anything is published: the board was not changed. Every other code (E_SYNC, io, any new one) can follow the
// publication of a generation, so it is unknown, never "not applied".
const NOT_APPLIED = new Set(["busy", "board-corrupt", "board-schema", "no-link"]);
// The answer of `hc exec` -> { status: saved|stale|expired|refused|failed|unknown, message, result? }. Nothing of stderr or the remote's error text is kept.
export function classify(r) {
  const out = (status, extra = {}) => ({ status, message: MSG[status], ...extra });
  if (!r || typeof r !== "object") return out("unknown");
  if (r.code === 69) return out("failed", { message: "not applied: Node is not available on the remote machine" });
  if (r.code === 2) return out("failed");
  let j = null;
  try { j = JSON.parse(String(r.stdout ?? "")); } catch { j = null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return out("unknown");
  if (r.code === 0 && j.ok === true) return out("saved", { result: j.result && typeof j.result === "object" ? j.result : {}, replayed: j.replayed === true });
  if (r.code === 1 && j.ok === false && typeof j.code === "string") {
    if (j.code === "stale" || j.code === "expired") return out(j.code);
    if (REFUSED.has(j.code)) return out("refused");
    return out(NOT_APPLIED.has(j.code) ? "failed" : "unknown");
  }
  return out("unknown");
}

const defaultRand = () => Math.random().toString(36).slice(2, 14).padEnd(12, "0");
// exec(cmd, args, { timeout }) -> Promise<{ code, stdout, stderr }>: a LOCAL program (sh). link(machine, projectId) -> { state, ops }: the view of that binding.
// tick() is called by the owner's timer: it ends a wait past SEND_TIMEOUT_MS (a held hc call cannot hold a caller) and drops an old envelope.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v) ?? "null");
export function createExecWriter({ exec, now = Date.now, rand = defaultRand, origin = "L", link = () => ({ state: "never", ops: null }), log = () => {} }) {
  const held = new Map(); // nonce -> { envelope, json, machine, projectId, op, id } : only after "unknown"
  const waits = new Set(); // { at, settle }

  const refuse = (why) => ({ status: "refused", message: `${why}; nothing was sent` });

  async function deliver(entry) {
    const settled = new Promise((resolve) => {
      const w = { at: now(), settle: (r) => { waits.delete(w); resolve(r); } };
      waits.add(w);
      let p;
      try { p = Promise.resolve(exec("sh", ["-c", WRITE_SCRIPT, "drover-send", entry.json, entry.machine, String(Math.ceil(SEND_TIMEOUT_MS / 1000)), HEADLESS, ...verbOf(entry.envelope.op)], { timeout: SEND_TIMEOUT_MS })); } catch { p = Promise.resolve(null); }
      p.then((r) => w.settle(classify(r)), () => w.settle(classify(null)));
    });
    let c = await settled;
    // A re-send of a held envelope that fails without an answer FOR THAT NONCE (a missing Node, a launcher or hc error, busy, a timeout) proves nothing about the
    // original: it stays unknown and held. Only a real answer (saved, replayed, stale, expired, refused) resolves it.
    if (c.status === "failed" && held.has(entry.envelope.nonce)) c = { status: "unknown", message: MSG.unknown };
    if (c.status === "unknown") { held.set(entry.envelope.nonce, entry); log(`remote ${entry.machine}/${entry.projectId}: exec write unanswered, ${entry.envelope.op} held for retry`); }
    else held.delete(entry.envelope.nonce);
    return { ...c, nonce: entry.envelope.nonce, op: entry.envelope.op, ...(entry.id ? { id: entry.id } : {}) };
  }

  async function send(machine, projectId, op, { rev } = {}) {
    if (!validMachine(machine) || !validProjectId(projectId)) return refuse("Bad machine or project");
    const v = link(machine, projectId);
    if (!v || v.state !== "fresh") return refuse(`${machine} is not up to date`);
    const gate = opGate(v.ops, op?.op);
    if (gate) return refuse(gate);
    const sk = skewReason(machine, v.skew);
    if (sk) return refuse(sk);
    const fp = canon([machine, projectId, op]);
    const kept = [...held.values()].find((e) => e.fp === fp); // the same action again after an unknown answer: the retained envelope, so the remote can answer it as a replay
    if (kept) return deliver(kept);
    const b = buildPayload(op, { projectId, rev });
    if (b.error) return refuse(b.error);
    const envelope = { ...b.json, nonce: `${origin}-${rand()}`, issuedAt: now() };
    return deliver({ envelope, json: JSON.stringify(envelope), machine, projectId, id: op.id, fp });
  }
  // The same bytes again: same nonce, same issuedAt. The remote answers a nonce it already applied with its stored result.
  async function retry(nonce) {
    const entry = held.get(nonce);
    if (!entry) return refuse("There is nothing to retry (too old or already answered)");
    return deliver(entry);
  }
  function tick() {
    const t = now();
    for (const w of [...waits]) if (t - w.at > SEND_TIMEOUT_MS) w.settle(classify(null));
    for (const [n, e] of held) if (t - e.envelope.issuedAt > HELD_MS) held.delete(n);
  }
  const pending = () => [...held.values()].map((e) => ({ nonce: e.envelope.nonce, machine: e.machine, projectId: e.projectId, op: e.envelope.op, ...(e.id ? { id: e.id } : {}) }));
  return { send, retry, tick, pending };
}
