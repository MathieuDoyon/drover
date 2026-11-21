// Machine health poller: one cached read per linked machine, polled on a timer and never from a render.
// Pure: no Herdr import, no timers of its own. The runner, the machine list, the clock and the on/off switches are injected.
//   createHealth({ list, exec, now, enabled, active }) -> { tick, view, retry }
//     list()    -> Promise<[{ name, state }]>   the LOCAL machine list (`hc machine ls --json`); state "connected" means linked and up
//     exec(argv)-> Promise<{ code, stdout, stderr }>   runs `hc <argv>`; the real call carries its own 20 s timeout, so it always settles
//     now()     -> ms                           the clock
//     enabled() -> boolean                      the machine_polling setting (off = no exec at all; the list call still runs)
//     active()  -> boolean                      the owning screen is on (off = no list, no exec)
//   tick()  starts what is due and abandons what is past its deadline; returns at once (no promise, no timer)
//   view()  the cache only, copied: { polling, listState: "none"|"ok"|"unknown", machines: [{ name, link, state, numbers, ageMs, error, errorText }] }
//   retry(name?)  make a failed machine due now
// A read in flight carries a generation: an answer that finds a newer generation, polling off, the screen off or the machine gone is dropped.
// Physical occupancy is a per-machine token kept OUTSIDE the entry and released only when that exec's promise settles, so switch-off, removal and
// re-add (and the tick's abandon at the deadline) never allow a second exec while the first is still running.
import { validMachine } from "./remote.js";

export const HEALTH_PY = String.raw`# Machine health: one JSON object on stdout, numbers or null, nothing else. python3 standard library only.
# Run by hand:  python3 drover-health.py      (or by the laptop: hc exec --on <machine> -- python3 -c "<this text>")
# Shape: {"v":1,"os":"linux|darwin|other","cores":N,"load":{"one","five","fifteen"},"loadPerCore":x,
#         "mem":{"totalMb","usedMb","pct"},"disks":{"home":{"totalMb","freeMb","pct"},"tmp":{...}}}
# A field that cannot be read is null, never a guess. No name, path or environment value is ever printed.
import json
import math
import os
import subprocess
import sys

TMP_DIR = "/tmp"  # the literal directory, not $TMPDIR
MB = 1048576


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) and x >= 0 else None


def _pct(part, whole):
    return round(100.0 * part / whole, 1) if whole else None


def parse_loadavg(text):
    try:
        p = text.split()[:3]
    except AttributeError:
        return None
    v = [_num(x) for x in p]
    if len(v) < 3 or None in v:
        return None
    return {"one": round(v[0], 2), "five": round(v[1], 2), "fifteen": round(v[2], 2)}


def _mem(total_bytes, avail_bytes):
    if total_bytes is None or avail_bytes is None or total_bytes <= 0:
        return None
    used = max(0.0, total_bytes - avail_bytes)
    return {"totalMb": int(round(total_bytes / MB)), "usedMb": int(round(used / MB)), "pct": min(100.0, _pct(used, total_bytes))}


def parse_meminfo(text):
    kb = {}
    try:
        lines = text.splitlines()
    except AttributeError:
        return None
    for line in lines:
        k, _, rest = line.partition(":")
        w = rest.split()
        if w and k in ("MemTotal", "MemAvailable"):
            kb[k] = _num(w[0])
    t, a = kb.get("MemTotal"), kb.get("MemAvailable")
    return _mem(None if t is None else t * 1024, None if a is None else a * 1024)


def parse_vm_stat(text, memsize):
    try:
        lines = text.splitlines()
        total = _num(memsize.strip())
        head = lines[0]
        a = head.index("page size of ") + len("page size of ")
        page = _num(head[a:].split()[0])
    except (AttributeError, ValueError, IndexError):
        return None
    if not page or not total:
        return None
    pages = {}
    for line in lines[1:]:
        k, _, rest = line.partition(":")
        w = rest.strip().rstrip(".")
        if k in ("Pages free", "Pages inactive", "Pages speculative"):
            pages[k] = _num(w)
    if len(pages) < 3 or None in pages.values():
        return None
    return _mem(total, sum(pages.values()) * page)


def _disk(usage, path):
    try:
        total, free = usage(path)
    except (OSError, ValueError, TypeError):
        return None
    if not total or total <= 0 or free < 0:
        return None
    return {"totalMb": int(total // MB), "freeMb": int(free // MB), "pct": _pct(total - free, total)}


def _read(path):
    with open(path, "r") as f:
        return f.read()


def _run(argv):
    r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, universal_newlines=True)
    if r.returncode != 0:
        raise OSError("exit")
    return r.stdout


def _du(path):
    u = os.statvfs(path)
    return u.f_frsize * u.f_blocks, u.f_frsize * u.f_bavail


def sample(plat, read_file=_read, sysctl=None, vm_stat=None, getloadavg=os.getloadavg, cpu_count=os.cpu_count, disk_usage=_du, home=None):
    sysctl = sysctl or (lambda name: _run(["sysctl", "-n", name]))
    vm_stat = vm_stat or (lambda: _run(["vm_stat"]))

    def safe(fn, *a):
        try:
            return fn(*a)
        except Exception:
            return None

    kind = "linux" if plat.startswith("linux") else "darwin" if plat == "darwin" else "other"
    cores = safe(cpu_count)
    cores = cores if isinstance(cores, int) and cores > 0 else None
    if kind == "linux":
        load = parse_loadavg(safe(read_file, "/proc/loadavg"))
        mem = parse_meminfo(safe(read_file, "/proc/meminfo"))
    else:
        la = safe(getloadavg)
        load = parse_loadavg(" ".join(str(x) for x in la)) if la else None
        mem = parse_vm_stat(safe(vm_stat), safe(sysctl, "hw.memsize")) if kind == "darwin" else None
    return {
        "v": 1,
        "os": kind,
        "cores": cores,
        "load": load,
        "loadPerCore": round(load["one"] / cores, 2) if load and cores else None,
        "mem": mem,
        "disks": {"home": _disk(disk_usage, home) if home else None, "tmp": _disk(disk_usage, TMP_DIR)},
    }


def main():
    try:
        out = json.dumps(sample(sys.platform, home=os.path.expanduser("~")), separators=(",", ":"), allow_nan=False)
    except BaseException:
        sys.exit(1)
    sys.stdout.write(out + "\n")


if __name__ == "__main__":
    main()
`;

