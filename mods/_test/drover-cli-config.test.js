// The real `drover config` script against the real consumer (#70). The CLI is a transport: the consumer validates and applies.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const C = await import("../_lib/config.js");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "../drover-tasks/bin/drover");
const CFG = "drover.config";

let home, inbox, host, responder;
const roots = []; // registered on creation, removed after each test (the timer is cleared first)
beforeEach(() => {
  C.resetCache();
  home = mkdtempSync(join(tmpdir(), "iccli-home-"));
  roots.push(home);
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  host = globalThis.__host = { appHome: home, home: join(home, "h"), props: {}, notified: [], state: {}, agents: [], terminals: [], watchFolder: () => new Promise(() => {}), readTextFile: async () => null, exec: async () => ({ code: 0, stdout: "[]", stderr: "" }) };
  responder = null;
});
afterEach(() => { if (responder) clearInterval(responder); responder = null; for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const startConsumer = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; responder = setInterval(() => IO.watchInbox(cx), 20); };
const cli = (args, env = {}) => new Promise((resolve) => execFile("bash", [CLI, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_CONFIG_WAIT: "10", HC_TERMINAL_ID: "t42", ...env } }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
const jsonFiles = () => readdirSync(inbox).filter((n) => n.endsWith(".json"));
// A stub consumer: records each request, answers via `reply(cmd)` (null = no answer).
const stub = (reply) => {
  const seen = [];
  responder = setInterval(() => {
    for (const n of jsonFiles()) {
      const cmd = JSON.parse(readFileSync(join(inbox, n), "utf8"));
      const out = reply(cmd);
      seen.push(cmd);
      if (out === null) continue;
      unlinkSync(join(inbox, n));
      writeFileSync(join(inbox, n.replace(/\.json$/, ".result")), out);
    }
  }, 5);
  return seen;
};

test("config max-parallel <n> sets it through the real consumer, with from and a ttl, and applies at once", async () => {
  startConsumer();
  const r = await cli(["config", "max-parallel", "4"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.stdout.trim(), "ok: drover-runs.max_parallel 2 -> 4");
  assert.deepEqual(host.state[CFG], { "drover-runs": { max_parallel: 4 } });
  assert.match(host.notified.at(-1).body, /requested by t42/);
  const shown = await cli(["config", "max-parallel"]);
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /^ok: drover-runs\.max_parallel 4 /);
});

test("config lists the agent-settable settings with their effective value", async () => {
  startConsumer();
  const r = await cli(["config"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ok: settings an agent may change/);
  assert.match(r.stdout, /^drover-runs\.max_parallel 2 /m);
});

test("config-set carries from=$HC_TERMINAL_ID, a 60 s ttl and a JSON number; the show command carries no value", async () => {
  const seen = stub((c) => (c.op === "protocol" ? "ok: protocol 5" : "ok: x"));
  await cli(["config", "max-parallel", "6"]);
  await cli(["config", "max-parallel"]);
  const set = seen.find((c) => c.op === "config-set");
  assert.deepEqual(set, { op: "config-set", key: "drover-runs.max_parallel", value: 6, from: "t42", ttlMs: 60000 });
  assert.deepEqual(seen.find((c) => c.op === "config-get"), { op: "config-get", key: "drover-runs.max_parallel" });
});

test("bad values reach the consumer and are refused there; nothing is written", async () => {
  startConsumer();
  for (const v of ["0", "11", "2.5", "x", "-1", "4x"]) {
    const r = await cli(["config", "max-parallel", v]);
    assert.notEqual(r.code, 0, v);
    assert.match(r.stdout, /^error: /, v);
  }
  assert.equal(host.state[CFG], undefined);
});

test("usage errors never reach the inbox", async () => {
  for (const args of [["config", "bogus"], ["config", "max-parallel", "1", "2"], ["config", "kept", "5"], ["config", "max-parallel", ""]]) {
    const r = await cli(args);
    assert.notEqual(r.code, 0, args.join(" "));
  }
  assert.deepEqual(readdirSync(inbox), []);
});

test("an old consumer (protocol 4) is refused cleanly: the set is never sent, and no file is left", async () => {
  const seen = stub((c) => (c.op === "protocol" ? "ok: protocol 4" : "error: Unknown drover command"));
  const r = await cli(["config", "max-parallel", "4"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /update the mods/);
  assert.match(r.stderr, /protocol 5/);
  assert.deepEqual(seen.map((c) => c.op), ["protocol"]);
  assert.deepEqual(jsonFiles(), []);
});

test("no Drover mod open: nothing changed, and no request (not even the probe) is left to apply later", async () => {
  const r = await cli(["config", "max-parallel", "4"], { DROVER_CONFIG_WAIT: "1" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no Drover mod is open, nothing changed/);
  assert.deepEqual(jsonFiles(), []);
});

test("probe ok but the set gets no answer: reported as unknown / not applied, never as queued-to-apply, exit non-zero", async () => {
  const seen = stub((c) => (c.op === "protocol" ? "ok: protocol 5" : null));
  const r = await cli(["config", "max-parallel", "4"], { DROVER_CONFIG_WAIT: "1" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no answer.*not confirmed/s);
  assert.match(r.stderr, /expires/);
  assert.doesNotMatch(r.stdout + r.stderr, /applies when one opens/);
  assert.equal(seen.find((c) => c.op === "config-set").ttlMs, 60000);
});

test("a request that waited past its ttl (a restarted consumer) is refused, not applied", async () => {
  const name = `${Math.floor(Date.now() / 1000) - 3600}-9-stale`;
  writeFileSync(join(inbox, `${name}.json`), JSON.stringify({ op: "config-set", key: "drover-runs.max_parallel", value: 9, from: "t42", ttlMs: 60000 }));
  startConsumer();
  await until(() => readdirSync(inbox).includes(`${name}.result`), "answered");
  assert.match(readFileSync(join(inbox, `${name}.result`), "utf8"), /^error: expired/);
  assert.equal(host.state[CFG], undefined);
});
