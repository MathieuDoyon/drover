// The sync hold: while an install or update of a machine is unfinished, nothing is pushed to any machine. Laptop side, pure Node.
// The hold is an append-only sequence of complete records <dir>/hold.<n>.json (published by publish.js, never replaced, never deleted);
// the newest n (by number: hold.10 beats hold.9) is the truth. State "held" blocks, "cleared" releases. Fields:
// { n, state, machine, token, pid, host, target, since, reason?, note? }. A leftover .tmp-* is never a record.
// A record that cannot be read fails closed: the hold stands until the owner runs `drover machines hold clear --reason <text>`.
import * as nodefs from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { publishExclusive } from "./publish.js";

const RE = /^hold\.(\d+)\.json$/;
const aliveDefault = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
const CLEAR = "drover machines hold clear --reason <text>";
const describe = (r) => `held: ${r.machine} since ${r.since}, run drover machines doctor ${r.machine} (or ${CLEAR})`;
const damagedMessage = (s) => `held: ${s.damaged} is damaged, so the hold stands; once you know no install is running, ${CLEAR}`;

export function createHold({ dir, fs: over, pid = process.pid, host = hostname(), alive = aliveDefault, now = () => new Date().toISOString() } = {}) {
  const fs = { ...nodefs, ...over };
  const numbers = () => { try { return fs.readdirSync(dir).map((f) => RE.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b); } catch (e) { if (e?.code === "ENOENT") return []; throw e; } };
  const read = () => {
    const ns = numbers();
    if (!ns.length) return null;
    const n = ns.at(-1), file = `hold.${n}.json`;
    try {
      const record = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8"));
      if (!record || typeof record !== "object" || !["held", "cleared"].includes(record.state) || record.n !== n) throw new Error("bad record");
      return { n, record };
    } catch { return { n, damaged: file }; }
  };
  const publish = (n, fields) => {
    fs.mkdirSync(dir, { recursive: true });
    const record = { n, ...fields };
    const r = publishExclusive(dir, `hold.${n}.json`, `${JSON.stringify(record)}\n`, { fs: over });
    return r.ok ? { ok: true, record } : { ok: false, reason: "moved" };
  };
  const guarded = (fn) => { try { return fn(); } catch (e) { return { ok: false, reason: "error", message: `held: the sync hold could not be written (${e?.code ?? ""} ${e?.message ?? e}); nothing was pushed` }; } };
  const base = (machine, target, n) => ({ state: "held", machine, token: randomBytes(8).toString("hex"), pid, host, target, since: now() });

  return {
    read,
    acquire({ machine, target }) {
      return guarded(() => {
        const s = read();
        if (s?.damaged) return { ok: false, reason: "damaged", message: damagedMessage(s) };
        const cur = s?.record;
        if (cur?.state === "held") {
          if (cur.host !== host) return { ok: false, reason: "foreign", message: `${describe(cur)}: owned by another host (${cur.host})` };
          if (cur.machine !== machine) return { ok: false, reason: "other-machine", message: describe(cur) };
          if (alive(cur.pid)) return { ok: false, reason: "busy", message: `${describe(cur)}: another installer is running (pid ${cur.pid})` };
        }
        const next = (s?.n ?? 0) + 1;
        const r = publish(next, base(machine, target));
        if (r.ok) return r;
        // someone published `next` first: judge the new newest record, never replace it
        const w = read();
        if (w?.damaged) return { ok: false, reason: "damaged", message: damagedMessage(w) };
        return { ok: false, reason: "busy", message: w?.record ? `${describe(w.record)}: another installer took the hold first` : "held: another installer took the hold first" };
      });
    },
    // The owner of the newest record moves its target (the re-probe changed what is installed).
    retarget(token, target) {
      return guarded(() => {
        const s = read();
        if (!s?.record || s.record.state !== "held" || s.record.token !== token) return { ok: false, reason: "not-owner" };
        const { n: _n, ...rest } = s.record;
        const r = publish(s.n + 1, { ...rest, target, since: now() });
        return r.ok ? r : { ok: false, reason: "moved" };
      });
    },
    // Doctor: release only if the newest record is still the one it judged (expectN). EEXIST = someone moved first: the hold stands.
    clear({ expectN, machine, reason } = {}) {
      return guarded(() => {
        const s = read();
        if (!s || s.n !== expectN || s.damaged) return { ok: false, reason: "moved" };
        const r = publish(s.n + 1, { state: "cleared", machine: machine ?? s.record.machine, token: s.record.token, pid, host, target: s.record.target, since: now(), ...(reason ? { reason } : {}) });
        return r.ok ? r : { ok: false, reason: "moved" };
      });
    },
    // The owner's escape hatch: appends a cleared record whatever the newest one is (held by a gone host, damaged). Deletes nothing.
    clearManual(note) {
      return guarded(() => {
        const ns = numbers();
        if (!ns.length) return { ok: false, reason: "nothing", message: "no hold exists" };
        const s = read();
        if (s?.record?.state === "cleared") return { ok: false, reason: "nothing", message: "the hold is already cleared" };
        const r = publish(ns.at(-1) + 1, { state: "cleared", machine: s?.record?.machine ?? "", token: "manual", pid, host, target: s?.record?.target ?? "", since: now(), reason: "manual", note: String(note ?? "") });
        return r.ok ? r : { ok: false, reason: "moved", message: "another actor moved the hold first; read it again" };
      });
    },
  };
}

// For a pusher: is anything held? `resume` lets the machine that owns the hold through (its own install resuming).
// check-then-act is NOT exclusion: a pusher that must be safe against a concurrent install acquires the hold (see docs/guides/machines.md).
export function pushGuard(hold, { resume } = {}) {
  const s = hold.read();
  if (!s) return { held: false };
  if (s.damaged) return { held: true, message: damagedMessage(s) };
  if (s.record.state !== "held") return { held: false };
  if (resume && s.record.machine === resume) return { held: false };
  return { held: true, message: describe(s.record) };
}