export const GOOD_MS = 5 * 60000; // next read after a good one
export const FAIL_MS = 10 * 60000; // next read after a failed one
export const READ_DEADLINE_MS = 25000; // exec carries --timeout 20; the tick abandons a read 5 s later
export const LIST_DEADLINE_MS = 10000;
export const LIST_OK_MS = 30000;
export const LIST_FAIL_MS = 60000;
export const LIST_STALE_MS = 5 * 60000; // a list older than this stops polling
export const MAX_STDOUT = 64 * 1024;

export const healthArgv = (machine) => ["exec", "--on", machine, "--timeout", "20", "--", "python3", "-c", HEALTH_PY];
const okName = (s) => validMachine(s) && !s.startsWith("-");

export const ERROR_TEXT = Object.freeze({
  timeout: "read timed out",
  exit: "read failed",
  "bad-json": "answer was not JSON",
  "bad-shape": "answer had the wrong shape",
  partial: "answer was incomplete",
  "no-python": "python3 is missing on the machine",
});

// ----------------------------------------------------------------------------------------------------------- parsing
const OS = new Set(["linux", "darwin", "other"]);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const num = (x, max) => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max ? x : undefined); // undefined = bad
const MAXMB = 1e9;
// a number-or-null field; returns undefined when it is neither a sane number nor null
const numOrNull = (x, max) => (x === null ? null : num(x, max));
function pick(o, keys) {
  if (!isObj(o)) return undefined;
  const r = {};
  for (const [k, max] of keys) { const v = numOrNull(o[k], max); if (v === undefined) return undefined; r[k] = v; }
  return r;
}
const orNull = (o, keys) => (o === null ? null : pick(o, keys));
const LOAD = [["one", 1e4], ["five", 1e4], ["fifteen", 1e4]];
const MEM = [["totalMb", MAXMB], ["usedMb", MAXMB], ["pct", 100]];
const DISK = [["totalMb", MAXMB], ["freeMb", MAXMB], ["pct", 100]];

// Build the cached sample from the fixed keys only. Returns { ok, sample } or { ok: false, code }.
export function parseSample(text) {
  if (typeof text !== "string" || text.length > MAX_STDOUT) return { ok: false, code: "bad-json" };
  let o;
  try { o = JSON.parse(text); } catch { return { ok: false, code: "bad-json" }; }
  if (!isObj(o)) return { ok: false, code: "bad-json" };
  const bad = { ok: false, code: "bad-shape" };
  if (o.v !== 1 || !OS.has(o.os) || !isObj(o.disks)) return bad;
  const cores = numOrNull(o.cores, 1e6), lpc = numOrNull(o.loadPerCore, 1e4);
  const load = orNull(o.load, LOAD), mem = orNull(o.mem, MEM), home = orNull(o.disks.home, DISK), tmp = orNull(o.disks.tmp, DISK);
  if (cores === undefined || lpc === undefined || load === undefined || mem === undefined || home === undefined || tmp === undefined) return bad;
  if (o.load === undefined || o.mem === undefined || o.disks.home === undefined || o.disks.tmp === undefined) return bad;
  if (cores !== null && !Number.isInteger(cores)) return bad;
  // A required leaf that is null makes the read partial (never a guessed zero); a disk with a null leaf is an unknown disk.
  const full = (x) => x !== null && Object.values(x).every((v) => v !== null);
  const disk = (x) => (x !== null && full(x) ? x : null);
  const dh = disk(home), dt = disk(tmp);
  if (load === null || !full(load) || mem === null || !full(mem) || lpc === null || (dh === null && dt === null)) return { ok: false, code: "partial" };
  return { ok: true, sample: { v: 1, os: o.os, cores, load, loadPerCore: lpc, mem, disks: { home: dh, tmp: dt } } };
}
const copySample = (s) => JSON.parse(JSON.stringify(s));

