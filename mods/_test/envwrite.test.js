// drover-env-write: the helper that makes the agent env file with the right mode and renames it into place.
// The mod runtime has no chmod, rename or file mode, so the helper owns that. Fake canary values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, chmodSync, existsSync, statSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRITER = new URL("../drover-agents/bin/drover-env-write", import.meta.url).pathname;
const WRAPPER = new URL("../drover-agents/bin/drover-env", import.meta.url).pathname;
const CANARY = "CANARY-fake-7f3a91-not-a-secret";
const text = (env) => JSON.stringify({ version: 1, env });
const entry = (v = CANARY) => ({ value: v, secret: true });
const mode = (p) => (statSync(p).mode & 0o777).toString(8);

const root = () => mkdtempSync(join(tmpdir(), "envwrite-"));
// The staging folder (the mod can only write under its appHome): a sibling of the config dir here.
const stage = (r) => `${r}-stage`;
function run(r, args, extra = {}) {
  if (!args.includes("--stage-dir")) args = [...args, "--stage-dir", stage(r)];
  const p = spawnSync(WRITER, args, { env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: r, ...extra }, encoding: "utf8" });
  return { code: p.status, out: p.stdout, err: p.stderr };
}
const clean = (r, why) => { for (const s of [r.out, r.err]) assert.ok(!s.includes(CANARY), why + ": canary leaked"); };
const TMP = /^bot\.[0-9a-f]{16}\.tmp$/;
const tmps = (r) => (existsSync(stage(r)) ? readdirSync(stage(r)).filter((n) => n.endsWith(".tmp")) : []);
const filePath = (r, id = "bot") => join(r, "agents", `${id}.json`);
// prepare (it prints the tmp name), write the tmp the way the mod does (writeFile on the existing file), commit
function prep(r, id = "bot") {
  const a = run(r, ["prepare", id]);
  assert.equal(a.code, 0, a.err);
  const name = a.out.trim();
  assert.match(name, new RegExp(`^${id}\\.[0-9a-f]{16}\\.tmp$`));
  return { name, path: join(stage(r), name) };
}
function write(r, content, id = "bot") {
  const t = prep(r, id);
  writeFileSync(t.path, content);
  return run(r, ["commit", id, t.name]);
}

test("prepare creates the config dir, agents/ and the stage dir as 0700 and an empty 0600 tmp with a random name in the stage dir", () => {
  const r = join(root(), "cfg");
  const t = prep(r);
  assert.equal(mode(r), "700");
  assert.equal(mode(join(r, "agents")), "700");
  assert.equal(mode(stage(r)), "700");
  assert.equal(mode(t.path), "600");
  assert.equal(statSync(t.path).size, 0);
  assert.deepEqual(readdirSync(join(r, "agents")), [], "nothing is staged inside the config dir");
});

test("the stage dir is checked like agents/: prepare tightens one that is ours and loose; a symlink, a file or a foreign mode is refused", () => {
  const r = root();
  mkdirSync(stage(r), { mode: 0o755 });
  chmodSync(stage(r), 0o755);
  prep(r);
  assert.equal(mode(stage(r)), "700");
  const r2 = root();
  mkdirSync(join(r2, "real"), { mode: 0o700 });
  symlinkSync(join(r2, "real"), stage(r2));
  assert.equal(run(r2, ["prepare", "bot"]).code, 1);
  assert.deepEqual(readdirSync(join(r2, "real")), []);
  const r3 = root();
  writeFileSync(stage(r3), "x");
  assert.equal(run(r3, ["prepare", "bot"]).code, 1);
  const r4 = root();
  const t = prep(r4);
  writeFileSync(t.path, text({ FOO: entry() }));
  chmodSync(stage(r4), 0o755);
  assert.equal(run(r4, ["commit", "bot", t.name]).code, 1, "commit does not accept a loose stage dir");
  assert.equal(run(r4, ["abort", "bot", t.name]).code, 1, "nor does abort");
  chmodSync(stage(r4), 0o700);
});

