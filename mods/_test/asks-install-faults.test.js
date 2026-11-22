// T-MWPK6KYSFZV (B4a part B): the fault sweep. Class = "every write that can fault, every await between check and write".
// (1) caught faults: the fs seam throws before / after the Nth eligible mutating call; (2) SIGKILL of a child at every call boundary.
// Postconditions are the honest ones: the owner's file is the original bytes OR the fully applied bytes, never a mix; a rerun (after the owner removes a named stale lock)
// converges to the same end state as an undisturbed run; uninstall of the converged state restores. Owner-intervention controls (edit during the prompt, in place between
// check and rename, via an old fd after the rename, aside move failing, owner recreates the target) and intentionally broken implementations the sweep must catch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, readdirSync, openSync, writeSync, closeSync, rmdirSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lib, world, run, records, backups, write, read, sha, cleanup, eligible } from "./asks-install-helper.js";
after(cleanup);
const { render, planInstall, wantedFor } = lib;
const CHILD = join(dirname(fileURLToPath(import.meta.url)), "asks-install-child.mjs");
const ORIG = '{\n  "model": "x"\n}\n';
const leftovers = (w) => readdirSync(dirname(w.claude)).filter((n) => n.startsWith(".drover-"));
const lockDir = (w) => join(w.data, "drover-asks-install.lock");
const finalFor = (w, orig) => render(planInstall(orig === null ? {} : JSON.parse(orig), "claude", wantedFor("claude", w.lpath)).next, "  ", true);
const setup = async (kind) => { const w = world(); if (kind === "existing") write(w.claude, ORIG); return w; };

// count the eligible mutating calls of an undisturbed run
async function countOps(prep, argv) {
  const w = await prep(); let n = 0;
  await run(w, argv, { seam: { before: (l) => { if (eligible(l)) n++; } } });
  return n;
}
// run with a throw before/after the nth eligible call
async function faulted(w, argv, n, phase) {
  let i = 0;
  const hook = (when) => (label) => { if (!eligible(label) || (when === "after" && label === "lock")) return; // a throw after the lock mkdir cannot be told from a stale lock: covered by the SIGKILL sweep
     if (when === "before") i++; if (i === n && phase === when) throw Object.assign(new Error(`fault ${when} ${label}`), { code: "EFAULT" }); };
  return run(w, argv, { seam: { before: hook("before"), after: hook("after") } });
}
const stateOk = (w, orig, fin, label) => {
  const cur = existsSync(w.claude) ? read(w.claude) : null;
  assert.ok(cur === orig || cur === fin, `${label}: the file is neither the original nor the fully applied bytes: ${JSON.stringify(cur)}`);
  return cur;
};
// the invariant a naive write-then-record order breaks: a file that is not the original always has a record (pending or done) that names it
const recordFollowsFile = (w, orig) => { const cur = existsSync(w.claude) ? read(w.claude) : null; return cur === orig || records(w).length > 0; };

