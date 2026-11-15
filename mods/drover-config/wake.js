// Canonical copy lives in mods/_lib. Pure: scheduled messages ("wakeups") to an agent or a task's agent.

import { cfg } from "./config.js";

export const WAKE_KEY = "drover.wakeups";
// The defaults (the schema is the source); the policy in force is cfg("drover-wakeups", ...), read on each use so the UI, the Room and the
// CLI (its wake op is added by the inbox handler, i.e. by addWake) all apply the same value. Unbound (pure tests): the defaults.
export const EXPIRES_AFTER = 2 * 60 * 60 * 1000; // a wakeup not delivered 2h after its time expires
const expiresAfter = () => cfg("drover-wakeups", "expiry_hours") * 3600000;
const minEvery = () => cfg("drover-wakeups", "min_repeat_minutes") * 60000;

// "now", "15m", "2h", "1h30m", "1d", "14:30" (today, else tomorrow), "tomorrow 9:00",
// "2026-11-12 09:00" (or with a T). Local time.
export function parseWhen(text, now = Date.now()) {
  const s = String(text ?? "").trim().toLowerCase();
  if (s === "now") return now;
  const rel = parseEvery(s);
  if (rel) return now + rel;
  const clock = (h, m) => +h < 24 && +m < 60;
  const at = s.match(/^(tomorrow\s+)?(\d{1,2}):(\d{2})$/);
  if (at && clock(at[2], at[3])) {
    const d = new Date(now);
    d.setHours(+at[2], +at[3], 0, 0);
    if (at[1]) d.setDate(d.getDate() + 1);
    else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const day = s.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/);
  if (day && clock(day[4], day[5])) {
    const t = new Date(+day[1], +day[2] - 1, +day[3], +day[4], +day[5]).getTime();
    return t > now ? t : null; // a past date is a mistake, not "now"
  }
  return null;
}

// A duration: "30m", "2h", "1h30m", "1d". Milliseconds, or null.
export function parseEvery(text) {
  const m = String(text ?? "").trim().toLowerCase().match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const ms = (((+m[1] || 0) * 24 + (+m[2] || 0)) * 60 + (+m[3] || 0)) * 60000;
  return ms > 0 ? ms : null;
}

export const MIN_EVERY = 5 * 60000; // default: a repeat under 5 min floods an agent