test("--stage-dir is required for prepare, commit and abort, and must be absolute", () => {
  const r = root();
  for (const args of [["prepare", "bot"], ["commit", "bot", "bot.0123456789abcdef.tmp"], ["abort", "bot", "bot.0123456789abcdef.tmp"]]) {
    const p = spawnSync(WRITER, [...args, "--config-dir", r], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(p.status, 1, args[0]);
    assert.match(p.stderr, /^drover-env-write: /);
  }
  assert.equal(run(r, ["prepare", "bot", "--stage-dir", "relative/stage"]).code, 1);
  assert.equal(readdirSync(r).length, 0);
});

test("overlapping saves: each prepare gets its own tmp; one commit never touches or removes the other's", () => {
  const r = root();
  const a = prep(r), b = prep(r);
  assert.notEqual(a.name, b.name);
  assert.equal(mode(a.path), "600");
  assert.equal(mode(b.path), "600");
  writeFileSync(a.path, text({ FOO: entry("first-fake") }));
  writeFileSync(b.path, text({ FOO: entry("second-fake") }));
  assert.equal(run(r, ["commit", "bot", a.name]).code, 0);
  assert.ok(existsSync(b.path), "the other save's tmp is still there");
  assert.equal(mode(b.path), "600");
  assert.equal(run(r, ["commit", "bot", b.name]).code, 0);
  assert.equal(JSON.parse(readFileSync(filePath(r), "utf8")).env.FOO.value, "second-fake");
  assert.deepEqual(tmps(r), []);
});

test("prepare tightens an existing agents/ that is looser than 0700", () => {
  const r = root();
  mkdirSync(join(r, "agents"), { mode: 0o755 });
  chmodSync(join(r, "agents"), 0o755);
  const t = prep(r);
  assert.equal(mode(join(r, "agents")), "700");
  assert.equal(mode(t.path), "600");
});

test("commit: the file lands as 0600 and the tmp is gone; drover-env can read it", () => {
  const r = root();
  const c = write(r, text({ FOO: entry() }));
  assert.equal(c.code, 0, c.err);
  assert.equal(c.out.trim(), "ok");
  assert.equal(mode(filePath(r)), "600");
  assert.deepEqual(tmps(r), []);
  const w = spawnSync(WRAPPER, ["bot", "--", "sh", "-c", 'echo "$FOO"'], { env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: r }, encoding: "utf8" });
  assert.equal(w.stdout, CANARY + "\n");
});

test("commit replaces an existing file (new content, still 0600)", () => {
  const r = root();
  write(r, text({ FOO: entry("old-fake-value") }));
  const c = write(r, text({ FOO: entry(), BAR: entry("two") }));
  assert.equal(c.code, 0, c.err);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(filePath(r), "utf8")).env), ["FOO", "BAR"]);
  assert.equal(mode(filePath(r)), "600");
  assert.deepEqual(readdirSync(join(r, "agents")), ["bot.json"]);
});

test("commit refuses a tmp that is not 0600 and removes it (the old file stays)", () => {
  const r = root();
  write(r, text({ FOO: entry("keep-me") }));
  const t = prep(r);
  writeFileSync(t.path, text({ FOO: entry() }));
  chmodSync(t.path, 0o644);
  const c = run(r, ["commit", "bot", t.name]);
  assert.equal(c.code, 1);
  assert.match(c.err, /^drover-env-write: /);
  clean(c, "mode");
  assert.equal(existsSync(t.path), false);
  assert.ok(readFileSync(filePath(r), "utf8").includes("keep-me"));
});

test("commit refuses a tmp that is a symlink", () => {
  const r = root();
  const t = prep(r);
  rmSync(t.path);
  const target = join(r, "elsewhere");
  writeFileSync(target, text({ FOO: entry() }), { mode: 0o600 });
  symlinkSync(target, t.path);
  const c = run(r, ["commit", "bot", t.name]);
  assert.equal(c.code, 1);
  assert.equal(existsSync(filePath(r)), false);
  clean(c, "symlink");
});

test("commit and abort only take a tmp name that prepare would make for that id", () => {
  const r = root();
  write(r, text({ FOO: entry("keep-me") }));
  writeFileSync(join(stage(r), "other.0123456789abcdef.tmp"), text({ BAR: entry() }), { mode: 0o600 });
  for (const name of ["bot.json", "bot.json.tmp", "other.0123456789abcdef.tmp", "../x.tmp", "bot.XYZ.tmp", "bot.0123456789abcdef.tmp.x", "bot.0123456789abcdef", "", "a/b.tmp", "bot.0123456789ABCDEF.tmp"]) {
    for (const cmd of ["commit", "abort"]) {
      const out = run(r, [cmd, "bot", name]);
      assert.equal(out.code, 1, `${cmd} ${JSON.stringify(name)}`);
      assert.match(out.err, /^drover-env-write: /);
    }
  }
  assert.ok(readFileSync(filePath(r), "utf8").includes("keep-me"), "the real file was not touched or deleted");
  assert.ok(existsSync(join(stage(r), "other.0123456789abcdef.tmp")));
});

