// A machines test that throws after spawning must not leave its child running (T-MWQVKL1QR6L): the fixture tracks spawned children and reaps their process groups in afterEach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { until, spawnTracked, reapChildren } from "./machines-install-fixture.js";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "mfc-")));
const PROBE = join(dirname(fileURLToPath(import.meta.url)), "stubs/children-probe.js");
const WATCHDOG_MS = 60000; // a bound, not a budget: if it fires the probe is killed and the test fails

test("reapChildren: kills the whole process group and has awaited the close when it returns", async () => {
  const dir = tmp();
  try {
    const child = spawnTracked("/bin/sh", ["-c", `sleep 1000 & echo $! > "${join(dir, "grand")}"; : > "${join(dir, "started")}"; while :; do sleep 1; done`], { stdio: "ignore" });
    await until(() => existsSync(join(dir, "started")), "the child started");
    const grand = Number(readFileSync(join(dir, "grand"), "utf8"));
    assert.ok(alive(child.pid) && alive(grand));
    await reapChildren();
    assert.equal(alive(child.pid), false, "the parent is gone as soon as reapChildren returns");
    assert.equal(alive(grand), false, "its descendant is gone too");
    await reapChildren(); // nothing registered: a no-op
  } finally { rmSync(dir, { recursive: true, force: true }); await reapChildren(); }
});

test("afterEach: a test that throws after spawning leaves no child and no descendant", async () => {
  const dir = tmp();
  let probe;
  try {
    let timedOut = false;
    const r = await new Promise((resolveRun) => {
      probe = spawn(process.execPath, ["--test", PROBE], { env: { ...process.env, NODE_TEST_CONTEXT: undefined, PROBE_DIR: dir }, stdio: "ignore", detached: true });
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-probe.pid, "SIGKILL"); } catch {} }, WATCHDOG_MS);
      probe.on("close", (code) => { clearTimeout(timer); resolveRun(code); });
    });
    assert.equal(timedOut, false, "the probe hit the watchdog: its child kept the runner waiting");
    assert.notEqual(r, 0, "the probe test fails on purpose");
    const parent = Number(readFileSync(join(dir, "parent"), "utf8")), grand = Number(readFileSync(join(dir, "grand"), "utf8"));
    assert.ok(parent > 0 && grand > 0);
    assert.equal(alive(parent), false, "the probe's child was reaped");
    assert.equal(alive(grand), false, "the probe child's descendant was reaped");
  } finally {
    if (probe && probe.exitCode === null) { try { process.kill(-probe.pid, "SIGKILL"); } catch {} }
    for (const f of ["parent", "grand"]) { try { process.kill(-Number(readFileSync(join(dir, f), "utf8")), "SIGKILL"); } catch {} try { process.kill(Number(readFileSync(join(dir, f), "utf8")), "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});
