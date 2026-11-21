// The machine health script (T-MWO2HEHGIEC, A4): drover-health.py, python3 stdlib, one JSON object on stdout.
// Pure parse functions are loaded with importlib under `python3 -I` (no cwd, no env, no user site); fixtures hold the Linux /proc and macOS vm_stat text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { GENERIC_LEAKS } from "./private-words.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../drover-tasks/bin/drover-health.py");
const FX = (n) => join(HERE, "fixtures/health", n);
const fx = (n) => readFileSync(FX(n), "utf8");

// Run a python expression against the module. `m` is the loaded module, `a` the JSON args; the result is printed as JSON.
const HARNESS = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("drover_health", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
a = json.loads(sys.argv[2])
print(json.dumps(eval(sys.argv[3])))
`;
const py = (expr, args = {}, env = {}) => {
  const r = spawnSync("python3", ["-I", "-c", HARNESS, SCRIPT, JSON.stringify(args), expr], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("linux: /proc/loadavg text -> exact load numbers; a short or empty file is null, never a guess", () => {
  assert.deepEqual(py("m.parse_loadavg(a['t'])", { t: fx("linux-loadavg.txt") }), { one: 0.52, five: 0.48, fifteen: 0.4 });
  assert.equal(py("m.parse_loadavg(a['t'])", { t: fx("linux-loadavg-partial.txt") }), null);
  assert.equal(py("m.parse_loadavg(a['t'])", { t: "" }), null);
  assert.equal(py("m.parse_loadavg(a['t'])", { t: "x y z" }), null);
});

test("linux: /proc/meminfo -> total, used = total - MemAvailable, pct; MemAvailable missing -> null, not a guess", () => {
  assert.deepEqual(py("m.parse_meminfo(a['t'])", { t: fx("linux-meminfo.txt") }), { totalMb: 16000, usedMb: 12000, pct: 75.0 });
  assert.equal(py("m.parse_meminfo(a['t'])", { t: fx("linux-meminfo-no-avail.txt") }), null);
  assert.equal(py("m.parse_meminfo(a['t'])", { t: "" }), null);
});

for (const ps of [16384, 4096]) {
  test(`macos: vm_stat with ${ps}-byte pages + hw.memsize -> the same exact used/pct (free + inactive + speculative is available)`, () => {
    const mem = py("m.parse_vm_stat(a['v'], a['s'])", { v: fx(`macos-vm_stat-${ps}.txt`), s: fx("macos-memsize.txt") });
    assert.deepEqual(mem, { totalMb: 16384, usedMb: 13884, pct: 84.7 });
  });
}

test("macos: sysctl missing, a bad header or a missing page counter -> null", () => {
  const v = fx("macos-vm_stat-16384.txt");
  assert.equal(py("m.parse_vm_stat(a['v'], None)", { v }), null);
  assert.equal(py("m.parse_vm_stat(a['v'], a['s'])", { v, s: "" }), null);
  assert.equal(py("m.parse_vm_stat(a['v'], a['s'])", { v: fx("macos-vm_stat-no-header.txt"), s: fx("macos-memsize.txt") }), null);
  assert.equal(py("m.parse_vm_stat(a['v'], a['s'])", { v: fx("macos-vm_stat-no-speculative.txt"), s: fx("macos-memsize.txt") }), null);
  assert.equal(py("m.parse_vm_stat(None, a['s'])", { s: fx("macos-memsize.txt") }), null);
});

const FAKE = `
def run(plat, files, cmds, disks, cores=4, load=(1.0, 0.5, 0.25)):
    def rf(p):
        if p not in files: raise OSError(p)
        return files[p]
    def sc(n):
        if n not in cmds: raise OSError(n)
        return cmds[n]
    asked = []
    def du(p):
        asked.append(p)
        if p not in disks: raise OSError(p)
        t, f = disks[p]
        return t, f
    out = m.sample(plat, read_file=rf, sysctl=sc, vm_stat=lambda: sc("vm_stat"), getloadavg=lambda: load, cpu_count=lambda: cores, disk_usage=du, home="/h")
    return [out, asked]
`;
const harnessPy = (expr, args) => {
  const r = spawnSync("python3", ["-I", "-c", HARNESS.replace("print(", FAKE.split("\n").map((l) => l).join("\n") + "\nprint("), SCRIPT, JSON.stringify(args), expr], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const run = (plat, f, c, d, x = {}) => harnessPy("run(a['p'], a['f'], a['c'], {k: tuple(v) for k, v in a['d'].items()}, **a['x'])", { p: plat, f, c, d, x });
const MB = 1048576;
const DISKS = { "/h": [100000 * MB, 60000 * MB], "/tmp": [50000 * MB, 45000 * MB] };

test("sample on linux: the fixed shape, loadPerCore over cores, both disks, /tmp asked literally", () => {
  const [out, asked] = run("linux", { "/proc/loadavg": fx("linux-loadavg.txt"), "/proc/meminfo": fx("linux-meminfo.txt") }, {}, DISKS, { cores: 4 });
  assert.deepEqual(out, {
    v: 1, os: "linux", cores: 4, load: { one: 0.52, five: 0.48, fifteen: 0.4 }, loadPerCore: 0.13,
    mem: { totalMb: 16000, usedMb: 12000, pct: 75.0 },
    disks: { home: { totalMb: 100000, freeMb: 60000, pct: 40.0 }, tmp: { totalMb: 50000, freeMb: 45000, pct: 10.0 } },
  });
  assert.deepEqual(asked, ["/h", "/tmp"], "the home dir and the literal /tmp, nothing from the environment");
});

test("sample on darwin: no /proc; load from getloadavg, memory from sysctl + vm_stat", () => {
  const [out] = run("darwin", {}, { vm_stat: fx("macos-vm_stat-16384.txt"), "hw.memsize": fx("macos-memsize.txt") }, DISKS, { cores: 8, load: [2, 1, 0.5] });
  assert.equal(out.os, "darwin");
  assert.deepEqual(out.load, { one: 2, five: 1, fifteen: 0.5 });
  assert.equal(out.loadPerCore, 0.25);
  assert.deepEqual(out.mem, { totalMb: 16384, usedMb: 13884, pct: 84.7 });
});

test("sample: an unreadable field is null (mem, load, a missing /tmp), never a guess; an unknown os reads load only", () => {
  const [a] = run("linux", { "/proc/loadavg": fx("linux-loadavg.txt") }, {}, { "/h": DISKS["/h"] });
  assert.equal(a.mem, null);
  assert.equal(a.disks.tmp, null);
  assert.equal(a.disks.home.pct, 40);
  const [b] = run("linux", { "/proc/meminfo": fx("linux-meminfo.txt") }, {}, DISKS);
  assert.equal(b.load, null);
  assert.equal(b.loadPerCore, null);
  const [c] = run("freebsd", {}, {}, DISKS, { cores: 2 });
  assert.equal(c.os, "other");
  assert.equal(c.mem, null);
  assert.deepEqual(c.load, { one: 1, five: 0.5, fifteen: 0.25 });
  const [d] = run("linux", {}, {}, {}, { cores: 0 });
  assert.deepEqual(d.disks, { home: null, tmp: null });
  assert.equal(d.cores, null);
});

test("end to end on this computer: python3 runs it, one JSON object of the fixed shape, nothing from the environment or the machine's names", () => {
  const env = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: "/var/tmp/elsewhere-xyz", SECRET_TOKEN: "s3cr3t-value-123" };
  const r = spawnSync("python3", ["-I", SCRIPT], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.trim().split("\n").length, 1, "one line");
  const o = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(o), ["v", "os", "cores", "load", "loadPerCore", "mem", "disks"]);
  assert.equal(o.v, 1);
  assert.ok(["linux", "darwin", "other"].includes(o.os));
  assert.ok(Number.isInteger(o.cores) && o.cores > 0);
  assert.deepEqual(Object.keys(o.disks), ["home", "tmp"]);
  assert.deepEqual(Object.keys(o.disks.home), ["totalMb", "freeMb", "pct"]);
  assert.deepEqual(Object.keys(o.mem), ["totalMb", "usedMb", "pct"]);
  const all = JSON.stringify(o);
  assert.doesNotMatch(all, /\//, "no path");
  assert.doesNotMatch(all, /HOME|TMPDIR|elsewhere|s3cr3t/);
  // names: every string in the output is one of the fixed keys (checked below), so no account, host or path text can be in it
  const strings = [...all.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(strings.filter((s) => !["v", "os", "cores", "load", "loadPerCore", "mem", "disks", "one", "five", "fifteen", "totalMb", "usedMb", "pct", "home", "tmp", "freeMb", o.os].includes(s)), []);
});

test("TMPDIR pointing elsewhere does not change `tmp`: the constant is the literal /tmp", () => {
  assert.equal(py("m.TMP_DIR", {}, { TMPDIR: "/var/tmp/elsewhere-xyz" }), "/tmp");
});

test("the script text runs as `python3 -c <text>` (how a laptop runs it with no install)", () => {
  const r = spawnSync("python3", ["-I", "-c", readFileSync(SCRIPT, "utf8")], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).v, 1);
});

test("the script is generic: no machine, owner, display-manager or OS-specific path names, no secret-looking text", () => {
  const text = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(text, GENERIC_LEAKS);
  assert.ok(text.length < 6000, `${text.length} bytes: small enough to travel as one argv item`);
});