const PYCHECK = `
import errno, importlib.machinery, importlib.util, os, sys
loader = importlib.machinery.SourceFileLoader("w", sys.argv[1])
spec = importlib.util.spec_from_loader("w", loader)
w = importlib.util.module_from_spec(spec); loader.exec_module(w)
base, name, mode = sys.argv[2], sys.argv[3], sys.argv[4]
real = os.replace
calls = []
def replace(*a, **k):
    calls.append(k.get("src_dir_fd") != k.get("dst_dir_fd"))
    if mode in ("exdev", "exdev-eio") and calls[0] and len(calls) == 1:
        raise OSError(errno.EXDEV, "cross-device")
    real(*a, **k)
    if mode == "loose": os.chmod(a[1], 0o644, dir_fd=k["dst_dir_fd"])
    if mode == "link":
        os.unlink(a[1], dir_fd=k["dst_dir_fd"]); os.symlink("elsewhere", a[1], dir_fd=k["dst_dir_fd"])
os.replace = replace
realun = os.unlink
def unlink(p, *a, **k):
    if mode == "exdev-eio" and p == name:
        raise OSError(errno.EIO, "injected")
    return realun(p, *a, **k)
os.unlink = unlink
sys.argv = ["w", "commit", "bot", name, "--config-dir", base, "--stage-dir", base + "-stage"]
w.main(sys.argv)
`;
test("commit checks the published file again and deletes it when it is not a regular 0600 file", () => {
  for (const how of ["loose", "link"]) {
    const r = root();
    const t = prep(r);
    writeFileSync(t.path, text({ FOO: entry() }));
    const p = spawnSync("python3", ["-I", "-c", PYCHECK, WRITER, r, t.name, how], { encoding: "utf8" });
    assert.equal(p.status, 1, how + ": " + p.stderr);
    assert.match(p.stderr, /^drover-env-write: /);
    clean({ out: p.stdout, err: p.stderr }, how);
    assert.equal(existsSync(filePath(r)) || Boolean(statSyncOrNull(filePath(r))), false, how + ": the bad published file is removed");
  }
});
test("commit across devices: the checked bytes are copied into a 0600 tmp inside agents/, renamed, and the stage tmp is gone", () => {
  const r = root();
  const t = prep(r);
  writeFileSync(t.path, text({ FOO: entry() }));
  const p = spawnSync("python3", ["-I", "-c", PYCHECK, WRITER, r, t.name, "exdev"], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(mode(filePath(r)), "600");
  assert.equal(JSON.parse(readFileSync(filePath(r), "utf8")).env.FOO.value, CANARY);
  assert.deepEqual(readdirSync(join(r, "agents")), ["bot.json"], "no copy tmp left");
  assert.deepEqual(tmps(r), []);
});

test("EXDEV and the stage tmp cannot be removed: commit exits non-zero (published file kept), and abort then cleans up", () => {
  const r = root();
  const t = prep(r);
  writeFileSync(t.path, text({ FOO: entry() }));
  const p = spawnSync("python3", ["-I", "-c", PYCHECK, WRITER, r, t.name, "exdev-eio"], { encoding: "utf8" });
  assert.equal(p.status, 1, "the cleanup failure is reported, not swallowed");
  assert.match(p.stderr, /^drover-env-write: /);
  clean({ out: p.stdout, err: p.stderr }, "exdev-eio");
  assert.equal(mode(filePath(r)), "600", "the verified identity stays");
  assert.deepEqual(tmps(r), [t.name], "the duplicate is still staged, so the caller's abort must run");
  assert.equal(run(r, ["abort", "bot", t.name]).code, 0);
  assert.deepEqual(tmps(r), []);
});

test("a refused commit removes the stage tmp", () => {
  const r = root();
  const t = prep(r);
  writeFileSync(t.path, "not json");
  assert.equal(run(r, ["commit", "bot", t.name]).code, 1);
  assert.deepEqual(tmps(r), []);
});

const statSyncOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };

test("prepare refuses a symlinked agents/ and a symlinked config dir", () => {
  const real = root();
  mkdirSync(join(real, "agents"), { mode: 0o700 });
  const r1 = root();
  symlinkSync(join(real, "agents"), join(r1, "agents"));
  assert.equal(run(r1, ["prepare", "bot"]).code, 1);
  assert.deepEqual(readdirSync(join(real, "agents")), []);
  const r2 = join(root(), "link");
  symlinkSync(real, r2);
  assert.equal(run(r2, ["prepare", "bot"]).code, 1);
});