// Fixed code for an exec result. Neither stdout nor stderr is ever kept; stderr is only matched for "python3 not found".
function readResult(res) {
  if (!isObj(res)) return { ok: false, code: "exit" };
  if (res.code !== 0) return { ok: false, code: res.code === 127 || /python3?[^\n]*(not found|no such file)/i.test(String(res.stderr ?? "")) ? "no-python" : "exit" };
  return parseSample(res.stdout);
}

// ----------------------------------------------------------------------------------------------------------- what a row says
// Fixed texts only: nothing a machine sent is ever shown. { lines: [string], level: 0-100 | null } for one view() row.
const pct = (n) => `${Math.round(n)}%`;
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const f1 = (x) => (fin(x) ? x.toFixed(1) : "-");
const pc = (x) => (fin(x) ? pct(x) : "-");
const sub = (o, k) => (isObj(o) && isObj(o[k]) ? o[k] : {});
// Defensive on purpose: an unknown leaf prints "-" and never a number it did not read; nothing here can throw on odd input.
export function meter(n) {
  const load = sub(n, "load"), mem = sub(n, "mem"), disks = sub(n, "disks");
  const lpc = isObj(n) ? n.loadPerCore : null;
  const d = [["home", sub(disks, "home").pct], ["tmp", sub(disks, "tmp").pct]].filter(([, p]) => fin(p)).sort((a, b) => b[1] - a[1])[0]; // the higher disk, named
  const loadText = fin(lpc) ? `load ${f1(lpc)}/core` : `load ${f1(load.one)}`;
  const text = [loadText, `mem ${pc(mem.pct)}`, d ? `disk ${d[0]} ${pc(d[1])}` : "disk -"].join(" · ");
  const levels = [fin(lpc) ? lpc * 100 : null, mem.pct, d ? d[1] : null].filter(fin);
  return { text, level: levels.length ? Math.min(100, Math.max(...levels)) : null, tip: `disk home ${pc(sub(disks, "home").pct)} · /tmp ${pc(sub(disks, "tmp").pct)}` };
}
export function rowLines(row) {
  const age = !fin(row.ageMs) ? "" : row.ageMs < 60000 ? "<1" : String(Math.floor(row.ageMs / 60000));
  const m = row.numbers ? meter(row.numbers) : null;
  const tip = m ? m.tip : null;
  if (row.state === "off") return { lines: ["polling off"], level: null, tip: null };
  if (row.state === "never") return { lines: ["waiting for the first read"], level: null, tip: null };
  if (row.state === "fresh") return m ? { lines: [m.text], level: m.level, tip } : { lines: ["waiting for the first read"], level: null, tip: null };
  if (row.state === "stale") return { lines: m ? [m.text, `last read ${age} min ago, list unknown`] : ["not polled, list unknown"], level: m ? m.level : null, tip };
  if (row.state === "offline") return { lines: m ? [m.text, `offline, last read ${age} min ago`] : ["offline"], level: m ? m.level : null, tip };
  return { lines: m ? [m.text, `last read ${age} min ago, failed`] : [row.error === "no-python" ? "python3 missing on this machine" : "first read failed"], level: m ? m.level : null, tip };
}

