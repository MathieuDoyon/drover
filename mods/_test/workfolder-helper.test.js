// drover-workfolder: ensure makes private folders, move never overwrites. Temp dirs only (never ~/.config/drover-herdr).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = new URL("../drover-agents/bin/drover-workfolder", import.meta.url).pathname;
const root = () => realpathSync(mkdtempSync(join(tmpdir(), "workfolder-")));
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const run = (...args) => { const p = spawnSync(BIN, args, { encoding: "utf8", env: { PATH: process.env.PATH } }); return { code: p.status, out: p.stdout, err: p.stderr }; };
const put = (p, text = "x") => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };

test("ensure: creates every missing dir 0700, prints the folder, leaves existing parents alone", () => {
  const r = root();
  chmodSync(r, 0o755);
  const leaf = join(r, "a", "P-1", "R-9");
  const x = run("ensure", leaf);
  assert.equal(x.code, 0, x.err);
  assert.equal(x.out.trim(), leaf);
  for (const d of [join(r, "a"), join(r, "a", "P-1"), leaf]) assert.equal(mode(d), "700", d);
  assert.equal(mode(r), "755"); // the existing parent keeps its mode
});

test("ensure: an existing leaf is chmod 0700, existing content kept; a second run is fine", () => {
  const r = root();
  const leaf = join(r, "wf");
  mkdirSync(leaf, { mode: 0o755 });
  put(join(leaf, "plan.md"), "keep");
  assert.equal(run("ensure", leaf).code, 0);
  assert.equal(mode(leaf), "700");
  assert.equal(readFileSync(join(leaf, "plan.md"), "utf8"), "keep");
  assert.equal(run("ensure", leaf).code, 0);
});

test("ensure: refuses relative paths, . and .. parts, a file leaf and a symlink leaf", () => {
  const r = root();
  put(join(r, "file"));
  mkdirSync(join(r, "real"));
  symlinkSync(join(r, "real"), join(r, "link"));
  for (const bad of ["rel/dir", "", `${r}/a/../b`, `${r}/./b`, join(r, "file"), join(r, "link")]) {
    const x = run("ensure", bad);
    assert.equal(x.code, 1, bad);
    assert.match(x.err, /^drover-workfolder: /);
  }
  assert.ok(!existsSync(join(r, "b")));
});

test("ensure: usage errors exit 1", () => {
  assert.equal(run().code, 1);
  assert.equal(run("ensure").code, 1);
  assert.equal(run("nope", "/x").code, 1);
});

test("move: moves files recursively into a private folder, never deletes from, removes emptied sub-folders", () => {
  const r = root();
  const from = join(r, "repo", ".drover"), to = join(r, "cfg", "P-1");
  put(join(from, "lane.md"), "lane");
  put(join(from, "epic", "plan.md"), "plan");
  put(join(from, "epic", "deep", "s.md"), "scout");
  const x = run("move", from, to);
  assert.equal(x.code, 0, x.err);
  assert.equal(x.out.trim(), "moved 3, skipped 0");
  assert.equal(readFileSync(join(to, "epic", "deep", "s.md"), "utf8"), "scout");
  assert.equal(readFileSync(join(to, "lane.md"), "utf8"), "lane");
  assert.equal(mode(to), "700");
  assert.equal(mode(join(to, "epic")), "700");
  assert.ok(existsSync(from), "from folder itself stays");
  assert.deepEqual(readdirSync(from), []);
});

test("move: never overwrites; a name already in <to> is skipped, reported and left in <from>", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  put(join(from, "plan.md"), "OLD");
  put(join(from, "e", "a.md"), "OLD-A");
  put(join(from, "e", "b.md"), "OLD-B");
  put(join(to, "plan.md"), "NEW");
  put(join(to, "e", "a.md"), "NEW-A");
  const x = run("move", from, to);
  assert.equal(x.code, 0, x.err);
  assert.equal(x.out.split("\n")[0], "moved 1, skipped 2");
  assert.match(x.out, /conflict: plan\.md/);
  assert.match(x.out, /conflict: e\/a\.md/);
  assert.equal(readFileSync(join(to, "plan.md"), "utf8"), "NEW");
  assert.equal(readFileSync(join(to, "e", "a.md"), "utf8"), "NEW-A");
  assert.equal(readFileSync(join(to, "e", "b.md"), "utf8"), "OLD-B");
  assert.equal(readFileSync(join(from, "plan.md"), "utf8"), "OLD");
  assert.equal(readFileSync(join(from, "e", "a.md"), "utf8"), "OLD-A");
  assert.ok(!existsSync(join(from, "e", "b.md")));
});