test("commit refuses bad content with a reason and no value, removes the tmp, writes no file", () => {
  const bad = [
    `{"version":1,"env":{"FOO":{"value":"${CANARY}"`, // truncated
    `not json ${CANARY}`,
    JSON.stringify({ version: 2, env: { FOO: entry() } }),
    JSON.stringify({ version: 1, env: { path: entry() } }),
    JSON.stringify({ version: 1, env: { PATH: entry() } }),
    JSON.stringify({ version: 1, env: { FOO: CANARY } }),
    JSON.stringify({ version: 1, env: { FOO: entry(CANARY + "\u0000") } }),
    `{"version":1,"env":{"FOO":{"value":"${CANARY}"},"FOO":{"value":"b"}}}`,
    text({ FOO: entry("x".repeat(8200) + CANARY) }),
    text({ GH_TOKEN: entry() }), // a token without its config dir
  ];
  for (const c of bad) {
    const r = root();
    const out = write(r, c);
    assert.equal(out.code, 1, c.slice(0, 40));
    assert.match(out.err, /^drover-env-write: /);
    clean(out, c.slice(0, 40));
    assert.deepEqual(tmps(r), [], "tmp removed: " + c.slice(0, 30));
    assert.equal(existsSync(filePath(r)), false);
  }
});

test("commit: exactly 8 KiB is accepted; GH_TOKEN with GH_CONFIG_DIR is accepted", () => {
  const pad = text({ FOO: entry("") }).length;
  assert.equal(write(root(), text({ FOO: entry("y".repeat(8192 - pad)) })).code, 0);
  assert.equal(write(root(), text({ GH_TOKEN: entry(), GH_CONFIG_DIR: entry("/some/dir") })).code, 0);
});

test("delete removes the file and every pending tmp of that id, staged or left in agents/ (not another id's); a confirmed absence is fine", () => {
  const r = root();
  write(r, text({ FOO: entry() }));
  prep(r); prep(r);
  writeFileSync(join(stage(r), "other.0123456789abcdef.tmp"), "x", { mode: 0o600 });
  writeFileSync(join(r, "agents", "bot.fedcba9876543210.tmp"), "left over", { mode: 0o600 });
  writeFileSync(join(r, "agents", "other.fedcba9876543210.tmp"), "x", { mode: 0o600 });
  const d = run(r, ["delete", "bot"]);
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(readdirSync(join(r, "agents")), ["other.fedcba9876543210.tmp"]);
  assert.deepEqual(readdirSync(stage(r)), ["other.0123456789abcdef.tmp"]);
  assert.equal(run(r, ["delete", "bot"]).code, 0);
  assert.equal(run(root(), ["delete", "bot"]).code, 0, "no agents dir at all");
  assert.equal(run(join(root(), "no-such-config"), ["delete", "bot"]).code, 0, "no config dir at all");
  assert.equal(run(root(), ["abort", "bot", "bot.0123456789abcdef.tmp"]).code, 0, "abort with no stage dir at all");
});

test("delete never follows a symlink: it removes the link, not the target", () => {
  const r = root();
  prep(r);
  const target = join(r, "elsewhere");
  writeFileSync(target, "keep", { mode: 0o600 });
  symlinkSync(target, filePath(r));
  assert.equal(run(r, ["delete", "bot"]).code, 0);
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.equal(existsSync(filePath(r)), false);
});

