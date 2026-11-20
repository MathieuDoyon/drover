// The shared link-publish step (_lib/publish.js) and the sync hold built on it (_lib/hold.js). T-MWO2HDRQFIP.
// publishExclusive(dir, name, text, { fs, uniq }): write a COMPLETE uniquely named temp (wx, fsync), link(temp, dir/name) (fails if the name exists, never replaces),
// unlink the temp. Returns { ok: true } or { ok: false, code: "EEXIST" }; any other error is thrown (fail closed, never a rename fallback).
// createHold({ dir, fs, pid, host, alive, now }) -> { read, acquire, retarget, clear, clearManual }; pushGuard(hold, { resume }).
//   read()            -> null | { n, record } | { n, damaged: "hold.<n>.json" }      newest by NUMERIC n; leftover .tmp-* never count
//   acquire({machine, target}) -> { ok: true, record } | { ok: false, reason: busy|other-machine|foreign|damaged|error, message }
//   retarget(token, target)    -> { ok }       (we own the newest record: append a held record with a new target)
//   clear({ expectN, reason? }) -> { ok: true, record } | { ok: false, reason: "moved"|"error" }       (doctor: the newest must still be expectN)
//   clearManual(note)           -> { ok: true, record }     record.reason === "manual", record.note === note; works on a damaged newest too
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P = () => import("../_lib/publish.js");
const H = () => import("../_lib/hold.js");
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "hold-"))); roots.push(d); return d; };
const names = (d) => readdirSync(d).sort();
const spyFs = (over = {}) => {
  const log = [];
  const fs = { ...Object.fromEntries(["openSync", "writeSync", "fsyncSync", "closeSync", "linkSync", "unlinkSync", "renameSync"].map((k) => [k, (...a) => { log.push([k, ...a]); return over[k] ? over[k](...a) : nodefs[k](...a); }])) };
  return { fs, log };
};
const rec = (n, over = {}) => ({ n, state: "held", machine: "m1", token: `tok${n}`, pid: 4242, host: "h1", target: "abc", since: "2026-01-01T00:00:00.000Z", ...over });
const put = (d, n, r) => writeFileSync(join(d, `hold.${n}.json`), typeof r === "string" ? r : JSON.stringify(r));
const mk = async (d, o = {}) => (await H()).createHold({ dir: d, pid: 4242, host: "h1", alive: () => true, ...o });

// ---------------------------------------------------------------------------------------------------------- publish.js
test("publish: the file appears complete under its final name and no temp is left", async () => {
  const d = dir();
  const { publishExclusive } = await P();
  assert.deepEqual(publishExclusive(d, "hold.1.json", '{"a":1}'), { ok: true });
  assert.equal(readFileSync(join(d, "hold.1.json"), "utf8"), '{"a":1}');
  assert.deepEqual(names(d), ["hold.1.json"]);
});

test("publish: an existing name is never replaced: EEXIST is reported and the first content stays", async () => {
  const d = dir();
  const { publishExclusive } = await P();
  publishExclusive(d, "hold.1.json", "first");
  assert.deepEqual(publishExclusive(d, "hold.1.json", "second"), { ok: false, code: "EEXIST" });
  assert.equal(readFileSync(join(d, "hold.1.json"), "utf8"), "first");
  assert.deepEqual(names(d), ["hold.1.json"], "the loser's temp is removed");
});

test("publish (R1): the temp is created with wx, fsynced before the link, and has a unique name per write", async () => {
  const d = dir();
  const { publishExclusive } = await P();
  const { fs, log } = spyFs();
  publishExclusive(d, "a.json", "1", { fs });
  publishExclusive(d, "b.json", "2", { fs });
  const opens = log.filter((l) => l[0] === "openSync");
  assert.equal(opens.length, 2);
  assert.ok(opens.every((l) => l[2] === "wx"), "exclusive create");
  assert.notEqual(opens[0][1], opens[1][1], "never the same temp name twice");
  assert.ok(log.findIndex((l) => l[0] === "fsyncSync") < log.findIndex((l) => l[0] === "linkSync"), "fsync before link");
  assert.ok(log.findIndex((l) => l[0] === "linkSync") < log.findIndex((l) => l[0] === "unlinkSync"), "the temp is unlinked right after the link");
});