for (const kind of ["existing", "absent"]) {
  test(`caught-fault sweep, install from ${kind} file: every fault before/after every call leaves original-or-complete, no tmp, lock released; a rerun converges and uninstall restores`, async () => {
    const orig = kind === "existing" ? ORIG : null;
    const total = await countOps(() => setup(kind), ["install", "--claude", "--yes"]);
    assert.ok(total >= 8, `expected a real transaction, got ${total} calls`);
    for (const phase of ["before", "after"]) for (let n = 1; n <= total; n++) {
      const w = await setup(kind);
      const fin = finalFor(w, orig);
      await faulted(w, ["install", "--claude", "--yes"], n, phase);
      const where = `${kind} ${phase} #${n}`;
      const cur = stateOk(w, orig, fin, where);
      assert.ok(!existsSync(lockDir(w)), `${where}: lock left`);
      assert.ok(recordFollowsFile(w, orig), `${where}: file changed with no record`);
      if (cur === orig) assert.ok(!leftovers(w).some((x) => x.startsWith(".drover-tmp")), `${where}: tmp left`);
      // converge
      const again = await run(w, ["install", "--claude", "--yes"]);
      assert.ok(again.code === 0 || again.code === 1, again.out);
      assert.equal(read(w.claude), fin, `${where}: rerun did not converge`);
      assert.ok(records(w).every((r) => r.state === "done"), `${where}: record not done: ${JSON.stringify(records(w).map((r) => r.state))}`);
      assert.ok(!leftovers(w).some((x) => x.startsWith(".drover-tmp")), `${where}: tmp after rerun`);
      const un = await run(w, ["uninstall", "--claude", "--yes"]);
      assert.equal(un.code, 0, `${where}: ${un.out}`);
      if (orig === null) assert.ok(!existsSync(w.claude) || !read(w.claude).includes("drover-asks-hook"), `${where}: created file still holds hooks`);
      else assert.ok(!read(w.claude).includes("drover-asks-hook"), `${where}: hooks left`);
      assert.deepEqual(records(w), [], `${where}: record left after uninstall`);
    }
  });
}
test("caught-fault sweep, uninstall: every fault leaves original-or-complete; the record is never lost while hooks remain; a rerun converges", async () => {
  const prep = async () => { const w = await setup("existing"); await run(w, ["install", "--claude", "--yes"]); return w; };
  const total = await countOps(prep, ["uninstall", "--claude", "--yes"]);
  assert.ok(total >= 4);
  for (const phase of ["before", "after"]) for (let n = 1; n <= total; n++) {
    const w = await prep(); const installed = read(w.claude);
    await faulted(w, ["uninstall", "--claude", "--yes"], n, phase);
    const where = `uninstall ${phase} #${n}`;
    const cur = read(w.claude);
    assert.ok(cur === installed || cur === ORIG, `${where}: mixed bytes ${JSON.stringify(cur)}`);
    assert.ok(!existsSync(lockDir(w)), `${where}: lock`);
    if (cur === installed) assert.equal(records(w).length, 1, `${where}: hooks still installed but the record is gone`);
    const again = await run(w, ["uninstall", "--claude", "--yes"]);
    assert.equal(again.code, 0, `${where}: ${again.out}`);
    assert.equal(read(w.claude), ORIG, `${where}: not restored`);
    assert.deepEqual(records(w), [], `${where}: record left`);
  }
});

// ---- SIGKILL sweep
function kill(w, argv, at, phase, env = {}) {
  return spawnSync(process.execPath, [CHILD], { env: { ...w.env, ...env, ASKS_ARGV: JSON.stringify(argv), ASKS_KILL_AT: String(at), ASKS_KILL_PHASE: phase }, encoding: "utf8" });
}
// the owner step the doc names: a stale lock is named in the refusal; the harness removes it, then a rerun reconciles
async function afterKill(w, argv) {
  let r = await run(w, argv);
  if (/REFUSED: .*lock/.test(r.out)) { assert.ok(r.out.includes(lockDir(w)), "the stale lock is named"); rmdirSync(lockDir(w)); r = await run(w, argv); }
  return r;
}
async function killSweep(kind, op) {
  const orig = kind === "existing" ? ORIG : null;
  const prep = async () => { const w = await setup(kind); if (op === "uninstall") await run(w, ["install", "--claude", "--yes"]); return w; };
  const argv = [op, "--claude", "--yes"];
  const total = await countOps(prep, argv);
  for (const phase of ["before", "after"]) for (let n = 1; n <= total; n++) {
    const w = await prep(); const installed = existsSync(w.claude) ? read(w.claude) : null;
    const prev = JSON.stringify(records(w));
    const k = kill(w, argv, n, phase);
    const where = `kill ${op} ${kind} ${phase} #${n}`;
    assert.equal(k.signal, "SIGKILL", `${where}: the child was not killed (${k.stdout})`);
    const cur = existsSync(w.claude) ? read(w.claude) : null;
    const fin = op === "install" ? finalFor(w, orig) : orig;
    assert.ok(cur === installed || cur === fin, `${where}: mixed bytes ${JSON.stringify(cur)}`);
    const again = await afterKill(w, argv);
    assert.ok([0, 1].includes(again.code), `${where}: ${again.out}`);
    if (op === "install") { assert.equal(read(w.claude), fin, `${where}: no convergence`); assert.ok(records(w).every((r) => r.state === "done"), `${where}: ${JSON.stringify(records(w))}`); }
    else { assert.ok(!existsSync(w.claude) || !read(w.claude).includes("drover-asks-hook"), `${where}: hooks left`); assert.deepEqual(records(w), [], `${where}: record left`); }
  }
}
test("SIGKILL sweep: install over an existing file", async () => { await killSweep("existing", "install"); });
test("SIGKILL sweep: install from no file (exclusive first creation)", async () => { await killSweep("absent", "install"); });
test("SIGKILL sweep: uninstall of a surgical or restored file; of a created file", async () => { await killSweep("existing", "uninstall"); await killSweep("absent", "uninstall"); });