// ----------------------------------------------------------------------------------------------------------- the poller
export function createHealth({ list, exec, now, enabled, active = () => true }) {
  let genSeed = 0;
  const entries = new Map(); // name -> entry
  const busy = new Set(); // names with an exec not yet settled (outside the entry on purpose)
  const ls = { gen: 0, inflight: null, startedAt: 0, nextAt: 0, busy: false, ok: null, okAt: null, seen: false };

  const entry = (name) => ({ name, link: "unknown", good: null, goodAt: null, error: null, failedAt: null, nextAt: 0, gen: ++genSeed, inflight: null });
  const start = (fn, ...a) => { try { return Promise.resolve(fn(...a)); } catch (e) { return Promise.reject(e); } };
  const polling = () => !!enabled();
  const screen = () => !!active();

  function finishRead(e, t, r) {
    e.inflight = null;
    if (r.ok) { e.good = r.sample; e.goodAt = t; e.error = null; e.failedAt = null; e.nextAt = t + GOOD_MS; }
    else { e.error = r.code; e.failedAt = t; e.nextAt = t + FAIL_MS; }
  }

  function startRead(e, t) {
    const name = e.name, gen = e.gen;
    e.inflight = { startedAt: t };
    busy.add(name);
    const settle = (r) => {
      busy.delete(name); // the exec settled: the machine is free again
      const cur = entries.get(name);
      if (!cur || cur !== e || cur.gen !== gen || !cur.inflight || !polling() || !screen()) return; // fenced: dropped
      finishRead(cur, now(), r);
    };
    start(exec, healthArgv(name)).then((res) => settle(readResult(res)), () => settle({ ok: false, code: "exit" }));
  }

  function startList(t) {
    const gen = ++ls.gen;
    ls.inflight = true; ls.startedAt = t; ls.busy = true;
    const settle = (items) => {
      ls.busy = false;
      if (gen !== ls.gen || !ls.inflight || !screen()) return;
      const at = now();
      ls.inflight = false; ls.seen = true;
      if (!Array.isArray(items)) { ls.ok = false; ls.nextAt = at + LIST_FAIL_MS; return; }
      const seen = new Set();
      for (const it of items) {
        if (!isObj(it) || !okName(it.name) || seen.has(it.name)) continue;
        seen.add(it.name);
        let e = entries.get(it.name);
        if (!e) { e = entry(it.name); entries.set(it.name, e); }
        e.link = typeof it.state === "string" ? it.state : "unknown";
      }
      for (const name of [...entries.keys()]) if (!seen.has(name)) entries.delete(name); // its answer, if any, now finds no entry
      ls.ok = true; ls.okAt = at; ls.nextAt = at + LIST_OK_MS;
    };
    start(list).then(settle, () => settle(null));
  }

  function abandonList(t) {
    ls.gen = ++genSeed; ls.inflight = false; ls.ok = false; ls.nextAt = t + LIST_FAIL_MS; // `busy` stays until the call settles
  }

  function dropAll() { // switch-off or screen off: every answer in flight is dropped
    for (const e of entries.values()) if (e.inflight) { e.gen = ++genSeed; e.inflight = null; }
  }

  function tick() {
    const t = now(), on = polling(), scr = screen();
    // 1. deadlines
    for (const e of entries.values()) if (e.inflight && t - e.inflight.startedAt > READ_DEADLINE_MS) { e.gen = ++genSeed; finishRead(e, t, { ok: false, code: "timeout" }); }
    if (ls.inflight && t - ls.startedAt > LIST_DEADLINE_MS) abandonList(t);
    if (!scr) { dropAll(); if (ls.inflight) { ls.gen = ++genSeed; ls.inflight = false; } return; }
    if (!on) dropAll();
    // 2. discovery (own state; runs with polling off too)
    if (!ls.busy && !ls.inflight && t >= ls.nextAt) startList(t);
    // 3. reads
    if (!on || ls.okAt === null || t - ls.okAt > LIST_STALE_MS) return;
    for (const e of entries.values()) {
      if (e.link !== "connected" || e.inflight || busy.has(e.name) || t < e.nextAt || !okName(e.name)) continue;
      startRead(e, t);
    }
  }

  function view() {
    const t = now(), on = polling();
    const listState = !ls.seen ? "none" : ls.ok && ls.okAt !== null && t - ls.okAt <= LIST_STALE_MS ? "ok" : "unknown";
    const stalled = on && ls.okAt !== null && t - ls.okAt > LIST_STALE_MS; // discovery stopped polling: whatever is shown is only the last read
    const machines = [...entries.values()].map((e) => {
      const state = !on ? "off" : stalled ? "stale" : e.link !== "connected" ? "offline" : e.error ? "failed" : e.good ? "fresh" : "never";
      const shown = on && e.good;
      return { name: e.name, link: e.link, state, numbers: shown ? copySample(e.good) : null, ageMs: shown ? Math.max(0, t - e.goodAt) : null, error: on ? e.error : null, errorText: on && e.error ? ERROR_TEXT[e.error] ?? "read failed" : null };
    });
    return { polling: on, listState, machines };
  }

  function retry(name) {
    for (const e of entries.values()) if ((name === undefined || e.name === name) && e.error) e.nextAt = 0;
  }

  return { tick, view, retry };
}