test("publish (R1): a temp left by a kill after the link shares the published inode; the next write never reopens it, so the published record cannot change", async () => {
  const d = dir();
  const { publishExclusive } = await P();
  const { fs } = spyFs({ unlinkSync: () => { throw new Error("killed before unlink"); } });
  assert.throws(() => publishExclusive(d, "hold.1.json", "published", { fs }), /killed before unlink/);
  const leftover = names(d).find((n) => n.startsWith(".tmp-"));
  assert.ok(leftover, "the temp is still there");
  assert.equal(statSync(join(d, leftover)).ino, statSync(join(d, "hold.1.json")).ino, "same inode: this is the hazard");
  const before = readFileSync(join(d, "hold.1.json"), "utf8");
  for (let i = 0; i < 3; i++) publishExclusive(d, `hold.${i + 2}.json`, `other ${i}`);
  assert.equal(readFileSync(join(d, leftover), "utf8"), before, "the leftover temp was never reopened");
  assert.equal(readFileSync(join(d, "hold.1.json"), "utf8"), before);
});

test("publish (review 6): a successful SHORT write is continued until every byte is written; the published record is complete", async () => {
  const d = dir();
  const { publishExclusive } = await P();
  const text = '{"n":1,"state":"held","machine":"m1","note":"é multi-byte"}\n';
  // returns normally having written at most 5 bytes
  const { fs, log } = spyFs({ writeSync: (fd, data, off = 0, len) => { const b = Buffer.isBuffer(data) ? data : Buffer.from(data); return nodefs.writeSync(fd, b, off, Math.min(5, len ?? b.length - off)); } });
  assert.deepEqual(publishExclusive(d, "hold.1.json", text, { fs }), { ok: true });
  assert.equal(readFileSync(join(d, "hold.1.json"), "utf8"), text);
  assert.ok(log.filter((l) => l[0] === "writeSync").length > 2, "several writes");
  assert.ok(log.findIndex((l) => l[0] === "fsyncSync") > log.map((l) => l[0]).lastIndexOf("writeSync"), "fsync after the last write");
});

test("publish: a kill after the temp is created, half written or before the link publishes nothing under the final name", async () => {
  const { publishExclusive } = await P();
  for (const [label, over] of [["after create", { writeSync: () => { throw new Error("killed"); } }], ["mid write", { writeSync: (fd, t) => { nodefs.writeSync(fd, String(t).slice(0, 2)); throw new Error("killed"); } }], ["before link", { linkSync: () => { throw new Error("killed"); } }]]) {
    const d = dir();
    const { fs } = spyFs(over);
    assert.throws(() => publishExclusive(d, "hold.1.json", "complete record", { fs }), /killed/, label);
    assert.ok(!names(d).includes("hold.1.json"), `${label}: no half record under the final name`);
  }
});

test("publish (R3): a link error other than EEXIST fails closed: it is thrown, nothing is published, and rename is never tried", async () => {
  const d = dir();
  const { publishExclusive } = await P();
  const { fs, log } = spyFs({ linkSync: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); } });
  assert.throws(() => publishExclusive(d, "hold.1.json", "x", { fs }), /not permitted/);
  assert.equal(log.filter((l) => l[0] === "renameSync").length, 0, "no fallback to rename");
  assert.ok(!names(d).includes("hold.1.json"));
});

// ---------------------------------------------------------------------------------------------------------- hold.js
test("hold: acquire on an empty dir publishes hold.1.json held, with every field; read() returns it", async () => {
  const d = dir();
  const h = await mk(d);
  const r = h.acquire({ machine: "m1", target: "abc" });
  assert.equal(r.ok, true);
  assert.deepEqual(names(d), ["hold.1.json"]);
  const f = JSON.parse(readFileSync(join(d, "hold.1.json"), "utf8"));
  assert.deepEqual(Object.keys(f).sort(), ["host", "machine", "n", "pid", "since", "state", "target", "token"]);
  assert.deepEqual({ n: f.n, state: f.state, machine: f.machine, target: f.target, pid: f.pid, host: f.host }, { n: 1, state: "held", machine: "m1", target: "abc", pid: 4242, host: "h1" });
  assert.equal(h.read().record.token, f.token);
});

test("hold (R3): the newest record is picked by NUMERIC n: hold.10 beats hold.9; leftover temps never count", async () => {
  const d = dir();
  put(d, 9, rec(9, { state: "held" }));
  put(d, 10, rec(10, { state: "cleared" }));
  writeFileSync(join(d, ".tmp-zzz"), "junk");
  const h = await mk(d);
  assert.equal(h.read().n, 10);
  assert.equal(h.read().record.state, "cleared");
  assert.equal(h.acquire({ machine: "m1", target: "t" }).ok, true);
  assert.ok(names(d).includes("hold.11.json"));
});