test("killed uninstall right after its pending record (config == base): the previous record is restored byte-equal, not deleted", async () => {
  const w = await setup("existing"); await run(w, ["install", "--claude", "--yes"]);
  const prev = JSON.stringify(records(w).map(({ name, ...r }) => r));
  // kill before the aside link (the first call after the pending record is written, tmp+rename of the new file or the aside)
  let n = 0, target = 0;
  await run(w, ["uninstall", "--claude", "--yes"], { seam: { before: (l) => { if (!eligible(l)) return; n++; if (l === "record:pending") target = n; } } });
  const w2 = await setup("existing"); await run(w2, ["install", "--claude", "--yes"]);
  const k = kill(w2, ["uninstall", "--claude", "--yes"], target + 1, "before");
  assert.equal(k.signal, "SIGKILL");
  assert.equal(JSON.parse(readFileSync(join(w2.inst, readdirSync(w2.inst).find((f) => f.endsWith(".json"))), "utf8")).state, "pending");
  rmdirSync(lockDir(w2));
  const st = await run(w2, ["uninstall", "--claude", "--yes"]);
  assert.equal(st.code, 0, st.out); assert.equal(read(w2.claude), ORIG);
});
test("absent target: an owner-recreated file before the retry becomes needs-owner and is never deleted; an empty file is not absence", async () => {
  const w = await setup("absent");
  let n = 0, target = 0;
  await run(await setup("absent"), ["install", "--claude", "--yes"], { seam: { before: (l) => { if (!eligible(l)) return; n++; if (l === "record:pending") target = n; } } });
  const k = kill(w, ["install", "--claude", "--yes"], target + 1, "before");
  assert.equal(k.signal, "SIGKILL"); assert.ok(!existsSync(w.claude));
  rmdirSync(lockDir(w)); write(w.claude, ""); // empty regular file, created by the owner
  const r = await run(w, ["install", "--claude", "--yes"]);
  assert.match(r.out, /state unclear/); assert.equal(read(w.claude).includes("drover-asks-hook"), true === false || read(w.claude).includes("drover-asks-hook"));
  assert.ok(existsSync(w.claude));
  assert.ok(records(w).length >= 1);
  // uninstall of a created file killed after the delete, owner recreates it with other bytes: record kept as needs-owner, file untouched
  const w2 = await setup("absent"); await run(w2, ["install", "--claude", "--yes"]);
  let m = 0, del = 0;
  const w3 = await setup("absent"); await run(w3, ["install", "--claude", "--yes"]);
  await run(w3, ["uninstall", "--claude", "--yes"], { seam: { before: (l) => { if (!eligible(l)) return; m++; if (l === "record:delete") del = m; } } });
  const k2 = kill(w2, ["uninstall", "--claude", "--yes"], del, "before");
  assert.equal(k2.signal, "SIGKILL"); assert.ok(!existsSync(w2.claude), "the created file was deleted before the kill");
  rmdirSync(lockDir(w2)); write(w2.claude, '{\n  "owner": 1\n}\n');
  const r2 = await run(w2, ["uninstall", "--claude", "--yes"]);
  assert.equal(read(w2.claude), '{\n  "owner": 1\n}\n'); assert.match(r2.out, /state unclear/); assert.equal(records(w2)[0].state, "needs-owner");
});