test("move: a symlink moves as a link and is never followed", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new"), outside = join(r, "outside");
  put(join(outside, "secret.md"), "S");
  mkdirSync(from);
  symlinkSync(outside, join(from, "ln"));
  const x = run("move", from, to);
  assert.equal(x.code, 0, x.err);
  assert.equal(x.out.trim(), "moved 1, skipped 0");
  assert.ok(lstatSync(join(to, "ln")).isSymbolicLink());
  assert.equal(readlinkSync(join(to, "ln")), outside);
  assert.equal(readFileSync(join(outside, "secret.md"), "utf8"), "S");
});

test("move: refuses a missing/non-dir from, the same folder, <to> inside <from>, relative and .. paths", () => {
  const r = root();
  const from = join(r, "old");
  put(join(from, "a.md"));
  mkdirSync(join(r, "t"));
  symlinkSync(from, join(r, "lnk"));
  for (const args of [[join(r, "missing"), join(r, "t")], [join(r, "lnk"), join(r, "t")], [from, from], [from, join(from, "in")], ["rel", join(r, "t")], [from, "rel"], [from, `${r}/x/../y`]]) {
    assert.equal(run("move", ...args).code, 1, args.join(" -> "));
  }
  assert.ok(existsSync(join(from, "a.md")));
});

test("move: empty from gives moved 0, skipped 0 and still makes <to> 0700", () => {
  const r = root();
  mkdirSync(join(r, "old"));
  const x = run("move", join(r, "old"), join(r, "new"));
  assert.equal(x.out.trim(), "moved 0, skipped 0");
  assert.equal(mode(join(r, "new")), "700");
});

// ---- review round 1 ----
// (3) --root: no symlink in any component below the root; links above it (system aliases like /tmp) stay fine.
test("ensure --root: a symlink at the project segment is refused in run mode (no escape from the root), nothing is created outside", () => {
  const r = root();
  const cfg = join(r, "cfg"), outside = join(r, "outside");
  mkdirSync(cfg); mkdirSync(outside);
  symlinkSync(outside, join(cfg, "P-1"));
  const x = run("ensure", join(cfg, "P-1", "R-1"), "--root", cfg);
  assert.equal(x.code, 1);
  assert.match(x.err, /symlink/);
  assert.deepEqual(readdirSync(outside), []);
});

test("ensure --root: a symlink at the leaf is still refused; plain folders below the root are made 0700", () => {
  const r = root();
  const cfg = join(r, "cfg"), outside = join(r, "outside");
  mkdirSync(cfg); mkdirSync(outside);
  symlinkSync(outside, join(cfg, "P-2"));
  assert.equal(run("ensure", join(cfg, "P-2"), "--root", cfg).code, 1);
  const x = run("ensure", join(cfg, "P-1", "R-1"), "--root", cfg);
  assert.equal(x.code, 0, x.err);
  assert.equal(mode(join(cfg, "P-1")), "700");
  assert.equal(mode(join(cfg, "P-1", "R-1")), "700");
});

test("ensure --root: a link ABOVE the root (a system alias) is fine; a missing root is created 0700", () => {
  const r = root();
  mkdirSync(join(r, "real"));
  symlinkSync(join(r, "real"), join(r, "alias"));
  const cfg = join(r, "alias", "cfg");
  const x = run("ensure", join(cfg, "P-1", "R-1"), "--root", cfg);
  assert.equal(x.code, 0, x.err);
  assert.equal(mode(join(r, "real", "cfg")), "700");
  assert.ok(existsSync(join(r, "real", "cfg", "P-1", "R-1")));
});