test("hold: a held record of a live owner (same host, pid alive) -> busy; of another machine -> other-machine; both say `held`", async () => {
  const d = dir();
  put(d, 1, rec(1));
  const h = await mk(d);
  const same = h.acquire({ machine: "m1", target: "t" });
  assert.deepEqual([same.ok, same.reason], [false, "busy"]);
  assert.match(same.message, /held/);
  const other = h.acquire({ machine: "m2", target: "t" });
  assert.deepEqual([other.ok, other.reason], [false, "other-machine"]);
  assert.match(other.message, /held/);
  assert.deepEqual(names(d), ["hold.1.json"], "nothing was written");
});

test("hold: a dead owner on the same machine is resumed: a new held record with our own token; for another machine it still blocks", async () => {
  const d = dir();
  put(d, 1, rec(1));
  const h = await mk(d, { alive: () => false, pid: 777 });
  assert.equal(h.acquire({ machine: "m2", target: "t" }).reason, "other-machine");
  const r = h.acquire({ machine: "m1", target: "next" });
  assert.equal(r.ok, true);
  const n = h.read();
  assert.deepEqual([n.n, n.record.state, n.record.pid, n.record.target], [2, "held", 777, "next"]);
  assert.notEqual(n.record.token, "tok1");
});

test("hold (R2): a record from another host is a live foreign owner: acquire never takes it, even if the pid looks dead", async () => {
  const d = dir();
  put(d, 1, rec(1, { host: "elsewhere" }));
  const h = await mk(d, { alive: () => false });
  const r = h.acquire({ machine: "m1", target: "t" });
  assert.deepEqual([r.ok, r.reason], [false, "foreign"]);
  assert.match(r.message, /held/);
  assert.match(r.message, /hold clear/, "the message names the owner's escape hatch");
});

test("hold (R2): a damaged newest record fails closed, names the file and the manual clear; the manual clear appends cleared/manual and deletes nothing", async () => {
  const d = dir();
  put(d, 1, rec(1, { state: "cleared" }));
  put(d, 2, "{ not json");
  const h = await mk(d);
  assert.deepEqual(h.read(), { n: 2, damaged: "hold.2.json" });
  const a = h.acquire({ machine: "m1", target: "t" });
  assert.deepEqual([a.ok, a.reason], [false, "damaged"]);
  assert.match(a.message, /hold\.2\.json/);
  assert.match(a.message, /drover machines hold clear --reason/);
  const { pushGuard } = await H();
  assert.equal(pushGuard(h).held, true);
  const c = h.clearManual("disk damage");
  assert.equal(c.ok, true);
  assert.deepEqual(names(d), ["hold.1.json", "hold.2.json", "hold.3.json"]);
  assert.equal(readFileSync(join(d, "hold.2.json"), "utf8"), "{ not json", "the damaged file is untouched");
  const r = h.read();
  assert.deepEqual([r.n, r.record.state, r.record.reason, r.record.note], [3, "cleared", "manual", "disk damage"]);
  assert.equal(pushGuard(h).held, false);
});

test("hold (R2): the manual clear releases a foreign-host hold; clear when nothing is held says so and writes nothing", async () => {
  const d = dir();
  const h = await mk(d);
  assert.equal(h.clearManual("x").ok, false);
  assert.deepEqual(names(d), []);
  put(d, 1, rec(1, { host: "elsewhere" }));
  assert.equal(h.clearManual("owner says so").ok, true);
  assert.equal(h.read().record.state, "cleared");
  assert.equal(h.acquire({ machine: "m1", target: "t" }).ok, true);
});

test("hold: pushGuard says held while the newest record is held (strict for pushers), and `resume` lets the owning machine through; the message says held", async () => {
  const d = dir();
  const { pushGuard } = await H();
  const h = await mk(d);
  assert.deepEqual(pushGuard(h), { held: false });
  put(d, 1, rec(1));
  const g = pushGuard(h);
  assert.equal(g.held, true);
  assert.match(g.message, /^held: m1 since 2026-01-01/);
  assert.match(g.message, /drover machines doctor m1/);
  assert.equal(pushGuard(h, { resume: "m1" }).held, false);
  assert.equal(pushGuard(h, { resume: "m2" }).held, true);
  put(d, 2, rec(2, { state: "cleared" }));
  assert.equal(pushGuard(h).held, false);
});

