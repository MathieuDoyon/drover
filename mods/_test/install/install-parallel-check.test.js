// install.sh runs the per-mod `herdr-app check` calls in batches of 4 and still reports the first failing mod (in mod order), exits 1, and leaves no check process behind.
// Disposable repo copy and Herdr home; herdr-app is a stub (a shim dir ahead of the fixture's fake). Waits poll a real condition; the stub sleeps only to make runs overlap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { until } from "../stubs/until.js";
import { BIN, fixture } from "./install-fixture.js";

// a herdr-app stub in its own dir (a test may need two: shimDir makes one per root)
let n = 0;
const shimDir = (root, name, body) => { const d = join(root, `stub-${++n}`); mkdirSync(d); writeFileSync(join(d, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return d; };

const mods = (repo) => readdirSync(join(repo, "mods")).filter((n) => n.startsWith("drover-")).sort();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const envFor = (home, dir) => ({ ...process.env, HERDR_APP_HOME: home, PATH: `${dir}:${BIN}:${process.env.PATH}` });
const runSh = (repo, home, dir, bash = "bash") => spawnSync(bash, ["install.sh"], { cwd: join(repo, "mods"), encoding: "utf8", timeout: 60000, env: envFor(home, dir) }); // timeout: a hang guard only
const BASHES = ["bash", ...(existsSync("/bin/bash") ? ["/bin/bash"] : [])];

for (const bash of BASHES) {
  test(`${bash}: checks overlap (more than 1, at most 4 at once) and the install passes`, () => {
    const { root, repo, home } = fixture();
    const log = join(root, "run"); mkdirSync(join(log, "running"), { recursive: true });
    const dir = shimDir(root, "herdr-app", `L="${log}"\ntouch "$L/running/$$"\nn=$(ls "$L/running" | wc -l)\necho $n >> "$L/peaks"\nif [ ! -e "$L/first" ] && mkdir "$L/first" 2>/dev/null; then i=0; while [ "$(ls "$L/running" | wc -l)" -lt 2 ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; fi\nsleep 0.2\nrm -f "$L/running/$$"\nexit 0`);
    const r = runSh(repo, home, dir, bash);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const peaks = readFileSync(join(log, "peaks"), "utf8").trim().split("\n").map(Number);
    assert.equal(peaks.length, mods(repo).length, "one check per mod");
    assert.ok(Math.max(...peaks) > 1, `checks never overlapped: ${peaks}`);
    assert.ok(Math.max(...peaks) <= 4, `more than 4 at once: ${peaks}`);
    assert.deepEqual(r.stdout.split("\n").filter((l) => l.startsWith("ok   drover-")), mods(repo).map((m) => `ok   ${m}`), "ok lines in mod order");
  });

  test(`${bash}: the first failing mod in mod order is reported with its output even when a later one fails first (same batch); exit 1; no layout link`, () => {
    const { root, repo, home } = fixture();
    const [, a, , b] = mods(repo); // same batch of 4
    const done = join(root, "b-done");
    const dir = shimDir(root, "herdr-app", `case "$2" in\n*/${a}) i=0; while [ ! -e "${done}" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; echo OUT-${a}; echo ERR-${a} >&2; exit 7;;\n*/${b}) echo OUT-${b}; touch "${done}"; exit 3;;\nesac\nexit 0`);
    const r = runSh(repo, home, dir, bash);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, new RegExp(`FAIL ${a}[\\s\\S]*OUT-${a}[\\s\\S]*ERR-${a}`));
    assert.match(r.stderr, new RegExp(`FAIL ${b}`), "a later failure is named");
    assert.doesNotMatch(r.stderr, new RegExp(`OUT-${b}`), "only the first failure prints its output");
    assert.equal(existsSync(join(home, "layouts", "drover.json")), false);
    assert.equal(existsSync(join(home, ".drover-lib-stamp")), false);
  });

  test(`${bash}: a failed run leaves an existing stamp byte for byte`, () => {
    const { root, repo, home } = fixture();
    const ok = shimDir(root, "herdr-app", "exit 0");
    assert.equal(runSh(repo, home, ok, bash).status, 0);
    const before = readFileSync(join(home, ".drover-lib-stamp"), "utf8");
    writeFileSync(join(repo, "mods", "_lib", "store.js"), readFileSync(join(repo, "mods", "_lib", "store.js"), "utf8") + "\n// changed\n");
    const bad = shimDir(root, "herdr-app", "exit 9");
    assert.equal(runSh(repo, home, bad, bash).status, 1);
    assert.equal(readFileSync(join(home, ".drover-lib-stamp"), "utf8"), before);
  });

  test(`${bash}: every mod skipped is a clean no-check run`, () => {
    const { root, repo, home } = fixture();
    const dir = shimDir(root, "herdr-app", "exit 99");
    const r = spawnSync(bash, ["install.sh"], { cwd: join(repo, "mods"), encoding: "utf8", timeout: 60000, env: { ...envFor(home, dir), DROVER_SKIP_MODS: mods(repo).join(" ") } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });

  for (const terms of [1, 2]) {
    test(`${bash}: ${terms} SIGTERM${terms > 1 ? "s (the second during the cleanup)" : ""} kill the check, its child and a TERM-ignoring grandchild before the checkout and home locks are released`, async () => {
      const { root, repo, home } = fixture();
      const pids = join(root, "pids"), marker = join(root, "term-seen");
      // the check handles TERM by only noting it (it survives until KILL); its child and grandchild ignore TERM
      const dir = shimDir(root, "herdr-app", `trap 'touch "${marker}"' TERM\nsh -c 'trap "" TERM; echo $$ >> "${pids}.child"; sh -c "trap \\"\\" TERM; echo \\$\\$ >> ${pids}.gc; while :; do sleep 1; done" & wait' &\necho $$ >> "${pids}.chk"\nwhile :; do wait; done`);
      const p = spawn(bash, ["install.sh"], { cwd: join(repo, "mods"), env: envFor(home, dir), stdio: "ignore" });
      const exited = new Promise((res) => p.on("exit", (code, sig) => res({ code, sig })));
      const guard = setTimeout(() => p.kill("SIGKILL"), 120000); // hang guard only
      const read = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
      const tracked = () => ["chk", "child", "gc"].flatMap((k) => read(`${pids}.${k}`));
      try {
        await until(() => read(`${pids}.chk`).length >= 4 && read(`${pids}.child`).length >= 4 && read(`${pids}.gc`).length >= 4, "four checks with child and grandchild started", 60000);
        const all = tracked();
        p.kill("SIGTERM");
        if (terms > 1) { await until(() => existsSync(marker), "the cleanup reached a check"); p.kill("SIGTERM"); }
        await until(() => !existsSync(join(home, ".drover-install.lock")), "the home lock was released", 60000);
        for (const pid of all) assert.equal(alive(pid), false, `pid ${pid} still alive when the home lock was released`);
        const { sig } = await exited;
        assert.notEqual(sig, "SIGKILL", "install.sh did not exit on SIGTERM");
        assert.equal(existsSync(join(repo, "mods", ".install.lock")), false, "checkout lock released");
      } finally { clearTimeout(guard); if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); for (const pid of tracked()) { try { process.kill(pid, "SIGKILL"); } catch {} } }
    });
  }
}