test("ensure --root: a dir outside the root is refused; move --root checks the target path too", () => {
  const r = root();
  const cfg = join(r, "cfg"), outside = join(r, "outside"), from = join(r, "old");
  mkdirSync(cfg); mkdirSync(outside); put(join(from, "a.md"));
  assert.equal(run("ensure", join(r, "elsewhere"), "--root", cfg).code, 1);
  symlinkSync(outside, join(cfg, "P-1"));
  assert.equal(run("move", from, join(cfg, "P-1"), "--root", cfg).code, 1);
  assert.ok(existsSync(join(from, "a.md")));
  assert.deepEqual(readdirSync(outside), []);
});

// (1) Interleaving: a writer creates the destination between the helper's check and its publish. The helper is loaded
// with runpy so os.link (and the copy fallback) can be interposed deterministically. The new file must survive.
const PY = (fallback) => `
import errno, os, runpy, sys
ns = runpy.run_path(${JSON.stringify(BIN)}, run_name="helper")
real_link = os.link
def racing_link(src, dst, **kw):
    if not dst.startswith(sys.argv[3] + "/"):
        return real_link(src, dst, **kw)  # only the publish into the target races, not a restore
    with open(dst, "w") as f:
        f.write("CONCURRENT NEW")
    ${fallback ? 'raise OSError(errno.EXDEV, "cross-device")' : "return real_link(src, dst, **kw)"}
os.link = racing_link
sys.argv = ["drover-workfolder", "move", sys.argv[1], sys.argv[2]]
ns["main"](sys.argv)
`;
for (const [name, fallback] of [["hard link publish", false], ["copy fallback (cross-device)", true]]) {
  test(`move: a destination created after the check is never replaced (${name})`, () => {
    const r = root();
    const from = join(r, "old"), to = join(r, "new");
    put(join(from, "plan.md"), "SOURCE");
    mkdirSync(to);
    const p = spawnSync("python3", ["-I", "-c", PY(fallback), from, to], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(p.status, 0, p.stderr);
    assert.equal(readFileSync(join(to, "plan.md"), "utf8"), "CONCURRENT NEW");
    assert.equal(readFileSync(join(from, "plan.md"), "utf8"), "SOURCE", "source stays when it was not published");
    assert.match(p.stdout, /moved 0, skipped 1/);
    assert.match(p.stdout, /conflict: plan\.md/);
  });
}

test("move: the copy fallback publishes with O_EXCL, keeps content and removes the source only after success", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  put(join(from, "a", "b.md"), "BODY");
  const py = `
import errno, os, runpy, sys
ns = runpy.run_path(${JSON.stringify(BIN)}, run_name="helper")
def nolink(*a, **k): raise OSError(errno.EXDEV, "cross-device")
os.link = nolink
ns["main"](["drover-workfolder", "move", sys.argv[1], sys.argv[2]])
`;
  const p = spawnSync("python3", ["-I", "-c", py, from, to], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.trim(), "moved 1, skipped 0");
  assert.equal(readFileSync(join(to, "a", "b.md"), "utf8"), "BODY");
  assert.ok(!existsSync(join(from, "a", "b.md")));
});

// ---- review round 2: the source is claimed (renamed) first, so a newer source saved meanwhile is never deleted ----
const RACE = (patch) => `
import errno, os, runpy, sys
ns = runpy.run_path(${JSON.stringify(BIN)}, run_name="helper")
${patch}
ns["main"](["drover-workfolder", "move", sys.argv[1], sys.argv[2]])
`;
// After the helper renames src to its claim, an editor saves a NEWER src (atomic save).
const NEWER = `
real_rename = os.rename
def rename(src, dst, **kw):
    real_rename(src, dst, **kw)
    if os.path.basename(dst).startswith(".drover-claim-"):
        with open(src, "w") as f:
            f.write("NEWER SOURCE")
os.rename = rename
`;
const py = (patch, from, to) => spawnSync("python3", ["-I", "-c", RACE(patch), from, to], { encoding: "utf8", env: { PATH: process.env.PATH } });

test("move: a newer source saved after the claim is kept; the moved copy is the content that was claimed", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  put(join(from, "plan.md"), "OLD SOURCE");
  const p = py(NEWER, from, to);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.split("\n")[0], "moved 1, skipped 0");
  assert.equal(readFileSync(join(to, "plan.md"), "utf8"), "OLD SOURCE");
  assert.equal(readFileSync(join(from, "plan.md"), "utf8"), "NEWER SOURCE", "the newer file is not deleted");
  assert.deepEqual(readdirSync(from), ["plan.md"], "no claim left behind");
});