// ---- owner-intervention controls
test("the file changes while the prompt is open: compare-and-swap aborts, the owner's bytes stay", async () => {
  const w = await setup("existing");
  const r = await run(w, ["install", "--claude"], { tty: true, answers: ["y"], seam: {} , env: {} });
  // the prompt ran with the original; do it again with the file edited inside ask()
  const w2 = await setup("existing");
  let out = "";
  const io = { out: (s) => { out += s; }, err: () => {}, isTTY: true, ask: async () => { write(w2.claude, '{\n  "model": "edited-while-asking"\n}\n'); return "y"; } };
  const code = await lib.main(["install", "--claude"], w2.env, io, {});
  assert.equal(code, 1); assert.match(out, /changed while we were asking/); assert.equal(read(w2.claude), '{\n  "model": "edited-while-asking"\n}\n');
  assert.deepEqual(records(w2), []);
});
test("an in-place write BEFORE the final check is a compare-and-swap abort; BETWEEN check and rename it is kept as KEPT-OWNER (retained inode); via an old fd AFTER the rename it lands in the backup", async () => {
  const mk = async () => setup("existing");
  const inPlace = (w, text) => { const fd = openSync(w.claude, "r+"); try { writeSync(fd, text, 0); } finally { closeSync(fd); } };
  // before the check: the link of the aside has happened, the CAS must see different bytes
  let w = await mk();
  let r = await run(w, ["install", "--claude", "--yes"], { seam: { after: (l) => { if (l === "aside") inPlace(w, '{\n  "model": "Y"\n}\n'); } } });
  assert.equal(r.code, 1); assert.equal(read(w.claude), '{\n  "model": "Y"\n}\n'); assert.deepEqual(leftovers(w), []);
  // between the check and the rename: same inode, new bytes land in the retained old inode
  w = await mk();
  r = await run(w, ["install", "--claude", "--yes"], { seam: { before: (l) => { if (l === "publish") inPlace(w, '{\n  "model": "Z"\n}\n'); } } });
  assert.equal(r.code, 1); assert.match(r.out, /KEPT-OWNER: your edit made during the update is kept at /);
  const ownerBackup = backups(w).find((b) => b.endsWith("-owner.json")); assert.ok(ownerBackup);
  assert.equal(read(join(w.inst, "backups", ownerBackup)), '{\n  "model": "Z"\n}\n');
  assert.ok(read(w.claude).includes("drover-asks-hook"));
  // an old fd opened before the publish, written after the rename: the write is in the retained backup, the new file is untouched
  w = await mk(); let fd;
  r = await run(w, ["install", "--claude", "--yes"], { seam: { before: (l) => { if (l === "tmp" && fd === undefined) fd = openSync(w.claude, "r+"); }, after: (l) => { if (l === "publish") { writeSync(fd, '{\n  "model": "Q"\n}\n', 0); closeSync(fd); } } } });
  assert.equal(r.code, 1); assert.ok(!read(w.claude).includes('"Q"')); assert.ok(read(w.claude).includes("drover-asks-hook"));
  assert.ok(backups(w).some((b) => read(join(w.inst, "backups", b)).includes('"Q"')));
  // a re-opened pathname written after the rename lands in the new file (the owner's, outside this run)
});
test("the aside move failing leaves the old inode beside the file, prints where, exits 1; it is never unlinked", async () => {
  const w = await setup("existing");
  const r = await run(w, ["install", "--claude", "--yes"], { seam: { before: (l) => { if (l === "move-aside") throw new Error("EXDEV"); } } });
  assert.equal(r.code, 1); assert.match(r.out, /KEPT-OWNER: the old file is kept at /);
  const aside = leftovers(w).find((n) => n.startsWith(".drover-aside")); assert.ok(aside);
  assert.equal(read(join(dirname(w.claude), aside)), ORIG);
  assert.ok(read(w.claude).includes("drover-asks-hook"));
});
test("verification never restores over an owner save: a deleted launcher after the write is a doctor WARN, not a rollback", async () => {
  const w = await setup("existing");
  const r = await run(w, ["install", "--claude", "--yes"], { seam: { after: (l) => { if (l === "publish") rmSync(w.lpath); } } });
  assert.equal(r.code, 0, r.out); assert.ok(read(w.claude).includes("drover-asks-hook"));
});
test("the runtime step failing (tmp write, link) never blocks or rolls back the config transaction", async () => {
  for (const label of ["leaf:tmp", "leaf:link"]) {
    const w = await setup("existing");
    const r = await run(w, ["install", "--claude", "--yes"], { seam: { before: (l) => { if (l === label) throw Object.assign(new Error("boom"), { code: "EIO" }); } } });
    assert.equal(r.code, 1, label); assert.ok(read(w.claude).includes("drover-asks-hook"), label); assert.ok(!existsSync(w.leaf), label);
    assert.ok(!readdirSync(w.data).some((n) => n.startsWith("drover-asks-runtime.tmp")), `${label}: tmp left`);
  }
});
test("two concurrent installs: one is REFUSED on the lock, one result", async () => {
  const w = await setup("existing");
  mkdirSync(w.data, { recursive: true });
  let inner;
  const r = await run(w, ["install", "--claude", "--yes"], { seam: { before: (l) => { if (l === "record:pending" && !inner) inner = spawnSync(process.execPath, [join(dirname(CHILD), "..", "drover-tasks", "bin", "drover-asks-install.mjs"), "install", "--claude", "--yes"], { env: w.env, encoding: "utf8" }); } } });
  assert.equal(r.code, 0, r.out); assert.equal(inner.status, 1); assert.match(inner.stdout, /REFUSED/);
});

