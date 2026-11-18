// AC1e and the rollback order (T-MWHVWR8TIJB): an `add` whose TTL passed while the consumer was stopped creates no card, and a v2 consumer
// drops every expired file left on disk BEFORE a v1 could read it. Same stubbed host as inbox-protocol.test.js, real drain.
// The consumer path runs for real (watchInbox over a temp inbox). No sleeps or tick counts: conditions via until().
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const S = await import("../_lib/store.js");
const R = await import("../_lib/runs.js");
const KEY = "drover.tasks", SEEN = "drover.inbox-seen";

let home, inbox, host, statCalls, hold, noStat, resultWrites, onRead;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "iproto-home-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  statCalls = []; hold = null; noStat = false; resultWrites = []; onRead = null;
  host = globalThis.__host = { appHome: home, props: {}, notified: [], state: {}, agents: [], terminals: [], watchFolder: () => new Promise(() => {}) };
  host.fsGuard = (op, path) => {
    if (op === "writeFile" && path.endsWith(".result")) resultWrites.push(path);
    if (op === "readFile" && path.endsWith(".json")) onRead?.(path);
  };
  host.exec = (cmd, args) => new Promise((resolve) => {
    if (cmd === "stat") { statCalls.push(args); if (noStat) return resolve({ code: 1, stdout: "", stderr: "stat: unavailable" }); }
    const run = () => execFile(cmd, args, { encoding: "utf8" }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }));
    hold ? hold.then(run) : run();
  });
});

const seed = (...titles) => { let t = []; for (const title of titles) t = S.add(t, { title, column: "todo" }).tasks; host.state[KEY] = t; return t.map((x) => x.id); };
const tasks = () => host.state[KEY] ?? [];
const snap = () => JSON.stringify(tasks());
const card = (id) => tasks().find((t) => t.id === id);
const startLoop = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; IO.watchInbox(cx); };
const drop = (name, cmd, { ageS } = {}) => {
  const p = join(inbox, `${name}.json`);
  writeFileSync(p, JSON.stringify(cmd));
  if (ageS != null) { const t = Date.now() / 1000 - ageS; utimesSync(p, t, t); }
};
const answer = (name) => until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `the inbox answered ${name}`);
let n = 0;
const send = async (cmd, opts) => { const name = `q${++n}`; drop(name, cmd, opts); startLoop(); return answer(name); };

const DRAIN_CHECK = join(dirname(fileURLToPath(import.meta.url)), "../../deploy/omarchy/drain-check.sh");
const drainCheck = () => new Promise((resolve) => execFile("bash", [DRAIN_CHECK, inbox], { encoding: "utf8" }, (e, stdout) => resolve({ code: e ? e.code : 0, stdout })));

test("1e an add whose TTL passed while the consumer was stopped creates no card, answers expired, and the file is gone", async () => {
  const [id] = seed("one");
  const before = snap();
  drop("add1", { op: "add", title: "late", desc: "", tags: [], column: "backlog", priority: "P2", project: "P-X", ttlMs: 120000 }, { ageS: 600 }); // sat on disk 10 min, consumer stopped
  startLoop();
  assert.match(await answer("add1"), /^error: expired: /);
  assert.equal(snap(), before, "no card was created");
  assert.equal(tasks().length, 1);
  assert.equal(existsSync(join(inbox, "add1.json")), false);
  assert.ok(card(id));
  // the same add inside its TTL does create one card
  assert.match(await send({ op: "add", title: "on time", column: "backlog", ttlMs: 120000 }, { ageS: 30 }), /^ok: /);
  assert.equal(tasks().length, 2);
});

test("1e the same when only the epoch in the file name carries the arrival time (no mtime)", async () => {
  seed("one");
  noStat = true;
  const sec = Math.floor(Date.now() / 1000);
  drop(`${sec - 600}-Lx-000000000001`, { op: "add", title: "late", ttlMs: 120000 });
  startLoop();
  assert.match(await answer(`${sec - 600}-Lx-000000000001`), /^error: expired: /);
  assert.equal(tasks().length, 1);
});

test("rollback order: v2 drops the expired files left on disk with `expired` before a v1 could read them; the drain check then passes", async () => {
  const [id] = seed("one");
  const before = snap();
  drop("old-add", { op: "add", title: "late", ttlMs: 120000 }, { ageS: 900 });
  drop("old-move", { op: "move", id, column: "doing", ifRev: 0, ttlMs: 120000 }, { ageS: 900 });
  drop("tmp-not-json", { op: "noop" }); // a request file that is not protected: unaffected by the check
  const pre = await drainCheck();
  assert.notEqual(pre.code, 0, "protected requests are still on disk: rollback must stop");
  assert.match(pre.stdout, /protected/);
  startLoop(); // v2 is (still) running
  assert.match(await answer("old-add"), /^error: expired: /);
  assert.match(await answer("old-move"), /^error: expired: /);
  await answer("tmp-not-json"); // the loop answers files in order: until this one is answered its reply may still be staged in a hidden .tmp (a delivery in flight)
  assert.equal(snap(), before, "nothing was applied");
  for (const n of ["old-add", "old-move"]) assert.equal(existsSync(join(inbox, `${n}.json`)), false, `${n}.json is gone: a v1 finds nothing to apply`);
  const post = await drainCheck();
  assert.equal(post.code, 0, post.stdout);
});

// T-MWMKWXEHKUC: a reply is staged in a hidden `.<name>.<x>.tmp` before it is moved into place. The drain check must fail closed while that is in flight.
test("the drain check fails closed while a reply is staged, and passes once it is delivered", async () => {
  let release, held;
  const gate = new Promise((r) => { release = r; }), atTmp = new Promise((r) => { held = r; });
  const base = host.fsGuard;
  host.fsGuard = (op, path) => { base(op, path); if (op === "writeFile" && path.endsWith(".tmp")) { writeFileSync(path, ""); held(); return gate; } }; // empty on disk, as fs.writeFile leaves it mid-write
  drop("q-noop", { op: "noop" });
  startLoop();
  await atTmp;
  const mid = await drainCheck();
  assert.notEqual(mid.code, 0, "a reply is in flight");
  assert.match(mid.stdout, /staging file/);
  release();
  await answer("q-noop");
  const post = await drainCheck();
  assert.equal(post.code, 0, post.stdout);
});