// A weekly time: sched = { time: "HH:MM", days: [0..6] } (0 = Sunday, local time).
// The next time strictly after `after`, or null for a bad schedule. setHours per day keeps it right across DST.
export function nextAt(sched, after = Date.now()) {
  const m = String(sched?.time ?? "").match(/^(\d{1,2}):(\d{2})$/);
  const days = Array.isArray(sched?.days) ? sched.days : [];
  if (!m || +m[1] > 23 || +m[2] > 59 || !days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    d.setHours(+m[1], +m[2], 0, 0);
    if (days.includes(d.getDay()) && d.getTime() > after) return d.getTime();
  }
  return null;
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const sameDays = (days, want) => days.length === want.length && want.every((d) => days.includes(d));

// "Weekdays at 16:00", "Every 15m", "Once, 11/12/2026, 9:30 AM".
export function summary(w) {
  if (w.sched) {
    const days = [...new Set(w.sched.days)].sort((a, b) => a - b);
    const label = days.length === 7 ? "Every day" : sameDays(days, [1, 2, 3, 4, 5]) ? "Weekdays" : sameDays(days, [0, 6]) ? "Weekends" : days.map((d) => DAYS[d]).join(", ");
    const [h, m] = w.sched.time.split(":");
    return `${label} at ${h.padStart(2, "0")}:${m}`;
  }
  return w.every ? `Every ${every(w.every)}` : `Once, ${new Date(w.due).toLocaleString()}`;
}

// The fields of a wakeup that a person sets: who, what, when. Shared by add and edit.
function build({ target, name, when, text, every: rep, sched }, now) {
  const t = String(target ?? "").trim();
  if (!/^T-[A-Z0-9]+$/.test(t) && !/^([a-z0-9-]+\/)?t[0-9a-z]+$/.test(t)) return { error: `Unknown target ${t}: use a terminal (t12) or a task (T-…)` };
  const msg = String(text ?? "").trim();
  if (!msg) return { error: "Message is empty" };
  const repeat = rep ? parseEvery(rep) : null;
  if (rep && !repeat) return { error: `Can't read repeat "${rep}": use 30m, 2h, 1d` };
  if (repeat && repeat < minEvery()) return { error: `Repeat at most every ${minEvery() / 60000}m` };
  let due;
  if (sched) {
    due = nextAt(sched, now);
    if (due == null) return { error: "Pick a time (HH:MM) and at least one day" };
  } else due = when ? parseWhen(when, now) : repeat ? now + repeat : null;
  if (due == null) return { error: `Can't read time "${when}": use now, 15m, 2h, 1d, 14:30, tomorrow 9:00 or 2026-11-12 09:00` };
  const fields = { name: String(name ?? "").trim(), target: t, text: msg, due, expires: due + window(repeat), every: repeat };
  if (sched) fields.sched = { time: sched.time.replace(/^(\d):/, "0$1:"), days: [...new Set(sched.days)].sort((a, b) => a - b) };
  return { fields };
}

export function addWake(list, { source = "you", ...f }, now = Date.now()) {
  const r = build(f, now);
  if (r.error) return r;
  const wake = { id: "W-" + now.toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase(), ...r.fields, status: "scheduled", reason: null, created: now, source, enabled: true };
  return { list: [...list, wake], wake };
}

// Edit one wakeup: new who/what/when and enabled. Keeps id, source, created and the send count; it is scheduled again.
export function updateWake(list, id, { enabled, ...f }, now = Date.now()) {
  const old = list.find((w) => w.id === id);
  if (!old) return { error: "That wakeup is gone" };
  if (old.status === "sending") return { error: "It is sending now: save again in a moment" }; // its pending send would overwrite the edit
  const r = build(f, now);
  if (r.error) return r;
  const { sched: _drop, ...rest } = old;
  const wake = { ...rest, ...r.fields, enabled: enabled ?? old.enabled, status: "scheduled", reason: null };
  return { list: list.map((w) => (w.id === id ? wake : w)), wake };
}

// What to do with a scheduled wakeup now. status: the target agent's status, "running"
// (a terminal without a status), or undefined (gone). Never forces input into a blocked agent.
export function decide(w, status, now = Date.now()) {
  if (w.status !== "scheduled") return { action: "none" };
  if (now < w.due) return { action: "wait", reason: null };
  if (now > w.expires) return w.every || w.sched ? { action: "skip", reason: "Missed: moved to the next time" } : { action: "expire", reason: "Expired before it could be delivered" };
  if (w.enabled === false) return { action: "wait", reason: "Paused" };
  if (!status) return { action: "fail", reason: "Target terminal is gone" };
  if (status === "blocked") return { action: "wait", reason: "Target is blocked: waiting for you" };
  if (status === "working") return { action: "wait", reason: "Target is busy" };
  return { action: "send", reason: null };
}

// A repeat may wait at most until its next time (or the expiry setting); a one-shot waits the expiry setting.
const window = (every) => (every ? Math.min(every, expiresAfter()) : expiresAfter());

// After a repeat was sent or missed: the next time after now, scheduled again.
export function reschedule(list, id, reason, now = Date.now()) {
  return list.map((w) => {
    if (w.id !== id || !(w.every || w.sched)) return w;
    let due;
    if (w.sched) due = nextAt(w.sched, Math.max(now, w.due));
    else {
      due = w.due + w.every;
      if (due <= now) due += Math.ceil((now - due) / w.every) * w.every || w.every;
    }
    if (due == null) return w;
    return { ...w, due, expires: due + window(w.every), status: "scheduled", reason, at: now, count: (w.count ?? 0) + 1 };
  });
}

export const setStatus = (list, id, status, reason, now = Date.now()) =>
  list.map((w) => (w.id === id ? { ...w, status, reason, at: now } : w));

export const setEnabled = (list, id, enabled) => list.map((w) => (w.id === id ? { ...w, enabled } : w));
export const every = (ms) => (ms % 86400000 === 0 ? `${ms / 86400000}d` : ms % 3600000 === 0 ? `${ms / 3600000}h` : `${Math.round(ms / 60000)}m`);
export const isOpen = (w) => w.status === "scheduled" || w.status === "sending";
export const wakeOrder = (a, b) => (isOpen(a) && isOpen(b) ? a.due - b.due : (b.at ?? b.created) - (a.at ?? a.created));

export function until(ms, now = Date.now()) {
  const m = Math.round((ms - now) / 60000);
  return m <= 0 ? "now" : m < 60 ? `in ${m}m` : `in ${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

// Default for a new Once: now + 15m, rounded up to the next 5 minutes.
export const defaultOnce = (now = Date.now()) => Math.ceil((now + 15 * 60000) / 300000) * 300000;

// Display name: the set name, else the first line of the message (cut to 48 chars).
export function wakeName(w) {
  const l = String(w.name || w.text || "").trim().split("\n")[0];
  return l.length > 48 ? `${l.slice(0, 47)}…` : l;
}

// Inbox ops from the drover CLI. Returns { reply } (read, or an error) or { reply, list } (the new list to save).
export function wakeOp(list, cmd, now = Date.now()) {
  if (cmd.op === "wakes") {
    const rows = list.filter((w) => !cmd.target || w.target === cmd.target);
    if (!rows.length) return { reply: `ok: no wakeups${cmd.target ? ` for ${cmd.target}` : ""}` };
    const line = (w) => [w.id, wakeName(w) || "-", w.target, summary(w), isOpen(w) ? until(w.due, now) : "-", w.status, w.enabled === false ? "off" : "on"].join("  ");
    return { reply: [`ok: ${rows.length} wakeups (id, name, target, schedule, next, status, enabled)`, ...rows.map(line)].join("\n") };
  }
  const w = list.find((x) => x.id === cmd.id);
  if (!w) return { reply: `error: no wakeup ${cmd.id} (see: drover wakes)` };
  if (cmd.op === "wake-rm") return { reply: `ok: ${w.id} removed`, list: list.filter((x) => x !== w) };
  const enabled = cmd.op === "wake-on";
  return { reply: `ok: ${w.id} ${enabled ? "enabled" : "disabled"}`, list: setEnabled(list, w.id, enabled) };
}
