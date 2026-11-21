// The load hold (T-MWO2HEU32E4, Remote v2 A5): do not START new work on a machine that is already over its limits. Pure ES module, no Herdr import.
// Advisory only: a raw `hc run --on` or a terminal opened by hand bypasses it. It judges only a fresh sample; unknown, failed or stale health
// allows the start and warns (owner decision), so a broken read never blocks work. It never touches a run that is already going.
//   limitsFor(settings, machine)  -> { load, memory, disk }: each { value: number | "off", setting }
//   judge({ sample, ageMs, limits, label }) -> { hold: string | null, warn: string | null }
//   createLocalRead({ exec, now, script, parse }) -> read(): the laptop's own sample, cached 60 s, one read in flight (a local python3, never hc, never --on)
// health.js is not imported (the caller passes the script and the parser): config-schema.js, which ships to remote machines, must not reach this file.
import { HOLD_PATTERNS } from "./config-schema.js";
export { HOLD_PATTERNS };

export const LOCAL = "local"; // the machine name of this computer in hold_machines; a linked machine may not use it
export const STALE_MS = 15 * 60000; // three polls: an older sample is unknown, not a verdict
export const CACHE_MS = 60000;
export const READ_MS = 5000;
export const DEFAULTS = Object.freeze({ load: 1, memory: 80, disk: 90 });
const KEYS = ["load", "memory", "disk"];
const SETTING = { load: "hold_load", memory: "hold_memory", disk: "hold_disk" };

const valueOf = (key, text) => {
  const t = String(text ?? "").trim();
  if (!(key === "load" ? HOLD_PATTERNS.load : HOLD_PATTERNS.percent).test(t)) return undefined;
  return t === "off" ? "off" : Number(t);
};

// "a: memory 85, load off; b: disk 95" -> { a: { memory: 85, load: "off" }, b: { disk: 95 } }. Text that is not whole gives {}.
export function parseOverrides(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t || !HOLD_PATTERNS.machines.test(t)) return {};
  const out = {};
  for (const entry of t.split(";")) {
    if (!entry.trim()) continue;
    const [name, rest] = [entry.slice(0, entry.indexOf(":")).trim(), entry.slice(entry.indexOf(":") + 1)];
    out[name] = { ...(out[name] ?? {}) };
    for (const pair of rest.split(",")) { const [k, v] = pair.trim().split(/\s+/); out[name][k] = valueOf(k, v); }
  }
  return out;
}

// settings: { load, memory, disk, machines } as text (what cfg() returns). A value that does not parse falls back to the default.
export function limitsFor(settings = {}, machine = LOCAL) {
  const over = parseOverrides(settings.machines)[machine] ?? {};
  const limits = {};
  for (const k of KEYS) {
    if (over[k] !== undefined) limits[k] = { value: over[k], setting: "hold_machines", machine, key: k };
    else limits[k] = { value: valueOf(k, settings[k]) ?? DEFAULTS[k], setting: SETTING[k] };
  }
  return limits;
}

const trim = (n, d) => String(Math.round(n * 10 ** d) / 10 ** d);
const fin = (x) => typeof x === "number" && Number.isFinite(x);
// A per-machine limit is part of the hold_machines text: "off" alone is not a valid value there, so the hint names the entry to write.
const hint = (l) => `limit ${l.value}${l.unit ?? ""}; ${l.setting === "hold_machines" ? `to lift it write ${l.machine}: ${l.key} off in drover-runs.hold_machines` : `change drover-runs.${l.setting} or set it to off`}`;

export const unknownWarn = (label) => `${label} health is unknown, start allowed`;

export function judge({ sample, ageMs, limits, label = "this computer" }) {
  if (!sample || !fin(ageMs) || ageMs > STALE_MS) return { hold: null, warn: unknownWarn(label) };
  const found = [];
  const over = (value, limit, text) => { if (limit.value !== "off" && fin(value) && value > limit.value) found.push({ ratio: value / limit.value, text }); };
  over(sample.loadPerCore, limits.load, `load is ${trim(sample.loadPerCore, 2)} per core (${hint(limits.load)})`);
  over(sample.mem?.pct, limits.memory, `memory is ${trim(sample.mem?.pct, 1)}% full (${hint({ ...limits.memory, unit: "%" })})`);
  for (const [name, text] of [["home", "disk home"], ["tmp", "disk /tmp"]]) {
    const p = sample.disks?.[name]?.pct;
    over(p, limits.disk, `${text} is ${trim(p, 1)}% full (${hint({ ...limits.disk, unit: "%" })})`);
  }
  found.sort((a, b) => b.ratio - a.ratio);
  return { hold: found.length ? found.map((f) => f.text).join(" · ") : null, warn: null };
}

// A machine row of the A4 health view. A last-good sample kept after a failure is NOT fresh: only state "fresh" counts.
export function sampleOfRow(row) {
  if (row && row.state === "fresh" && row.numbers && fin(row.ageMs)) return { sample: row.numbers, ageMs: row.ageMs };
  return { sample: null, ageMs: null };
}

export function reservedWarning(names) {
  if (!Array.isArray(names) || !names.includes(LOCAL)) return null;
  return `A linked machine is named "${LOCAL}", the name this computer has in drover-runs.hold_machines: limits for "${LOCAL}" apply to this computer, not to that machine. Rename the machine in hc.`;
}

// The laptop's own health: one local python3, cached CACHE_MS, one read in flight. exec(cmd, args, { timeout }) -> { code, stdout, stderr }.
// A failure is cached too, as an error code only (nothing the process printed is kept), so a broken python3 is not respawned for each start.
export function createLocalRead({ exec, now, script, parse, ttl = CACHE_MS, timeout = READ_MS }) {
  let cached = null, inflight = null;
  const answer = () => ({ sample: cached.sample, error: cached.error, ageMs: now() - cached.at });
  const read = function read() {
    if (cached && now() - cached.at < ttl) return Promise.resolve(answer());
    if (inflight) return inflight;
    inflight = (async () => {
      let r;
      try { r = parse(await exec("python3", ["-c", script], { timeout })); } catch { r = { ok: false, code: "exit" }; }
      cached = { at: now(), sample: r.ok ? r.sample : null, error: r.ok ? null : r.code };
      return answer();
    })().finally(() => { inflight = null; });
    return inflight;
  };
  read.peek = () => (cached ? answer() : null); // the cache only: never a read, never an await
  return read;
}