test("delete fails (exit 1, a reason, the file kept) when agents/ or the stage dir cannot be confirmed: symlink, no access, not a dir", () => {
  const mk = () => { const r = root(); write(r, text({ FOO: entry("keep-me") })); return r; };
  const r1 = mk(); // agents is a symlink to the real folder
  renameSync(join(r1, "agents"), join(r1, "agents-kept"));
  symlinkSync(join(r1, "agents-kept"), join(r1, "agents"));
  const r2 = mk(); // no access
  chmodSync(join(r2, "agents"), 0o000);
  const r3 = mk(); // agents is a file
  rmSync(join(r3, "agents"), { recursive: true });
  writeFileSync(join(r3, "agents"), "x");
  const r4 = mk(); // config dir is a symlink
  const link = join(root(), "link");
  symlinkSync(r4, link);
  const r5 = mk(); // the stage dir is a symlink
  renameSync(stage(r5), stage(r5) + "-kept");
  symlinkSync(stage(r5) + "-kept", stage(r5));
  const r6 = mk(); // the stage dir exists but is not 0700
  chmodSync(stage(r6), 0o755);
  for (const [r, where] of [[r1, "symlinked agents"], [r2, "unreadable agents"], [r3, "agents is a file"], [link, "symlinked config"], [r5, "symlinked stage"], [r6, "stage mode 0755"]]) {
    const out = run(r, ["delete", "bot"]);
    assert.equal(out.code, 1, `${where}: ${out.err}`);
    assert.match(out.err, /^drover-env-write: /);
    clean(out, where);
  }
  assert.ok(readFileSync(join(r1, "agents-kept", "bot.json"), "utf8").includes("keep-me"), "the symlinked agents dir was not followed");
  chmodSync(join(r2, "agents"), 0o700);
  assert.ok(readFileSync(join(r2, "agents", "bot.json"), "utf8").includes("keep-me"));
  // The identity is the LAST thing delete removes: any failed check or cleanup before it leaves the file, so a launch still wraps.
  for (const [r, where] of [[r4, "symlinked config"], [r5, "symlinked stage"], [r6, "stage mode 0755"]]) {
    assert.ok(readFileSync(join(r, "agents", "bot.json"), "utf8").includes("keep-me"), `${where}: the identity survives a failed delete`);
  }
  chmodSync(stage(r6), 0o700);
});

test("abort fails (exit 1, a reason) when the stage dir cannot be confirmed: symlink, no access, not a dir; a missing one is fine", () => {
  const name = "bot.0123456789abcdef.tmp";
  const mk = () => { const r = root(); prep(r); return r; };
  const r1 = mk();
  renameSync(stage(r1), stage(r1) + "-kept");
  symlinkSync(stage(r1) + "-kept", stage(r1));
  const r2 = mk();
  chmodSync(stage(r2), 0o000);
  const r3 = mk();
  rmSync(stage(r3), { recursive: true });
  writeFileSync(stage(r3), "x");
  for (const [r, where] of [[r1, "symlinked stage"], [r2, "unreadable stage"], [r3, "stage is a file"]]) {
    const out = run(r, ["abort", "bot", name]);
    assert.equal(out.code, 1, `${where}: ${out.err}`);
    assert.match(out.err, /^drover-env-write: /);
  }
  chmodSync(stage(r2), 0o700);
});

test("abort removes that tmp only", () => {
  const r = root();
  write(r, text({ FOO: entry() }));
  const a = prep(r), b = prep(r);
  assert.equal(run(r, ["abort", "bot", a.name]).code, 0);
  assert.deepEqual(readdirSync(join(r, "agents")), ["bot.json"]);
  assert.deepEqual(readdirSync(stage(r)), [b.name]);
  assert.equal(run(r, ["abort", "bot", a.name]).code, 0, "already gone is fine");
});

test("bad usage and bad ids fail with a reason", () => {
  const r = root();
  for (const args of [[], ["prepare"], ["frob", "bot"], ["prepare", "../x"], ["commit", "a/b", "a.0123456789abcdef.tmp"], ["delete", ""], ["prepare", "x".repeat(65)], ["prepare", "bot", "extra"], ["commit", "bot"], ["abort", "bot"], ["delete", "bot", "extra"]]) {
    const out = run(r, args);
    assert.equal(out.code, 1, JSON.stringify(args));
    assert.match(out.err, /^drover-env-write: /);
  }
  assert.equal(readdirSync(r).length, 0, "nothing created for a bad id");
  assert.equal(existsSync(stage(r)), false);
});

test("--config-dir overrides the env var; a relative dir is refused", () => {
  const r = root(), other = root();
  assert.equal(run(other, ["prepare", "bot", "--config-dir", r, "--stage-dir", stage(r)]).code, 0);
  assert.equal(tmps(r).length, 1);
  assert.equal(existsSync(join(r, "agents")), true);
  assert.equal(existsSync(join(other, "agents")), false);
  assert.equal(run(other, ["prepare", "bot", "--config-dir", "relative/dir"]).code, 1);
});

test("a config dir that group or world can write is refused", () => {
  const r = root();
  chmodSync(r, 0o777);
  assert.equal(run(r, ["prepare", "bot"]).code, 1);
  chmodSync(r, 0o700);
});