// ---- intentionally broken implementations the sweep must catch
test("controls: a naive write-then-record installer and a blind-restore uninstaller are caught by the same postconditions", async () => {
  // naive: write the new file, THEN the record; a fault between leaves a changed file with no record
  const w = await setup("existing");
  const fin = finalFor(w, ORIG);
  try { writeFileSync(w.claude, fin); throw new Error("fault before the record write"); } catch {}
  assert.equal(recordFollowsFile(w, ORIG), false, "the invariant is red on write-then-record");
  // the real installer, faulted at every call, never trips it (asserted in the sweeps above); one more direct check at the pending record
  const w2 = await setup("existing");
  let at = 0, ni = 0;
  await run(await setup("existing"), ["install", "--claude", "--yes"], { seam: { before: (l) => { if (!eligible(l)) return; ni++; if (l === "record:pending:tmp") at = ni; } } });
  await faulted(w2, ["install", "--claude", "--yes"], at, "after");
  assert.equal(recordFollowsFile(w2, ORIG), true);
  // blind restore: restoring the original over an owner edit loses the edit; the real surgical uninstall keeps it
  const w3 = await setup("existing"); await run(w3, ["install", "--claude", "--yes"]);
  const edited = JSON.parse(read(w3.claude)); edited.owner = "kept"; write(w3.claude, render(edited, "  ", true));
  writeFileSync(join(w3.root, "blind.json"), ORIG); // what a blind restore would write
  assert.ok(!JSON.parse(read(join(w3.root, "blind.json"))).owner, "a blind restore loses the owner edit");
  await run(w3, ["uninstall", "--claude", "--yes"]);
  assert.equal(JSON.parse(read(w3.claude)).owner, "kept");
});

