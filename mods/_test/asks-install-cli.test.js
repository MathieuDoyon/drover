// T-MWPK6KYSFZV (B4a part B): `drover asks-hook install|uninstall|status` end to end in a scratch tree: exact diff, ask first, merge never overwrites, KEPT, refusals, backups,
// uninstall restores, the runtime leaf (created, KEPT, never removed), the registered launcher with no node on PATH, doctor parity. Never the real home, ~/.claude or ~/.codex.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, lstatSync, readdirSync, utimesSync, rmSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { lib, world, run, records, backups, snapshot, write, read, sha, cleanup, MOD, BIN, tmp } from "./asks-install-helper.js";
after(cleanup);
const { render, planInstall, wantedFor } = lib;
const Y = ["install", "--yes"];

test("install into a missing file: shows the exact diff against /dev/null, creates it 0600, records, exit 0", async () => {
  const w = world();
  const r = await run(w, ["install", "--claude", "--yes"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /--- \/dev\/null\n\+\+\+ .*settings\.json\n@@ -0,0 \+1,\d+ @@\n\+\{/);
  assert.equal(statSync(w.claude).mode & 0o777, 0o600);
  const root = JSON.parse(read(w.claude));
  assert.deepEqual(Object.keys(root.hooks), ["PermissionRequest", "Notification", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionEnd"]);
  assert.equal(root.hooks.SessionEnd[0].hooks[0].timeout, 1);
  const rec = records(w); assert.equal(rec.length, 1); assert.equal(rec[0].state, "done"); assert.equal(rec[0].origin.created.file, true);
  assert.equal(read(w.leaf), process.execPath + "\n"); assert.equal(statSync(w.leaf).mode & 0o777, 0o600);
});
test("no flag: both targets, each its own prompt; no tty and no --yes prints the diff, writes nothing, exit 2", async () => {
  const w = world();
  const before = snapshot(w.home);
  const r = await run(w, ["install"]);
  assert.equal(r.code, 2); assert.match(r.out, /--- \/dev\/null/); assert.match(r.out, /no terminal to ask on/);
  assert.deepEqual(snapshot(w.home), before); assert.ok(!existsSync(w.leaf)); assert.deepEqual(records(w), []);
});
test("a tty asks per target; n/EOF writes nothing (bytes, no record, no backup, no leaf), exit 0", async () => {
  const w = world();
  write(w.claude, '{\n  "theme": "dark"\n}\n');
  const r = await run(w, ["install", "--claude"], { tty: true, answers: ["n"] });
  assert.equal(r.code, 0); assert.equal(r.asked.length, 1); assert.match(r.asked[0], /Apply to .*settings\.json\? \[y\/N\]/);
  assert.equal(read(w.claude), '{\n  "theme": "dark"\n}\n'); assert.deepEqual(records(w), []); assert.deepEqual(backups(w), []); assert.ok(!existsSync(w.leaf));
  const both = await run(w, ["install"], { tty: true, answers: ["y", ""] });
  assert.equal(both.asked.length, 2);
  assert.ok(read(w.claude).includes("drover-asks-hook")); assert.ok(!existsSync(w.codex));
});
test("merge keeps unrelated keys, other hooks (same event, same matcher), order, indent and no trailing newline; ours last; backup is the old bytes", async () => {
  for (const [ind, nl] of [["    ", true], ["\t", false]]) {
    const w = world();
    const orig = render({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }], PermissionRequest: [{ hooks: [{ type: "command", command: "echo other" }] }] }, z: [1, 2] }, ind, nl);
    write(w.claude, orig, 0o640);
    const r = await run(w, ["install", "--claude", "--yes"]);
    assert.equal(r.code, 0, r.out);
    const next = read(w.claude);
    const root = JSON.parse(next);
    assert.deepEqual(Object.keys(root), ["model", "hooks", "z"]);
    assert.equal(root.hooks.Stop[0].hooks[0].command, "echo mine"); assert.match(root.hooks.Stop[1].hooks[0].command, /drover-asks-hook' clear$/);
    assert.equal(root.hooks.PermissionRequest[0].hooks[0].command, "echo other");
    assert.equal(next.endsWith("\n"), nl); assert.ok(next.includes(`\n${ind}"hooks"`));
    assert.equal(statSync(w.claude).mode & 0o777, 0o640);
    const b = backups(w); assert.equal(b.length, 1); assert.equal(read(join(w.inst, "backups", b[0])), orig);
    assert.equal(statSync(join(w.inst, "backups", b[0])).mode & 0o777, 0o600);
  }
});
test("--yes still prints the diff; a second install is a no-op without a prompt; bytes and record unchanged", async () => {
  const w = world();
  const r1 = await run(w, ["install", "--codex", "--yes"]);
  assert.match(r1.out, /^\[codex\]|--- /m); assert.match(r1.out, /Codex asks you to trust the new hook/);
  const bytes = read(w.codex), recs = JSON.stringify(records(w));
  const r2 = await run(w, ["install", "--codex"], { tty: true });
  assert.equal(r2.code, 0); assert.match(r2.out, /already installed/); assert.equal(r2.asked.length, 0);
  assert.equal(read(w.codex), bytes); assert.equal(JSON.stringify(records(w)), recs);
  assert.equal(Object.keys(JSON.parse(bytes).hooks).length, 4);
});
test("refusals leave the file untouched with a reason and the snippet to add by hand", async () => {
  const w = world();
  const cases = { invalid: "{", bom: "﻿{}\n", array: "[]\n", reformat: '{"a":1}\n', hooksString: '{\n  "hooks": "x"\n}\n' };
  for (const [name, text] of Object.entries(cases)) {
    write(w.claude, text);
    const r = await run(w, ["install", "--claude", "--yes"]);
    assert.equal(r.code, 1, name); assert.match(r.out, /REFUSED/); assert.match(r.out, /to add it by hand/); assert.equal(read(w.claude), text, name);
  }
  assert.deepEqual(records(w), []); assert.deepEqual(backups(w), []);
  write(w.claude, "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal((await run(w, ["install", "--claude", "--yes"])).code, 1);
});
test("a FIFO and a dangling symlink are refused without hanging", async () => {
  const w = world();
  spawnSync("mkfifo", [w.claude]);
  assert.equal((await run(w, ["install", "--claude", "--yes"])).code, 1);
  rmSync(w.claude); symlinkSync(join(w.root, "nowhere.json"), w.claude);
  const r = await run(w, ["install", "--claude", "--yes"]);
  assert.equal(r.code, 1); assert.match(r.out, /points nowhere/); assert.ok(!existsSync(join(w.root, "nowhere.json")));
});
test("a symlinked target keeps the link and edits the real file", async () => {
  const w = world();
  const real = join(w.root, "dotfiles", "settings.json"); mkdirSync(join(w.root, "dotfiles")); write(real, "{}\n");
  symlinkSync(real, w.claude);
  assert.equal((await run(w, ["install", "--claude", "--yes"])).code, 0);
  assert.equal(readlinkSync(w.claude), real); assert.ok(read(real).includes("drover-asks-hook"));
});
test("an owner-edited entry of ours is KEPT: exit 1, nothing else changed for that event, wanted entry printed", async () => {
  const w = world();
  await run(w, ["install", "--codex", "--yes"]);
  const edited = JSON.parse(read(w.codex)); edited.hooks.Stop[0].hooks[0].timeout = 42; delete edited.hooks.PostToolUse;
  write(w.codex, render(edited, "  ", true));
  const r = await run(w, ["install", "--codex", "--yes"]);
  assert.equal(r.code, 1); assert.match(r.out, /KEPT Stop/); assert.match(r.out, /wanted entry: /);
  const after = JSON.parse(read(w.codex));
  assert.equal(after.hooks.Stop[0].hooks[0].timeout, 42); assert.equal(after.hooks.PostToolUse.length, 1);
});
test("launcher missing, not executable, or inside a linked worktree: refused", async () => {
  const w = world({ launcher: false });
  let r = await run(w, ["install", "--claude", "--yes"]); assert.equal(r.code, 1); assert.match(r.out, /launcher is missing/);
  write(w.lpath, "#!/bin/sh\n", 0o644);
  r = await run(w, ["install", "--claude", "--yes"]); assert.equal(r.code, 1);
  assert.ok(!existsSync(w.claude));
  const w2 = world({ launcher: false });
  const wt = join(w2.root, "wt"); mkdirSync(join(wt, "bin"), { recursive: true }); writeFileSync(join(wt, ".git"), "gitdir: /x\n");
  writeFileSync(join(wt, "bin", "drover-asks-hook"), "#!/bin/sh\n", { mode: 0o755 });
  rmSync(join(w2.app, "mods", "drover-tasks"), { recursive: true }); mkdirSync(join(w2.app, "mods"), { recursive: true }); symlinkSync(wt, join(w2.app, "mods", "drover-tasks"));
  r = await run(w2, ["install", "--claude", "--yes"]); assert.equal(r.code, 1); assert.match(r.out, /linked git worktree|launcher is missing/);
});
test("a CLI that is not installed (config dir absent) is skipped with a line", async () => {
  const w = world({ codexDir: false });
  const r = await run(w, ["install", "--yes"]);
  assert.equal(r.code, 0); assert.match(r.out, /\[codex\] skipped/); assert.ok(existsSync(w.claude));
});

test("uninstall restores byte-exact when nothing changed since, deletes a file we created, keeps the backup; second uninstall is a no-op", async () => {
  const w = world();
  const orig = '{\n  "model": "x"\n}\n'; write(w.claude, orig);
  await run(w, ["install", "--yes"]);
  const r = await run(w, ["uninstall", "--yes"]);
  assert.equal(r.code, 0, r.out); assert.equal(read(w.claude), orig); assert.match(r.out, /restored byte-exact/);
  assert.ok(!existsSync(w.codex)); // created by install: gone again
  assert.deepEqual(records(w), []); assert.ok(backups(w).length >= 1);
  assert.match(r.out, /runtime file left in place/);
  const again = await run(w, ["uninstall", "--yes"]); assert.equal(again.code, 0); assert.match(again.out, /nothing of ours/);
});
test("after an owner edit elsewhere: surgical, the edit stays; an owner hook in our group stays; round trip equals a first install", async () => {
  const w = world();
  await run(w, ["install", "--claude", "--yes"]);
  const first = read(w.claude);
  const r0 = JSON.parse(first); r0.model = "owner-edit"; r0.hooks.Stop[0].hooks.push({ type: "command", command: "echo owner" });
  write(w.claude, render(r0, "  ", true));
  const r = await run(w, ["uninstall", "--claude", "--yes"]);
  assert.equal(r.code, 0, r.out);
  const root = JSON.parse(read(w.claude));
  assert.equal(root.model, "owner-edit"); assert.deepEqual(root.hooks.Stop[0].hooks, [{ type: "command", command: "echo owner" }]);
  assert.ok(!read(w.claude).includes("drover-asks-hook"));
  assert.deepEqual(records(w), []);
});
test("uninstall with no record removes a hand-installed set; an edited entry of ours is KEPT (exit 1)", async () => {
  const w = world();
  const wanted = wantedFor("codex", w.lpath);
  write(w.codex, render(planInstall({}, "codex", wanted).next, "  ", true));
  const r = await run(w, ["uninstall", "--codex", "--yes"]);
  assert.equal(r.code, 0, r.out); assert.ok(!read(w.codex).includes("drover-asks-hook"));
  const h = planInstall({}, "codex", wanted).next; h.hooks.Stop[0].hooks[0].timeout = 9;
  write(w.codex, render(h, "  ", true));
  const k = await run(w, ["uninstall", "--codex", "--yes"]);
  assert.equal(k.code, 1); assert.match(k.out, /KEPT Stop/); assert.equal(JSON.parse(read(w.codex)).hooks.Stop[0].hooks[0].timeout, 9);
});
test("repair: after the owner removes a whole event the install adds it back, and uninstall is then SURGICAL, never a byte restore (even with equal bytes)", async () => {
  const w = world();
  const orig = '{\n  "model": "x"\n}\n'; write(w.claude, orig);
  await run(w, ["install", "--claude", "--yes"]);
  const full = read(w.claude);
  const o = JSON.parse(full); delete o.hooks.SessionEnd; write(w.claude, render(o, "  ", true));
  const rep = await run(w, ["install", "--claude", "--yes"]);
  assert.equal(rep.code, 0, rep.out); assert.equal(read(w.claude), full); // equal bytes to the first install
  assert.equal(records(w)[0].origin.repaired, true);
  const un = await run(w, ["uninstall", "--claude", "--yes"]);
  assert.equal(un.code, 0, un.out);
  assert.ok(!read(w.claude).includes("drover-asks-hook"));
  assert.equal(JSON.parse(read(w.claude)).model, "x");
  assert.ok(!/restored byte-exact/.test(un.out), "a repaired install must never take the byte-exact restore path");
});
test("a repair after the owner removed ALL our groups still sets repaired", async () => {
  const w = world();
  await run(w, ["install", "--codex", "--yes"]);
  const o = JSON.parse(read(w.codex)); o.hooks = {}; write(w.codex, render(o, "  ", true));
  await run(w, ["install", "--codex", "--yes"]);
  assert.equal(records(w)[0].origin.repaired, true);
});
test("a record of another profile (same bytes elsewhere) never deletes or restores this file", async () => {
  const w = world();
  const a = join(w.root, "a.json"), b = join(w.root, "b.json");
  await run(w, ["install", "--claude", "--yes", "--claude-settings", a]);
  write(b, read(a));
  const r = await run(w, ["uninstall", "--claude", "--yes", "--claude-settings", b]);
  assert.equal(r.code, 0, r.out); assert.ok(existsSync(b)); assert.ok(!read(b).includes("drover-asks-hook"));
  assert.ok(read(a).includes("drover-asks-hook"));
});

test("the runtime leaf: equal = no-op (bytes and mtime), owner-different KEPT (exit 1, config still installed), declined creates nothing", async () => {
  const w = world();
  mkdirSync(w.data, { recursive: true }); write(w.leaf, "/opt/owner/node\n", 0o600);
  const r = await run(w, ["install", "--claude", "--yes"]);
  assert.equal(r.code, 1); assert.match(r.out, /runtime file KEPT/); assert.equal(read(w.leaf), "/opt/owner/node\n"); assert.ok(read(w.claude).includes("drover-asks-hook"));
  const w2 = world();
  mkdirSync(w2.data, { recursive: true }); write(w2.leaf, process.execPath + "\n", 0o600);
  const old = new Date(2020, 1, 1); utimesSync(w2.leaf, old, old);
  assert.equal((await run(w2, ["install", "--claude", "--yes"])).code, 0);
  assert.equal(statSync(w2.leaf).mtimeMs, old.getTime());
  const w3 = world(); await run(w3, ["install", "--claude"], { tty: true, answers: ["n"] }); assert.ok(!existsSync(w3.leaf));
});
test("the leaf survives every uninstall order and an owner-different leaf stays", async () => {
  const w = world();
  await run(w, ["install", "--yes"]);
  const m0 = statSync(w.leaf).mtimeMs;
  await run(w, ["uninstall", "--claude", "--yes"]); assert.equal(read(w.leaf), process.execPath + "\n");
  await run(w, ["uninstall", "--codex", "--yes"]); assert.equal(read(w.leaf), process.execPath + "\n"); assert.equal(statSync(w.leaf).mtimeMs, m0);
  const w2 = world();
  mkdirSync(w2.data, { recursive: true }); write(w2.leaf, "/opt/owner/node\n", 0o600);
  await run(w2, ["install", "--codex", "--yes"]); await run(w2, ["uninstall", "--codex", "--yes"]);
  assert.equal(read(w2.leaf), "/opt/owner/node\n");
});
test("the registered launcher command runs with no node on PATH through the leaf (fake node marker); without the leaf nothing runs and it exits 0", async () => {
  const w = world();
  const real = join(BIN, "drover-asks-hook");
  writeFileSync(w.lpath, readFileSync(real, "utf8"), { mode: 0o755 }); // the real launcher (it finds its sibling asks-hook.mjs relative to itself)
  const fakeNode = join(w.root, "fakenode"); const marker = join(w.root, "marker");
  writeFileSync(fakeNode, `#!/bin/sh\necho "$@" > '${marker}'\n`, { mode: 0o755 });
  writeFileSync(join(w.app, "mods", "drover-tasks", "bin", "asks-hook.mjs"), "");
  const env = { ...w.env, DROVER_NODE: fakeNode };
  const bin = join(w.root, "bin"); mkdirSync(bin); symlinkSync(spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim(), join(bin, "sleep")); // the launcher's 3 s watchdog needs sleep; node is NOT on this PATH
  await run(w, ["install", "--codex", "--yes"], { env });
  const cmd = JSON.parse(read(w.codex)).hooks.Stop[0].hooks[0].command;
  const sh = spawnSync("/bin/sh", ["-c", cmd], { env: { HOME: w.home, HERDR_APP_HOME: w.app, PATH: bin }, input: "{}", encoding: "utf8" });
  assert.equal(sh.status, 0); assert.ok(existsSync(marker), "marker written by the fake node"); assert.match(read(marker), /asks-hook\.mjs clear/);
  rmSync(marker); rmSync(w.leaf);
  const none = spawnSync("/bin/sh", ["-c", cmd], { env: { HOME: w.home, HERDR_APP_HOME: w.app, PATH: bin }, input: "{}", encoding: "utf8" });
  assert.equal(none.status, 0); assert.ok(!existsSync(marker));
});

test("status: not installed / installed / partial / changed-by-owner, read-only, with the runtime line", async () => {
  const w = world();
  const snap = snapshot(w.root);
  let r = await run(w, ["status"]);
  assert.match(r.out, /\[claude\] not installed/); assert.match(r.out, /runtime file: absent/); assert.deepEqual(snapshot(w.root), snap);
  await run(w, ["install", "--yes"]);
  r = await run(w, ["status"]);
  assert.match(r.out, /\[claude\] installed \(7 events\)/); assert.match(r.out, /\[codex\] installed \(4 events\)/); assert.match(r.out, /runtime file: present/);
  const o = JSON.parse(read(w.codex)); delete o.hooks.Stop; write(w.codex, render(o, "  ", true));
  assert.match((await run(w, ["status", "--codex"])).out, /partial \(3 of 4/);
  o.hooks.PostToolUse[0].hooks[0].timeout = 8; write(w.codex, render(o, "  ", true));
  assert.match((await run(w, ["status", "--codex"])).out, /changed-by-owner/);
});
test("the stale lock is named, not removed; the real process: usage, exit codes", async () => {
  const w = world();
  mkdirSync(join(w.data, "drover-asks-install.lock"), { recursive: true });
  const r = await run(w, ["install", "--yes"]);
  assert.equal(r.code, 1); assert.match(r.out, /REFUSED: .*drover-asks-install\.lock/); assert.ok(existsSync(join(w.data, "drover-asks-install.lock")));
  assert.ok(!existsSync(w.claude));
  const p = spawnSync(process.execPath, [MOD, "bogus"], { env: w.env, encoding: "utf8" });
  assert.equal(p.status, 2); assert.match(p.stderr, /usage: drover asks-hook/);
  const w2 = world();
  const q = spawnSync(process.execPath, [MOD, "install", "--claude"], { env: w2.env, encoding: "utf8", input: "" });
  assert.equal(q.status, 2); assert.ok(!existsSync(w2.claude));
});
test("isolation: the seam refuses a path outside the scratch root and the real defaults; every opened path is inside the scratch root", async () => {
  const w = world();
  const outside = tmp("asks-outside-"); write(join(outside, "settings.json"), "{}\n");
  const link = join(w.home, ".claude", "settings.json"); symlinkSync(join(outside, "settings.json"), link);
  const r = await run(w, ["install", "--claude", "--yes"]);
  assert.equal(r.code, 1); assert.equal(read(join(outside, "settings.json")), "{}\n");
  const pretendReal = join(w.root, "pretend-real-home");
  const seam = lib.makeSeam({ root: w.root, realDefaults: lib.realDefaultPaths(pretendReal) });
  assert.throws(() => seam.lstat(join(pretendReal, ".claude", "settings.json")), /real default/);
  const w2 = world();
  const s2 = lib.makeSeam({ root: w2.root });
  await run(w2, ["install", "--yes"], { seam: { seam: s2 } });
  assert.ok(s2.opened.length > 10); assert.ok(s2.opened.every((p) => p.startsWith(w2.root)), s2.opened.filter((p) => !p.startsWith(w2.root)).join());
});

test("a hand-installed PARTIAL set then install then uninstall leaves no Drover handler and deletes no handler we did not remove (review 1, High 2; class: no uninstall path declares success without verifying absence)", async () => {
  const events = ["PermissionRequest", "Notification", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionEnd"];
  for (const k of [1, 3, 6]) for (const unreadable of [false, true]) {
    const w = world();
    const wanted = wantedFor("claude", w.lpath);
    const partial = { model: "x", hooks: Object.fromEntries(events.slice(0, k).map((e) => [e, [wanted[e]]])) };
    write(w.claude, render(partial, "  ", true));
    if (unreadable) { mkdirSync(w.inst, { recursive: true }); write(join(w.inst, "claude-garbage.json"), "{not json"); }
    const ins = await run(w, ["install", "--claude", "--yes"]);
    assert.equal(ins.code, 0, ins.out);
    if (!unreadable) assert.equal(records(w)[0].origin.repaired, true, `k=${k}: a pre-existing partial set must make the install count as repaired`);
    const un = await run(w, ["uninstall", "--claude", "--yes"]);
    assert.equal(un.code, 0, un.out);
    assert.ok(!read(w.claude).includes("drover-asks-hook"), `k=${k} unreadable=${unreadable}: Drover handlers survive an uninstall that reported success`);
    assert.equal(JSON.parse(read(w.claude)).model, "x");
  }
});
test("a symlink retargeted while the prompt is open (equal bytes at both ends): install and uninstall abort, neither file is touched (review 1, High 3; class: every consent-to-write gap re-checks identity)", async () => {
  for (const op of ["install", "uninstall"]) {
    const w = world();
    const A = join(w.root, "A.json"), B = join(w.root, "B.json");
    write(A, '{\n  "model": "x"\n}\n');
    symlinkSync(A, w.claude);
    if (op === "uninstall") { await run(w, ["install", "--claude", "--yes"]); write(B, read(A)); }
    else write(B, read(A));
    let out = "";
    const io = { out: (s) => { out += s; }, err: () => {}, isTTY: true, ask: async () => { rmSync(w.claude); symlinkSync(B, w.claude); return "y"; } };
    const a0 = read(A), b0 = read(B);
    const code = await lib.main([op, "--claude"], w.env, io, {});
    assert.equal(code, 1, `${op}: ${out}`); assert.match(out, /changed while we were asking/);
    assert.equal(read(A), a0); assert.equal(read(B), b0);
  }
});
test("a first install keeps its backup path from the pending record: a kill after the publish, before done, still ends with a readable original backup", async () => {
  const w = world(); write(w.claude, '{\n  "model": "x"\n}\n');
  await run(w, ["install", "--claude", "--yes"], { seam: { after: (l) => { if (l === "publish") throw new Error("die after publish"); } } });
  const again = await run(w, ["status", "--claude"]);
  const rec = records(w)[0];
  assert.equal(rec.state, "done"); assert.ok(rec.origin.backup && read(rec.origin.backup) === '{\n  "model": "x"\n}\n', "the original backup pointer survives recovery");
  const un = await run(w, ["uninstall", "--claude", "--yes"]);
  assert.match(un.out, /restored byte-exact/);
});
test("status lists a leftover aside and the recorded retained location", async () => {
  const w = world(); write(w.claude, '{\n  "model": "x"\n}\n');
  await run(w, ["install", "--claude", "--yes"], { seam: { before: (l) => { if (l === "move-aside") throw new Error("EXDEV"); } } });
  const st = await run(w, ["status", "--claude"]);
  assert.match(st.out, /leftover from an interrupted run: .*\.drover-aside\./); assert.match(st.out, /previous file kept beside the target: /);
});
