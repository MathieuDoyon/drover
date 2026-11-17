// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// Remote project, step 2: the laptop writes to omarchy's drover inbox (T-MWHVWR8TIJB).
// Pure logic: the hc runner and the shared-state accessors are injected. No setTimeout (a mod has none): the owner calls tick() every
// second, and every deadline here is measured on the injected now(). Nothing is ever resent: a request that may have landed stays in
// the pending list until its result (or "outcome unknown") settles it.
import { validMachine, cacheKey } from "./remote.js";

export const TTL_MS = 120000; // every op, including add
export const PROBE_TTL_MS = 30000;
export const PROBE_FRESH_MS = 60000; // writes are on only while the last `ok: protocol N` (N >= 2) is younger than this
export const PROBE_REFRESH_MS = 45000; // re-probe before it goes stale, so the controls do not blink off every minute
export const PROBE_RETRY_MS = 15000;
export const WAIT_MS = 10000; // how long send() waits for the result
export const SEND_TIMEOUT_MS = 10000;
export const RECONCILE_MS = 15000; // a late result is looked for this often
export const ADOPT_MS = 30000; // another writer takes over an entry whose owner has not beaten for this long
export const BEAT_MS = 10000; // how often an owner refreshes its entries
export const UNKNOWN_AFTER_MS = TTL_MS + 3600000;
export const CLEAN_AFTER_MS = 24 * 3600000;
export const SWEEP_MS = 600000; // how often an own staging file that was never renamed is looked for (while writes are on)
export const PENDING_KEY = "drover.remote-writes";
export const INBOX = ".config/herdr-app/data/drover-inbox";
export const OPS = ["move", "note", "edit", "add", "archive"];

// A send is 2 steps, both argv-only: the payload is NEVER in a remote argv or in script text.
//  1. LOCAL: the JSON is an argv item of a local sh (`$1`); `hc file write` streams it to omarchy as a dot-named staging file (the consumer ignores it).
export const STAGE_SCRIPT = 'printf %s "$1" | hc file write --on "$2" "$3"';
//  2. REMOTE: the only shell text that runs on omarchy. The nonce is `$0`; omarchy's clock stamps the final name (the arrival evidence for ttlMs).
export const SEND_SCRIPT = 'd=$HOME/.config/herdr-app/data/drover-inbox; f=$(date +%s)-$0; mv "$d/.$0.tmp" "$d/$f.json" && echo "$f.json"';
export const FIND_SCRIPT = 'l=$(ls "$HOME/.config/herdr-app/data/drover-inbox") || exit 3; printf \'%s\\n\' "$l" | grep -F -- "-$0."'; // exit 3 = the listing failed, 1 = listed and absent
export const LIST_SCRIPT = 'ls "$HOME/.config/herdr-app/data/drover-inbox"';
export const FIND_TMP_SCRIPT = 'find "$HOME/.config/herdr-app/data/drover-inbox" -maxdepth 1 -name ".L$0-*.tmp" -mmin +10 -printf "%f\\n"'; // $0 = our origin
export const RM_SCRIPT = 'rm -- "$HOME/.config/herdr-app/data/drover-inbox/$0"';

const COLUMNS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const validId = (s) => typeof s === "string" && /^T-[A-Z0-9]+$/.test(s);
const validOrigin = (s) => typeof s === "string" && /^[A-Za-z0-9]{1,16}$/.test(s);
export const validNonce = (s) => typeof s === "string" && /^L[A-Za-z0-9]{1,16}-[A-Za-z0-9]{12}$/.test(s);
const PRIORITY_IDS = ["P0", "P1", "P2", "P3"];
const validRemoteProject = (s) => typeof s === "string" && /^P-[A-Z0-9]+$/.test(s);
// Strict, like the consumer: a value is valid or the whole request is not sent. {kind,id} is copied, never the caller's object.
const assigneeOf = (a) => (a === "none" ? { value: "none" } : a && typeof a === "object" && (a.kind === "agent" || a.kind === "squad") && typeof a.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(a.id) ? { value: { kind: a.kind, id: a.id } } : { error: "Bad assignee" });
// Fields only a protocol-3 consumer understands: an older one ignores them and still answers `ok`.
export const FIELDS_TIP = (machine) => `${machine} needs the update for priority, labels, assignee, parent and project`;
export const needsFields = (op) => (op?.op === "edit" ? ["priority", "tags", "assignee", "parent", "project"].some((k) => op[k] !== undefined) : op?.op === "add" ? op.assignee !== undefined || op.parent !== undefined : false);
const str = (v, max = 20000) => typeof v === "string" && v.length <= max;