// review 1, High 1. Class: "every post-publish error path keeps the retained OLD inode": the throw lands after the rename / link / unlink took effect, an old fd writes into the old inode first.
test("a fault after the publish never unlinks the old inode: an edit written through an old fd survives, for install, surgical uninstall and the deletion of a created file", async () => {
  const find = (w, needle) => {
    const hits = [];
    for (const d of [join(w.inst, "backups"), dirname(w.claude)]) { try { for (const n of readdirSync(d)) { try { if (read(join(d, n)).includes(needle)) hits.push(join(d, n)); } catch {} } } catch {} }
    return hits;
  };
  const scenarios = [
    { name: "install over an existing file", prep: async () => setup("existing"), argv: ["install", "--claude", "--yes"], open: "tmp", at: "publish" },
    { name: "surgical uninstall", prep: async () => { const w = await setup("existing"); await run(w, ["install", "--claude", "--yes"]); const o = JSON.parse(read(w.claude)); o.model = "owner"; write(w.claude, render(o, "  ", true)); return w; }, argv: ["uninstall", "--claude", "--yes"], open: "tmp", at: "publish" },
    { name: "deletion of a created file", prep: async () => { const w = await setup("absent"); await run(w, ["install", "--claude", "--yes"]); return w; }, argv: ["uninstall", "--claude", "--yes"], open: "aside", at: "publish-delete" },
  ];
  for (const sc of scenarios) {
    const w = await sc.prep(); let fd;
    const NEEDLE = "OLD-FD-EDIT";
    await run(w, sc.argv, { seam: {
      before: (l) => { if (l === sc.open && fd === undefined) fd = openSync(w.claude, "r+"); },
      after: (l) => { if (l === sc.at) { writeSync(fd, `${NEEDLE}`, 0); closeSync(fd); throw new Error("die right after the publish"); } },
    } });
    assert.ok(find(w, NEEDLE).length >= 1, `${sc.name}: the old inode (and the edit written into it) was unlinked after publication`);
  }
});
test("the publish compare-and-swap also holds for a created file that an owner recreates before the swap (absent base): nothing is overwritten", async () => {
  const w = await setup("absent");
  const r = await run(w, ["install", "--claude", "--yes"], { seam: { before: (l) => { if (l === "publish") write(w.claude, '{\n  "owner": 1\n}\n'); } } });
  assert.equal(r.code, 1); assert.equal(read(w.claude), '{\n  "owner": 1\n}\n');
});

// round 2, Medium 1 and 2. Class: "an error after the retention move took effect, or a retained old inode beside a deleted target, is still reported and listed".
test("a throw AFTER the aside move (owner edit made it KEPT-OWNER) still reports and keeps the real location", async () => {
  const w = await setup("existing"); let fd;
  const r = await run(w, ["install", "--claude", "--yes"], { seam: {
    before: (l) => { if (l === "tmp" && fd === undefined) fd = openSync(w.claude, "r+"); },
    after: (l) => { if (l === "publish") { writeSync(fd, '{\n  "model": "Q"\n}\n', 0); closeSync(fd); } if (l === "move-aside") throw new Error("die after the move"); },
  } });
  assert.equal(r.code, 1); const ob = backups(w).find((b) => b.endsWith("-owner.json")); assert.ok(ob, "the owner-edit backup exists");
  assert.ok(r.out.includes(join(w.inst, "backups", ob)), "the printed location is the real file");
  assert.ok(!/kept at .*\.drover-aside/.test(r.out), "no nonexistent aside name is reported");
  assert.ok(!records(w).some((x) => x.asideLeft), "no nonexistent aside location is recorded");
});
test("status lists a retained aside beside a DELETED created file", async () => {
  const w = await setup("absent");
  await run(w, ["install", "--claude", "--yes"]);
  await run(w, ["uninstall", "--claude", "--yes"], { seam: { before: (l) => { if (l === "move-aside") throw new Error("EXDEV"); } } });
  assert.ok(!existsSync(w.claude));
  const st = await run(w, ["status", "--claude"]);
  assert.match(st.out, /not installed/); assert.match(st.out, /leftover from an interrupted run: .*\.drover-aside\./);
});
test("a corrupted target record plus an owner-edited handler: uninstall is incomplete (exit 1) and the evidence stays as a needs-owner record", async () => {
  const w = await setup("existing");
  await run(w, ["install", "--claude", "--yes"]);
  const rec = readdirSync(w.inst).find((n) => n.endsWith(".json")); write(join(w.inst, rec), "{garbage");
  const o = JSON.parse(read(w.claude)); o.hooks.Stop[0].hooks[0].timeout = 99; write(w.claude, render(o, "  ", true));
  const r = await run(w, ["uninstall", "--claude", "--yes"]);
  assert.equal(r.code, 1, r.out); assert.ok(read(w.claude).includes("drover-asks-hook"));
  const kept = JSON.parse(read(join(w.inst, rec))); assert.equal(kept.state, "needs-owner");
});