test("move: on a conflict with a newer source, the claim is kept and its path reported, never lost", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  put(join(from, "plan.md"), "OLD SOURCE");
  put(join(to, "plan.md"), "DEST");
  const p = py(NEWER, from, to);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.split("\n")[0], "moved 0, skipped 1");
  assert.match(p.stdout, /conflict: plan\.md/);
  const left = /leftover: (\S+\.drover-claim-\S+)/.exec(p.stdout)?.[1];
  assert.ok(left && left.startsWith(from + "/"), p.stdout);
  assert.equal(readFileSync(left, "utf8"), "OLD SOURCE");
  assert.equal(readFileSync(join(from, "plan.md"), "utf8"), "NEWER SOURCE");
  assert.equal(readFileSync(join(to, "plan.md"), "utf8"), "DEST");
});

test("move: a plain conflict puts the claimed file back under its own name, no claim left", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  put(join(from, "plan.md"), "OLD SOURCE");
  put(join(to, "plan.md"), "DEST");
  const x = run("move", from, to);
  assert.equal(x.out.split("\n")[0], "moved 0, skipped 1");
  assert.doesNotMatch(x.out, /leftover/);
  assert.equal(readFileSync(join(from, "plan.md"), "utf8"), "OLD SOURCE");
  assert.deepEqual(readdirSync(from), ["plan.md"]);
});

test("move: a claim left by an earlier crash is reported as leftover and never moved", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  put(join(from, ".drover-claim-1-0"), "ORPHAN");
  put(join(from, "a.md"), "A");
  const x = run("move", from, to);
  assert.equal(x.out.split("\n")[0], "moved 1, skipped 0");
  assert.match(x.out, new RegExp(`leftover: ${from}/\\.drover-claim-1-0`));
  assert.equal(readFileSync(join(from, ".drover-claim-1-0"), "utf8"), "ORPHAN");
  assert.ok(!existsSync(join(to, ".drover-claim-1-0")));
});

// ---- review round 3: a claim name never collides with an existing path ----
test("move: a pre-existing .drover-claim-<pid>-1 (old naming) survives with its bytes and is reported", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  put(join(from, ".drover-claim-4242-1"), "RECOVER");
  put(join(from, "a.md"), "A");
  const p = py("os.getpid = lambda: 4242", from, to);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.split("\n")[0], "moved 1, skipped 0");
  assert.equal(readFileSync(join(from, ".drover-claim-4242-1"), "utf8"), "RECOVER");
  assert.match(p.stdout, /leftover: \S+\.drover-claim-4242-1/);
  assert.equal(readFileSync(join(to, "a.md"), "utf8"), "A");
});

test("move: claim names are uuid based; a name that already exists is never renamed onto (retry, then skip and report)", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  const fixed = "0".repeat(32);
  put(join(from, `.drover-claim-${fixed}`), "RECOVER");
  put(join(from, "a.md"), "SRC");
  const p = py(`import uuid\nclass U:\n    hex = "${fixed}"\nuuid.uuid4 = lambda: U()`, from, to);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.split("\n")[0], "moved 0, skipped 1");
  assert.match(p.stdout, /conflict: a\.md/);
  assert.equal(readFileSync(join(from, `.drover-claim-${fixed}`), "utf8"), "RECOVER");
  assert.equal(readFileSync(join(from, "a.md"), "utf8"), "SRC", "the file was skipped, not lost");
  assert.ok(!existsSync(join(to, "a.md")));
});

test("move: normal claims are named .drover-claim-<32 hex> (seen through the rename)", () => {
  const r = root();
  const from = join(r, "old"), to = join(r, "new");
  put(join(from, "a.md"), "A");
  const p = py(`real = os.rename\ndef rn(s, d, **k):\n    print("CLAIM " + os.path.basename(d))\n    return real(s, d, **k)\nos.rename = rn`, from, to);
  assert.match(p.stdout, /^CLAIM \.drover-claim-[0-9a-f]{32}$/m);
});