// The op the UI asks for -> the inbox JSON, or { error }. Only op fields: nothing else from the caller is copied.
export function buildPayload(op, { projectId, rev }) {
  if (!op || !OPS.includes(op.op)) return { error: `${op?.op ?? "that op"} is not allowed from here` };
  if (op.op === "add") {
    if (!str(op.title, 500) || !op.title.trim()) return { error: "A title is required" };
    if (op.desc !== undefined && !str(op.desc)) return { error: "Bad description" };
    if (op.column !== undefined && !COLUMNS.includes(op.column)) return { error: "Bad column" };
    if (op.priority !== undefined && !["P0", "P1", "P2", "P3"].includes(op.priority)) return { error: "Bad priority" };
    if (op.tags !== undefined && !(Array.isArray(op.tags) && op.tags.every((t) => str(t, 100)))) return { error: "Bad tags" };
    const extra = {};
    if (op.assignee !== undefined) { const a = assigneeOf(op.assignee); if (a.error) return a; extra.assignee = a.value; }
    if (op.parent !== undefined) { if (!validId(op.parent)) return { error: "Bad parent" }; extra.parent = op.parent; }
    return { json: { op: "add", title: op.title, desc: op.desc ?? "", tags: op.tags ?? [], column: op.column ?? "backlog", priority: op.priority ?? "P2", project: projectId, ...extra, ttlMs: TTL_MS } };
  }
  if (!validId(op.id)) return { error: "Bad card id" };
  const head = { op: op.op, id: op.id };
  if (op.op === "move") {
    if (!COLUMNS.includes(op.column)) return { error: "Bad column" };
    head.column = op.column;
  } else if (op.op === "note") {
    if (!str(op.text) || !op.text.trim()) return { error: "A note needs text" };
    head.text = op.text;
    if (op.kind !== undefined) { if (!["decision", "log", "blocker", "pr", "handoff"].includes(op.kind)) return { error: "Bad note kind" }; head.kind = op.kind; }
  } else if (op.op === "edit") {
    if (!["title", "desc", "priority", "tags", "assignee", "parent", "project"].some((k) => op[k] !== undefined)) return { error: "Nothing to change" };
    if (op.title !== undefined) { if (!str(op.title, 500) || !op.title.trim()) return { error: "Bad title" }; head.title = op.title; }
    if (op.desc !== undefined) { if (!str(op.desc)) return { error: "Bad description" }; head.desc = op.desc; }
    if (op.priority !== undefined) { if (!PRIORITY_IDS.includes(op.priority)) return { error: "Bad priority" }; head.priority = op.priority; }
    if (op.tags !== undefined) { if (!(Array.isArray(op.tags) && op.tags.every((t) => str(t, 100)))) return { error: "Bad tags" }; head.tags = op.tags; }
    if (op.assignee !== undefined) { const a = assigneeOf(op.assignee); if (a.error) return a; head.assignee = a.value; }
    if (op.parent !== undefined) { if (op.parent !== "none" && !validId(op.parent)) return { error: "Bad parent" }; head.parent = op.parent; }
    if (op.project !== undefined) { if (op.project !== "none" && !validRemoteProject(op.project)) return { error: "Bad project" }; head.project = op.project; }
  }
  return { json: { ...head, ifRev: rev, ttlMs: TTL_MS } };
}

// The text of a result file -> { status, message }.
export function classify(text) {
  const t = String(text ?? "").trim();
  const first = t.split("\n")[0].slice(0, 200);
  if (/^ok:/.test(t)) return { status: "saved", message: "saved", text: first };
  if (/^error:\s*stale\b/.test(t)) return { status: "stale", message: "card changed on omarchy", text: first };
  if (/^error:\s*expired\b/.test(t)) return { status: "expired", message: "not applied, too old", text: first };
  if (/^error:/.test(t)) return { status: "error", message: first.replace(/^error:\s*/, "") || "error", text: first };
  return { status: "error", message: "unexpected answer from the machine", text: first };
}