test("hold: two resumers read the same dead hold, then race to publish: exactly one wins, the other gets busy", async () => {
  const d = dir();
  put(d, 1, rec(1));
  const { createHold } = await H();
  const b = createHold({ dir: d, pid: 2, host: "h1", alive: () => false });
  let bResult = null;
  const { fs } = spyFs({ linkSync: (...a) => { if (!bResult) bResult = b.acquire({ machine: "m1", target: "B" }); return nodefs.linkSync(...a); } });
  const a = createHold({ dir: d, pid: 1, host: "h1", alive: (pid) => pid === 2, fs }); // A sees the owner of hold.1 (pid 4242) dead, and B (pid 2) alive once B has won
  const ra = a.acquire({ machine: "m1", target: "A" });
  assert.equal(bResult.ok, true, "B published hold.2 while A was paused before its link");
  assert.deepEqual([ra.ok, ra.reason], [false, "busy"]);
  const r = a.read();
  assert.deepEqual([r.n, r.record.target, r.record.pid], [2, "B", 2]);
  assert.deepEqual(names(d), ["hold.1.json", "hold.2.json"]);
});

test("hold: doctor clear racing a re-acquire: the re-acquire wins and the hold stands", async () => {
  const d = dir();
  put(d, 1, rec(1));
  const { createHold } = await H();
  const owner2 = createHold({ dir: d, pid: 2, host: "h1", alive: () => false });
  let raced = null;
  const { fs } = spyFs({ linkSync: (...a) => { if (!raced) raced = owner2.acquire({ machine: "m1", target: "again" }); return nodefs.linkSync(...a); } });
  const doctor = createHold({ dir: d, pid: 3, host: "h1", alive: () => true, fs });
  const c = doctor.clear({ expectN: 1 });
  assert.equal(raced.ok, true);
  assert.deepEqual([c.ok, c.reason], [false, "moved"]);
  const r = doctor.read();
  assert.deepEqual([r.n, r.record.state, r.record.target], [2, "held", "again"]);
});

test("hold: clear refuses when the newest is no longer the record the doctor judged", async () => {
  const d = dir();
  put(d, 1, rec(1));
  put(d, 2, rec(2));
  const h = await mk(d);
  assert.deepEqual([h.clear({ expectN: 1 }).ok, h.clear({ expectN: 1 }).reason], [false, "moved"]);
  const ok = h.clear({ expectN: 2 });
  assert.equal(ok.ok, true);
  assert.deepEqual([h.read().n, h.read().record.state], [3, "cleared"]);
});

test("hold: retarget appends a held record with the new target for the owner of the newest record only", async () => {
  const d = dir();
  const h = await mk(d);
  const a = h.acquire({ machine: "m1", target: "one" });
  assert.equal(h.retarget(a.record.token, "two").ok, true);
  assert.deepEqual([h.read().n, h.read().record.target, h.read().record.token], [2, "two", a.record.token]);
  assert.equal(h.retarget("someone-else", "three").ok, false);
  assert.equal(h.read().n, 2);
});

test("hold (R3): a link error other than EEXIST while acquiring fails closed: no hold taken, reason error", async () => {
  const d = dir();
  const { createHold } = await H();
  const { fs, log } = spyFs({ linkSync: () => { throw Object.assign(new Error("no hard links here"), { code: "ENOTSUP" }); } });
  const h = createHold({ dir: d, pid: 1, host: "h1", alive: () => true, fs });
  const r = h.acquire({ machine: "m1", target: "t" });
  assert.deepEqual([r.ok, r.reason], [false, "error"]);
  assert.match(r.message, /no hard links here/);
  assert.equal(log.filter((l) => l[0] === "renameSync").length, 0);
  assert.equal(names(d).filter((n) => n.startsWith("hold.")).length, 0);
});

test("hold: concurrent readers during a publication see a complete newest record or none, never half of one", async () => {
  const d = dir();
  const { createHold } = await H();
  const seen = [];
  const { fs } = spyFs({ writeSync: (fd, t) => { seen.push(createHold({ dir: d, pid: 9, host: "h1", alive: () => true }).read()); return nodefs.writeSync(fd, t); }, linkSync: (...a) => { seen.push(createHold({ dir: d, pid: 9, host: "h1", alive: () => true }).read()); return nodefs.linkSync(...a); } });
  createHold({ dir: d, pid: 1, host: "h1", alive: () => true, fs }).acquire({ machine: "m1", target: "t" });
  assert.deepEqual(seen, [null, null], "before the link there is no record, however far the temp is written");
  assert.equal(createHold({ dir: d, pid: 9, host: "h1", alive: () => true }).read().record.state, "held");
});
