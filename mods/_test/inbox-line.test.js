// Run line (T-MWO2HFSB34T): the inbox op `line`. Real consumer drain over a temp inbox, stubbed host (as inbox-expired-add.test.js). No sleeps: until().
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const RUNS = "drover.runs";
const FAKE = String.fromCharCode(103, 104, 112, 95) + "a1B2".repeat(6); // built from char codes: no secret-shaped literal here

let home, inbox, host;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "iline-home-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  host = globalThis.__host = { appHome: home, props: {}, notified: [], state: {}, agents: [], terminals: [], watchFolder: () => new Promise(() => {}) };
  host.exec = async () => ({ code: 0, stdout: "", stderr: "" });
});

const term = (address, name, extra = {}) => ({ address, agent: "wrangler", name, started: 1, ...extra });
const seed = (runs, terminals = ["t1", "t2", "t9"]) => { host.state[RUNS] = runs; host.terminals = terminals.map((address) => ({ address })); };
const live = () => ({ id: "R-1", task: "T-1", started: 1, terminals: [term("t1", "Trail Boss"), term("t2", "Wrangler")] });
const run = (id = "R-1") => host.state[RUNS].find((r) => r.id === id);
const startLoop = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; IO.watchInbox(cx); };
let n = 0;
const send = async (cmd) => {
  const name = `${Math.floor(Date.now() / 1000)}-${++n}`; // as the CLI names its files: the epoch is the arrival time (this host has no stat)
  writeFileSync(join(inbox, `${name}.json`), JSON.stringify(cmd));
  startLoop();
  return until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `the inbox answered ${name}`);
};
const line = (over = {}) => send({ op: "line", id: "T-1", text: "reading the code", by: "t2", ...over });

test("a terminal of the active run sets the line: text, progress, time and the terminal's name", async () => {
  seed([live()]);
  const before = Date.now();
  assert.equal(await line({ progress: 20 }), "ok: R-1 line set");
  const l = run().line;
  assert.deepEqual({ text: l.text, progress: l.progress, by: l.by }, { text: "reading the code", progress: 20, by: "Wrangler" });
  assert.ok(l.at >= before && l.at <= Date.now());
});

test("a second line replaces the first; without progress the old progress is dropped", async () => {
  seed([live()]);
  await line({ text: "first", progress: 40 });
  assert.equal(await line({ text: "second" }), "ok: R-1 line set");
  assert.equal(run().line.text, "second");
  assert.equal("progress" in run().line, false);
});

test("the text is normalised (trim, collapsed spaces) before it is stored", async () => {
  seed([live()]);
  await line({ text: "  reading   the code " });
  assert.equal(run().line.text, "reading the code");
});

test("a terminal that is not in a run of that card is refused and nothing changes", async () => {
  seed([live()]);
  const before = JSON.stringify(host.state[RUNS]);
  assert.match(await line({ by: "t9" }), /^error: no active run for T-1 from this terminal/);
  assert.match(await line({ id: "T-2" }), /^error: no active run for T-2/);
  assert.match(await line({ by: "" }), /^error: no active run/);
  assert.equal(JSON.stringify(host.state[RUNS]), before);
});

test("a stamped-ended run and a live-ended run (terminals gone, record unchanged) are refused", async () => {
  seed([{ ...live(), ended: 5 }]);
  assert.match(await line(), /^error: no active run/);
  seed([live()], ["t9"]); // t1 and t2 are gone from the live state
  assert.match(await line(), /^error: no active run/);
  assert.equal("line" in run(), false);
});

test("a legacy record without a started time is active while its terminal is alive", async () => {
  seed([{ id: "R-1", task: "T-1", terminals: [{ address: "t2", agent: "wrangler" }] }]);
  assert.equal(await line(), "ok: R-1 line set");
  assert.equal(run().line.by, "t2");
});

test("invalid requests are refused with the rule, no value echoed, no state change", async () => {
  seed([live()]);
  const before = JSON.stringify(host.state[RUNS]);
  assert.match(await line({ text: "a".repeat(41) }), /^error: .*40/);
  assert.match(await line({ text: "a\nb" }), /^error: .*control/);
  assert.match(await line({ text: "" }), /^error: /);
  assert.match(await line({ text: "ok", progress: 150 }), /^error: .*progress/);
  assert.match(await line({ text: "ok", progress: 1.5 }), /^error: .*progress/);
  assert.equal(JSON.stringify(host.state[RUNS]), before);
});

test("a hand-written request with a secret or a home path is refused, naming the rule only", async () => {
  seed([live()]);
  const before = JSON.stringify(host.state[RUNS]);
  const secret = await line({ text: FAKE });
  assert.match(secret, /^error: .*github-token/);
  assert.ok(!secret.includes(FAKE) && !secret.includes("a1B2"), "the value was echoed");
  const home = await line({ text: "see /" + ["Us", "ers"].join("") + "/x/y" });
  assert.match(home, /^error: .*home-path/);
  assert.equal(JSON.stringify(host.state[RUNS]), before);
  assert.ok(!JSON.stringify(host.state).includes(FAKE), "the value is nowhere in the shared state");
});

test("other runs are untouched, and another card's run does not take the line", async () => {
  seed([live(), { id: "R-2", task: "T-2", started: 1, terminals: [term("t9", "Other")] }]);
  await line();
  assert.equal("line" in run("R-2"), false);
  assert.equal(await send({ op: "line", id: "T-2", text: "mine", by: "t9" }), "ok: R-2 line set");
  assert.equal(run("R-1").line.text, "reading the code");
});

test("a line request that sat on disk past its ttl (no mod was open) is refused: it never applies late as fresh", async () => {
  seed([live()]);
  const name = `${Math.floor(Date.now() / 1000) - 3600}-${++n}`, p = join(inbox, `${name}.json`); // the CLI file name carries the arrival epoch (this host has no stat)
  writeFileSync(p, JSON.stringify({ op: "line", id: "T-1", text: "old news", by: "t2", ttlMs: 300000 }));
  startLoop();
  const reply = await until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), "answered");
  assert.match(reply, /^error: expired: /);
  assert.equal("line" in run(), false);
  // inside the ttl it applies
  assert.equal(await line({ ttlMs: 300000 }), "ok: R-1 line set");
});