const nameRe = (nonce) => new RegExp(`^(\\d{9,11})-${nonce}\\.(json|result)$`);
const listed = (r) => r && (r.code === 0 || (r.code === 1 && !String(r.stdout ?? "").trim()));
const lines = (r) => String(r?.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);

// run(args, { timeout }) -> Promise<{ code, stdout, stderr }>; exec(cmd, args, { timeout }) the same, local. Neither is trusted to return: every
// deadline below is the writer's own (tick() on the injected now()), so a held hc call cannot hold a caller, a tick or the freeze forever.
// link(machine, projectId) -> { writes: boolean, state: "fresh" | "stale" | "never" } (the binding setting and the board's freshness).
// writable(machine): does any binding to that machine have writes on? Off everywhere: nothing is sent to it, not even the protocol probe.
// reload(machine, projectId): re-read the board now. onOutcome(o): a result that arrives with nobody waiting for it.
// Several writers (one per mod copy) share the pending list: each entry has an `owner` (the writer that sent it) and a `beat` the owner
// refreshes; only the owner works on it, and another writer adopts it only when the beat is older than ADOPT_MS (the owner is gone).
export function createWriter({ run, exec, getShared, setShared, now = Date.now, rand = defaultRand, origin, instance = defaultRand(), link = () => ({ writes: true, state: "fresh" }), writable = () => true, reload = () => {}, onOutcome = () => {}, log = () => {} }) {
  if (!validOrigin(origin)) throw new Error("origin: letters and digits only (1-16)");
  const probes = new Map(); // machine -> { ok, at, reason, inflight, tryAt, gen, seq, cur, wasWritable }
  const waiters = new Map(); // nonce -> { resolve, deadline }   (this writer's callers only)
  const timers = new Set(); // { deadline, resolve }: the writer's own clock for hc calls; tick() fires the due ones
  const checking = new Set(); // nonces with a look in progress

  const pending = () => { const v = getShared(PENDING_KEY); return Array.isArray(v) ? v : []; };
  const save = (list) => setShared(PENDING_KEY, list.length ? list : null);
  const entryOf = (nonce) => pending().find((e) => e.nonce === nonce);
  const patch = (nonce, fields) => save(pending().map((e) => (e.nonce === nonce ? { ...e, ...fields } : e)));
  const drop = (nonce) => save(pending().filter((e) => e.nonce !== nonce));
  const mine = (e) => e.owner === instance;
  const probeOf = (machine) => { let p = probes.get(machine); if (!p) probes.set(machine, (p = { ok: false, level: 0, at: null, reason: null, inflight: false, tryAt: null, gen: 0, seq: 0, cur: 0, wasWritable: true })); return p; };
  // A send that may still reach the rename (any copy's): its owner is beating and its hc call has not returned (an abandoned call counts, with no
  // age cut-off), or the owner went silent and another writer adopted it: that one counts for 2 x ttl after the adoption (`inflightUntil`), since
  // adoption moves the reconciliation, it does not prove the call ended. This status serves the freeze switch; deploy/omarchy/drain-check.sh stays
  // the authoritative gate before a rollback.
  const ttlOf = (e) => e.ttlMs ?? TTL_MS;
  const sending = (machine) => pending().filter((e) => e.machine === machine && ((e.state === "sending" && now() - (e.beat ?? e.at) < 2 * ttlOf(e)) || (e.inflightUntil ?? 0) > now())).length;

  // A bounded look: the answer, or null after SEND_TIMEOUT_MS on the writer's clock (or on an error). The late answer is ignored.
  function look(fn) {
    return new Promise((resolve) => {
      const t = { deadline: now() + SEND_TIMEOUT_MS, resolve: () => resolve(null) };
      timers.add(t);
      Promise.resolve().then(fn).then((v) => { if (timers.delete(t)) resolve(v ?? null); }, () => { if (timers.delete(t)) resolve(null); });
    });
  }
  const lookRun = (args) => look(() => run(args, { timeout: SEND_TIMEOUT_MS }));

  function newNonce() {
    const taken = new Set(pending().map((e) => e.nonce));
    for (let i = 0; i < 20; i++) {
      const n = `L${origin}-${rand()}`;
      if (!validNonce(n)) throw new Error("nonce: bad charset");
      if (!taken.has(n)) return n;
    }
    throw new Error("nonce: could not make a unique one");
  }

  // ---- the gate ----
  function canWrite(machine, projectId) {
    if (!validMachine(machine)) return { ok: false, reason: "Bad machine name" };
    const l = link(machine, projectId);
    if (l.writes === false) return { ok: false, readonly: true, reason: `This project is read-only here (writes are off for ${machine})` };
    if (l.state !== "fresh") return { ok: false, reason: `${machine} unreachable · showing a saved copy · nothing was sent` };
    const p = probeOf(machine);
    if (p.at !== null && !p.ok) return { ok: false, reason: p.reason ?? `${machine} needs the update` };
    if (!p.ok || p.at === null || now() - p.at >= PROBE_FRESH_MS) { if (!p.inflight) void probe(machine); return { ok: false, reason: `Checking ${machine}, try again in a moment` }; }
    return { ok: true };
  }
  // The field controls (Priority, Labels, Assignee, Parent, Project): { on, tip }. On only while writes are on AND the fresh probe said protocol 3.
  function fields(machine, projectId) {
    const g = canWrite(machine, projectId);
    if (!g.ok) return { on: false, tip: g.reason };
    return probeOf(machine).level >= 3 ? { on: true, tip: null } : { on: false, tip: FIELDS_TIP(machine) };
  }
  // Frozen: writes are off AND no send from any copy is still travelling (read from the shared pending list).
  const frozen = (machine, projectId) => link(machine, projectId).writes === false && sending(machine) === 0;

  // ---- one delivery ----
  // Records the nonce in pending BEFORE the exec. Resolves { nonce, sent } | { failed } (step 1 failed: the only proof nothing applied) |
  // { abandoned } (SEND_TIMEOUT_MS passed with hc still running: the flow goes on in the background and patches the entry when it returns).
  // One payload-free line per failed step (which step, exit code, how long, the first 80 chars of stderr): it names the cause of an orphan next time.
  // No stderr and no message (external free text): the exit code (a number) or an allowlisted error code of a thrown error.
  const CAUSES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT", "EHOSTUNREACH", "ENETUNREACH", "ABORT_ERR"]);
  const causeOf = (r, err) => (err !== undefined ? `threw:${CAUSES.has(String(err?.code ?? "").toUpperCase()) ? String(err.code).toUpperCase() : "other"}` : Number.isInteger(r?.code) ? `code:${r.code}` : "none");
  const failLog = (step, r, since, err) => { try { log(`remote-write ${step} failed: ${causeOf(r, err)} ms=${now() - since}`); } catch {} };
  function deliver(machine, projectId, json, meta) {
    const nonce = newNonce();
    const t0 = now();
    save([...pending(), { nonce, machine, projectId, op: json.op, id: json.id ?? null, at: t0, beat: t0, owner: instance, ttlMs: json.ttlMs, name: null, state: "sending", next: 0, ...meta }]);
    const flow = (async () => {
      let st = null;
      let err;
      try { st = await exec("sh", ["-c", STAGE_SCRIPT, "drover-send", JSON.stringify(json), machine, `${INBOX}/.${nonce}.tmp`], { timeout: SEND_TIMEOUT_MS }); } catch (e) { st = null; err = e ?? {}; }
      if (st?.code !== 0) { // step 1 failed: nothing was renamed, so nothing can be applied. The file may still have landed: remove it now, the sweep gets what this misses.
        failLog("stage", st, t0, err);
        const e = entryOf(nonce);
        drop(nonce);
        void removeResult(machine, `.${nonce}.tmp`);
        if (e?.abandoned) finish(nonce, { nonce, machine, projectId, op: e.op, id: e.id, probe: Boolean(e.probe), status: "failed", message: "not sent: nothing was applied" }, e.probe);
        return { nonce, sent: false, failed: true };
      }
      let r = null;
      const t1 = now();
      let err2;
      try { r = await run(["exec", "--on", machine, "sh", "-c", SEND_SCRIPT, nonce], { timeout: SEND_TIMEOUT_MS }); } catch (e) { r = null; err2 = e ?? {}; }
      if (r?.code !== 0) failLog("rename", r, t1, err2);
      const name = r?.code === 0 ? String(r.stdout ?? "").trim() : "";
      if (nameRe(nonce).test(name) && name.endsWith(".json")) { patch(nonce, { name: name.replace(/\.json$/, ""), state: "sent", abandoned: false, inflightUntil: 0 }); return { nonce, sent: true }; }
      patch(nonce, { state: "unsure", abandoned: false, inflightUntil: 0 }); // the reply is missing: the rename may or may not have happened
      return { nonce, sent: false };
    })();
    const tm = { deadline: t0 + SEND_TIMEOUT_MS, resolve: () => {} };
    const early = new Promise((res) => { tm.resolve = () => { if (entryOf(nonce)) patch(nonce, { abandoned: true, next: now() + RECONCILE_MS }); res({ nonce, sent: false, abandoned: true }); }; });
    timers.add(tm);
    return Promise.race([flow, early]).finally(() => timers.delete(tm));
  }

  const pendingOutcome = (nonce) => { const x = entryOf(nonce); return { status: "pending", message: "sent, may still apply", nonce, op: x?.op, id: x?.id ?? null, probe: Boolean(x?.probe) }; };
  // The caller waits for the result until the send started + WAIT_MS (tick() fires it); a miss leaves the entry pending.
  function waitFor(nonce) {
    const e = entryOf(nonce);
    return new Promise((resolve) => { waiters.set(nonce, { resolve, deadline: (e?.at ?? now()) + WAIT_MS }); });
  }

  async function send(machine, projectId, op) {
    if (!OPS.includes(op?.op)) return refuse(`${op?.op ?? "That op"} is not allowed from here`);
    const g = canWrite(machine, projectId);
    if (!g.ok) return refuse(g.reason);
    if (needsFields(op) && probeOf(machine).level < 3) return refuse(FIELDS_TIP(machine)); // an older consumer would answer ok and ignore them
    let rev = 0;
    if (op.op !== "add") {
      const c = getShared(cacheKey(machine, projectId));
      const t = c && Array.isArray(c.tasks) ? c.tasks.find((x) => x?.id === op.id) : null;
      if (!t) return refuse("That card is not in the saved copy: reload the board");
      rev = Number.isSafeInteger(t.rev) && t.rev >= 0 ? t.rev : 0;
      if (op.ifRev !== undefined) { // the rev the editor opened the card at: a change since then is stale, not only a change since the last poll
        if (!(Number.isSafeInteger(op.ifRev) && op.ifRev >= 0)) return refuse("Bad revision");
        rev = op.ifRev;
      }
    }
    const b = buildPayload(op, { projectId, rev });
    if (b.error) return refuse(b.error);
    return outcomeOf(await deliver(machine, projectId, b.json, {}));
  }
  // Wait for the result (driven by tick()). A lost reply is looked into at once; absence alone settles nothing.
  async function outcomeOf(d) {
    if (d.failed) return { status: "failed", message: "not sent: nothing was applied", nonce: d.nonce };
    if (d.abandoned) return pendingOutcome(d.nonce);
    const w = waitFor(d.nonce);
    if (!d.sent) {
      const e = entryOf(d.nonce);
      if (e) { // recovery never holds the caller past the end-to-end deadline: it goes on in the background and reconciles later
        const tm = { deadline: e.at + WAIT_MS, resolve: () => {} };
        const cut = new Promise((res) => { tm.resolve = res; });
        timers.add(tm);
        try { await Promise.race([check(e), cut]); } finally { timers.delete(tm); }
      }
      if (waiters.delete(d.nonce)) { patch(d.nonce, { next: now() + RECONCILE_MS }); return pendingOutcome(d.nonce); }
    }
    return w;
  }
  const refuse = (message) => ({ status: "refused", message });

  // ---- the protocol probe ----
  // One at a time per machine; each carries the connection generation it was sent for. reconnect() bumps it: an older probe's answer is dropped.
  async function runProbe(machine, p) {
    const gen = p.gen, token = ++p.seq;
    p.cur = token; p.inflight = true; p.tryAt = now();
    let o;
    try { o = await outcomeOf(await deliver(machine, null, { op: "protocol", ttlMs: PROBE_TTL_MS }, { probe: true })); } finally { if (p.cur === token) p.inflight = false; }
    if (p.gen !== gen) return; // an answer from a previous connection proves nothing about this one
    if (o.status === "pending" || o.status === "failed") { p.ok = false; p.reason = `${machine} did not answer the check`; return; } // not an answer: `at` stays
    p.at = now();
    const m = /^ok: protocol (\d{1,3})$/.exec(String(o.text ?? ""));
    p.level = m ? Number(m[1]) : 0; // 2 = basic writes, 3 = also priority, tags, assignee, parent, project
    p.ok = p.level >= 2;
    p.reason = p.ok ? null : `${machine} needs the update`;
  }
  async function probe(machine) {
    if (!validMachine(machine) || !writable(machine)) return;
    const p = probeOf(machine);
    if (p.inflight) return;
    await runProbe(machine, p);
  }
  // The hc connection came back (or the binding changed): the old answer says nothing about this connection, and a probe in flight is for the old one.
  function reconnect(machine) {
    if (!validMachine(machine)) return;
    const p = probeOf(machine);
    p.gen++; p.ok = false; p.level = 0; p.at = null; p.reason = null;
    if (writable(machine)) void runProbe(machine, p); else p.wasWritable = false; // read-only: sends nothing; probes the moment writes are on
  }

  // ---- settling ----
  const gone = (e, status, message) => ({ nonce: e.nonce, machine: e.machine, projectId: e.projectId, op: e.op, id: e.id, probe: Boolean(e.probe), status, message });
  function settle(e, text, readName) {
    const c = classify(text);
    const o = { nonce: e.nonce, machine: e.machine, projectId: e.projectId, op: e.op, id: e.id, probe: Boolean(e.probe), ...c };
    drop(e.nonce);
    if (!e.probe && c.status === "stale") reload(e.machine, e.projectId);
    if (readName) void removeResult(e.machine, readName);
    finish(e.nonce, o, e.probe);
    return o;
  }
  function finish(nonce, o, quiet) {
    const w = waiters.get(nonce);
    if (w) { waiters.delete(nonce); w.resolve(o); } else if (!quiet) onOutcome(o);
  }
  async function removeResult(machine, resultName) { // a result file, or an own staging file (the name is charset-checked, then it is `$0`)
    if (!validMachine(machine) || !(/^\d{9,11}-L[A-Za-z0-9]{1,16}-[A-Za-z0-9]{12}\.result$/.test(resultName) || /^\.L[A-Za-z0-9]{1,16}-[A-Za-z0-9]{12}\.tmp$/.test(resultName))) return;
    await lookRun(["exec", "--on", machine, "sh", "-c", RM_SCRIPT, resultName]); // best effort: the 24 h cleanup gets what this misses
  }

  // One look at one pending entry. Returns true when it settled. Absence of the file never settles it (the consumer unlinks the request
  // before it writes the result); only a result, or the unknown deadline, does.
  async function check(e) {
    if (checking.has(e.nonce)) return false;
    checking.add(e.nonce);
    try {
      if (now() - e.at > (e.ttlMs ?? TTL_MS) + (e.probe ? 60000 : 3600000)) {
        drop(e.nonce); finish(e.nonce, gone(e, "unknown", "outcome unknown: check the card on omarchy"), e.probe);
        void removeResult(e.machine, `.${e.nonce}.tmp`); // a rename that never ran left its staging file
        return true;
      }
      let name = e.name;
      if (!name) { // the reply was lost: find the file by its nonce
        const r = await lookRun(["exec", "--on", e.machine, "sh", "-c", FIND_SCRIPT, e.nonce]);
        if (!listed(r)) return false; // exit 3 / other: the listing failed, which says nothing
        const hit = lines(r).map((n) => nameRe(e.nonce).exec(n)).filter(Boolean);
        if (!hit.length) return false;
        name = hit[0][1] + "-" + e.nonce;
        if (entryOf(e.nonce)) patch(e.nonce, { name, state: "sent" });
      }
      const r = await lookRun(["file", "read", "--on", e.machine, `${INBOX}/${name}.result`]);
      if (r?.code !== 0 || !entryOf(e.nonce)) return false;
      settle(e, String(r.stdout ?? ""), `${name}.result`);
      return true;
    } finally { checking.delete(e.nonce); }
  }

  // The owner's timer (every second). Not awaited by the owner: a held hc call never blocks the next tick.
  async function tick() {
    const t = now();
    for (const x of [...timers]) if (t >= x.deadline) { timers.delete(x); x.resolve(); } // hc calls past their deadline
    for (const [nonce, w] of [...waiters]) if (t >= w.deadline) { waiters.delete(nonce); w.resolve(pendingOutcome(nonce)); if (entryOf(nonce)) patch(nonce, { next: now() + RECONCILE_MS }); }
    // Ownership: refresh our beats; adopt entries whose owner stopped beating (an interrupted send becomes "unsure").
    let list = pending(), dirty = false;
    list = list.map((e) => {
      if (mine(e)) { if (t - (e.beat ?? 0) >= BEAT_MS) { dirty = true; return { ...e, beat: t }; } return e; }
      if (t - (e.beat ?? 0) > ADOPT_MS) { dirty = true; return { ...e, owner: instance, beat: t, abandoned: false, state: e.state === "sending" ? "unsure" : e.state, inflightUntil: e.state === "sending" ? t + 2 * ttlOf(e) : e.inflightUntil, next: 0 }; }
      return e;
    });
    if (dirty) save(list);
    const jobs = [];
    for (const e of list) {
      if (!mine(e) || (e.state === "sending" && !e.abandoned)) continue; // foreign (its owner is alive), or still travelling
      if (waiters.has(e.nonce)) jobs.push(check(e));
      else if (t >= (e.next ?? 0)) { patch(e.nonce, { next: t + RECONCILE_MS }); jobs.push(check(e)); }
    }
    for (const [machine, p] of probes) {
      const answered = p.at !== null;
      const old = answered && t - p.at >= PROBE_REFRESH_MS;
      const retry = !p.ok && (p.tryAt === null || t - p.tryAt >= PROBE_RETRY_MS) && !answered;
      if (!writable(machine)) { p.wasWritable = false; continue; } // writes off everywhere for this machine: not even a probe
      if (!p.wasWritable) { p.wasWritable = true; if (!p.inflight) { void runProbe(machine, p); continue; } } // writes just turned on: probe now
      if (!p.inflight && (old || retry)) void probe(machine); // its answer comes on a later tick: never awaited here
    }
    for (const [machine] of probes) { // a staging file left by a failed step: reaped within minutes, not only at a reconnect
      if (!writable(machine) || now() - (swept.get(machine) ?? 0) < SWEEP_MS) continue;
      swept.set(machine, now());
      jobs.push(sweepTmp(machine));
    }
    await Promise.all(jobs);
  }

  // At each reconnect: remove this origin's own results older than 24 h. Foreign names, young ones, and anything still pending stay.
  async function cleanup(machine) {
    if (!validMachine(machine)) return { removed: 0 };
    const r = await lookRun(["exec", "--on", machine, "sh", "-c", LIST_SCRIPT]);
    if (r?.code !== 0) return { removed: 0 };
    const own = new RegExp(`^(\\d{9,11})-(L${origin}-[A-Za-z0-9]{12})\\.result$`);
    const keep = new Set(pending().map((e) => e.nonce));
    let removed = 0;
    for (const n of lines(r)) {
      const m = own.exec(n);
      if (!m || keep.has(m[2]) || now() - Number(m[1]) * 1000 <= CLEAN_AFTER_MS) continue;
      await removeResult(machine, n); removed++;
    }
    return sweepTmp(machine, removed);
  }
  const swept = new Map(); // machine -> last sweep start
  // Staging files that never got renamed: only our own origin, only past 10 min (server-side -mmin), never one still pending.
  async function sweepTmp(machine, removed = 0) {
    swept.set(machine, now());
    const keep = new Set(pending().map((e) => e.nonce));
    const t = await lookRun(["exec", "--on", machine, "sh", "-c", FIND_TMP_SCRIPT, origin]);
    if (t?.code === 0) {
      const tmp = new RegExp(`^\\.L${origin}-([A-Za-z0-9]{12})\\.tmp$`);
      for (const n of lines(t)) {
        const m = tmp.exec(n);
        if (!m || keep.has(`L${origin}-${m[1]}`)) continue;
        await removeResult(machine, n); removed++;
      }
    }
    return { removed };
  }

  return { send, canWrite, fields, probe, reconnect, tick, cleanup, frozen, inflight: sending, pending };
}

function defaultRand() {
  let s = "";
  while (s.length < 12) s += Math.random().toString(36).slice(2);
  return s.slice(0, 12);
}
