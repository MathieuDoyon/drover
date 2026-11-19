// drover-lessons: the lessons writer (check|add|edit|rm|confirm|list|stale). Scratch --config dirs only, never ~/.config/drover-herdr.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as L from "../_lib/lessons.js";
import { exportHerd } from "../_lib/herd-export.js";

const BIN = new URL("../drover-agents/bin/drover-lessons", import.meta.url).pathname;
// Every scratch dir (and the driver files) lives under one suite root that is removed when the suite ends.
const SUITE = realpathSync(mkdtempSync(join(tmpdir(), "lessons-suite-")));
const scratch = () => realpathSync(mkdtempSync(join(SUITE, "s-")));
after(() => {
  const stack = [SUITE];
  while (stack.length) { // a test may leave a 000 dir behind: make everything removable first
    const d = stack.pop();
    try { chmodSync(d, 0o700); for (const n of readdirSync(d)) { const p = join(d, n); if (lstatSync(p).isDirectory()) stack.push(p); } } catch { /* gone */ }
  }
  rmSync(SUITE, { recursive: true, force: true });
  assert.ok(!existsSync(SUITE), "the suite leaves no scratch root behind");
});
const ENV = (cfg) => ({ PATH: process.env.PATH, HOME: `${cfg}-home` });
const run = (cfg, args, input = "", env) => {
  const p = spawnSync(BIN, [...args, "--config", cfg], { input, encoding: "utf8", env: env ?? ENV(cfg), timeout: 15000 });
  return { code: p.status, out: p.stdout, err: p.stderr, all: `${p.stdout}${p.stderr}` };
};
const arun = (cfg, args, input = "") => new Promise((res) => {
  const p = spawn(BIN, [...args, "--config", cfg], { env: ENV(cfg) });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => res({ code, out, err }));
  p.stdin.end(input);
});
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const ORG = ["--org", "acme"];
const file = (cfg, ...p) => join(cfg, "orgs", "acme", ...(p.length ? p : ["lessons.md"]));
const read = (p) => readFileSync(p, "utf8");
const seed = (cfg, text, rel = ["orgs", "acme", "lessons.md"]) => {
  const p = join(cfg, ...rel);
  mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(p, text, { mode: 0o600 });
  return p;
};
const cand = (title, ...body) => `${title}\n${body.join("\n")}\n`;
const parsed = (p) => L.parseEntries(read(p));
const tree = (root) => {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); out.push(relative(root, p)); if (lstatSync(p).isDirectory()) walk(p); } };
  walk(root);
  return out;
};
const listRows = (cfg, scope = ORG) => run(cfg, ["list", ...scope]).out.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
const tokenOf = (cfg, id, scope = ORG) => (listRows(cfg, scope).find((r) => r[0] === id) ?? [])[1];

const SEED2 = "### L-01 First one\nBody one (added 2026-01-02 · T-1)\n\n### L-02 Second one\nBody two\n";

// ---- red until the helper exists; each AC has a named test ----

test("add/list/edit/rm/confirm round trip: ids, tokens, dates, canonical text", () => {
  const cfg = scratch();
  const a = run(cfg, ["add", ...ORG, "--source", "T-MW1"], cand("Always run the tests", "Run them before the commit."));
  assert.equal(a.code, 0, a.all);
  const [id, tok] = a.out.trim().split("\t");
  assert.equal(id, "L-01");
  const want = L.formatEntry({ n: 1, title: "Always run the tests", body: ["Run them before the commit."], added: today(), source: "T-MW1" });
  assert.equal(read(file(cfg)), `${want}\n`);
  assert.equal(tok, sha(want));
  assert.equal(run(cfg, ["add", ...ORG], cand("Second", "b")).out.split("\t")[0], "L-02");
  const rows = listRows(cfg);
  assert.deepEqual(rows[0], ["L-01", sha(want), today(), "-", "Always run the tests"]);
  const c = run(cfg, ["confirm", "L-01", ...ORG, "--expect", rows[0][1]]);
  assert.equal(c.code, 0, c.all);
  assert.equal(parsed(file(cfg)).entries[0].confirmed, today());
  const e = run(cfg, ["edit", "L-01", ...ORG, "--expect", c.out.trim().split("\t")[1]], cand("Always run the checks", "New body."));
  assert.equal(e.code, 0, e.all);
  const e1 = parsed(file(cfg)).entries[0];
  assert.deepEqual([e1.id, e1.title, e1.body, e1.added, e1.source, e1.confirmed], ["L-01", "Always run the checks", ["New body."], today(), "T-MW1", null]);
  const r = run(cfg, ["rm", "L-01", ...ORG, "--expect", e.out.trim().split("\t")[1]]);
  assert.equal(r.code, 0, r.all);
  const left = parsed(file(cfg));
  assert.deepEqual(left.entries.map((x) => x.id), ["L-02"]);
  assert.equal(left.skipped, 0);
  assert.ok(new Set(["add", "edit", "rm", "confirm"]).size === 4);
});

test("project and agent scopes use exactly the lessonPaths layout", () => {
  const cfg = scratch();
  assert.equal(run(cfg, ["add", "--project", "P-MWE1", "--source", "R-1"], cand("Project lesson", "x")).code, 0);
  assert.equal(run(cfg, ["add", "--agent", "wrangler"], cand("Agent lesson", "x")).code, 0);
  assert.equal(run(cfg, ["add", ...ORG, "--kind", "workflows"], cand("Org workflow", "x")).code, 0);
  const p = L.lessonPaths(cfg, { org: "acme", project: "P-MWE1", agent: "wrangler" });
  assert.equal(parsed(p.project).entries.length, 1);
  assert.equal(parsed(p.agent).entries.length, 1);
  assert.equal(parsed(p.org.workflows).entries.length, 1);
  assert.ok(!existsSync(p.org.lessons));
});

// ---- AC: each secret pattern refused with no value echoed ----

const SECRETS = [
  ["ghp", "gh" + "p_abcdefghijklmnop12"], ["github_pat", "github" + "_pat_11ABCDEFG0123"], ["gho", "gho_abcdefgh1234"],
  ["sk", "sk-abcdef123456"], ["sk after space", "use sk-abc123 here"], ["xox after paren", "(xoxb-123456)"],
  ["xox malformed", "xoxz"], ["AKIA", "AKIAIOSFODNN7EXAMPLE"], ["AKIA short", "AKIA1"], ["embedded ghp", "xgh" + "p_abc12345"],
  ["Bearer", "Bearer abcdef123456"], ["JWT", "eyJhbGciOiJIUzI1NiJ9.payload"], ["private key", "-----BEGIN PRIVATE" + " KEY-----"],
  ["user:pass url", "https://user:hunter2@example.com/x"], ["url query", "https://example.com/a?x=1"], ["url fragment", "https://example.com/a#frag"],
  ["hex run", "0123456789abcdef0123456789abcdef"], ["base64 run", "QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVu"],
  ["email", "someone@example.com"], ["code fence", "```js"],
  ["embedded JWT", "aeyJb-c"], ["embedded JWT 2", "keyJob"],
];

test("secrets: every pattern refused by check, add and edit, in the title and the body, no value echoed, disk unchanged", () => {
  for (const [name, value] of SECRETS) {
    for (const where of ["body", "title"]) {
      const cfg = scratch();
      const text = where === "body" ? cand("A clean title", `note ${value} end`) : cand(`T ${value}`, "clean body");
      const c = run(cfg, ["check"], text);
      assert.equal(c.code, 1, `${name}/${where} check`);
      assert.match(c.out, /^refused: /, `${name}/${where}`);
      assert.ok(!c.all.includes(value) && !c.all.includes(value.trim()), `${name}/${where}: value echoed by check`);
      const a = run(cfg, ["add", ...ORG], text);
      assert.equal(a.code, 1, `${name}/${where} add`);
      assert.ok(!a.all.includes(value.trim()), `${name}/${where}: value echoed by add`);
      assert.deepEqual(tree(cfg), [], `${name}/${where}: add wrote something`);
      seed(cfg, SEED2);
      const before = read(file(cfg));
      const e = run(cfg, ["edit", "L-02", ...ORG, "--expect", tokenOf(cfg, "L-02")], text);
      assert.equal(e.code, 1, `${name}/${where} edit`);
      assert.ok(!e.all.includes(value.trim()), `${name}/${where}: value echoed by edit`);
      assert.equal(read(file(cfg)), before, `${name}/${where}: edit changed the file`);
      assert.ok(!existsSync(file(cfg, ".lessons.md.prev")));
    }
  }
});

test("secrets: a secret in --source is refused too; clean look-alikes pass; the scan limits hold", () => {
  const cfg = scratch();
  const s = run(cfg, ["add", ...ORG, "--source", "sk-abc12345"], cand("Fine title", "fine"));
  assert.equal(s.code, 1);
  assert.ok(!s.all.includes("sk-abc12345"));
  for (const t of ["task-bound work", "risk-free change", "A plain title"]) assert.equal(run(cfg, ["check"], cand(t, "fine body")).out.trim(), "ok", t);
  for (const bad of [cand("T", "1", "2", "3", "4"), cand("T", "x".repeat(401))]) {
    const c = run(cfg, ["check"], bad);
    assert.equal(c.code, 1);
    assert.match(c.out, /^refused: /);
  }
  assert.ok(!existsSync(file(cfg)));
});

test("stdin only: argv never carries text, more than 4096 bytes is refused, no echo", () => {
  const cfg = scratch();
  const big = run(cfg, ["add", ...ORG], cand("T", "a ".repeat(2100)));
  assert.equal(big.code, 1);
  assert.match(big.all, /refused/);
  const x = run(cfg, ["add", ...ORG, "--title", "Hello world"], "");
  assert.equal(x.code, 1);
  assert.ok(!x.all.includes("Hello world"));
  assert.ok(!existsSync(file(cfg)));
  assert.equal(run(cfg, ["add", ...ORG], "").code, 1);
  assert.equal(run(cfg, ["add", ...ORG], "only a title\n").code, 1);
  assert.equal(run(cfg, ["add", ...ORG], Buffer.from([0x54, 0x0a, 0xff, 0xfe, 0x0a])).code, 1);
});

test("--text-file: a private regular file works; a symlink, a group/other-readable file and a big file are refused", () => {
  const cfg = scratch();
  const d = scratch();
  const f = join(d, "c.txt");
  writeFileSync(f, cand("From a file", "body"), { mode: 0o600 });
  chmodSync(f, 0o600);
  assert.equal(run(cfg, ["check", "--text-file", f]).out.trim(), "ok");
  assert.equal(run(cfg, ["add", ...ORG, "--text-file", f]).code, 0);
  const link = join(d, "l.txt");
  symlinkSync(f, link);
  assert.equal(run(cfg, ["check", "--text-file", link]).code, 1);
  const open = join(d, "o.txt");
  writeFileSync(open, cand("Open", "body"));
  chmodSync(open, 0o644);
  assert.equal(run(cfg, ["check", "--text-file", open]).code, 1);
  const big = join(d, "b.txt");
  writeFileSync(big, "x".repeat(5000), { mode: 0o600 });
  assert.equal(run(cfg, ["check", "--text-file", big]).code, 1);
  assert.equal(run(cfg, ["check", "--text-file", join(d, "missing")]).code, 1);
});

// ---- AC: racing writers lose nothing ----

test("racing: 10 parallel adds on one file all land with unique ids; add and confirm race without loss", async () => {
  const cfg = scratch();
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => arun(cfg, ["add", ...ORG], cand(`Racing lesson ${i}`, `body ${i}`))));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const p = parsed(file(cfg));
  assert.equal(p.skipped, 0);
  assert.equal(p.entries.length, 10);
  assert.equal(new Set(p.entries.map((e) => e.id)).size, 10);
  assert.deepEqual(new Set(p.entries.map((e) => e.title)), new Set(Array.from({ length: 10 }, (_, i) => `Racing lesson ${i}`)));
  const cfg2 = scratch();
  seed(cfg2, "### L-01 One\nb1 (added 2026-01-01)\n\n### L-02 Two\nb2 (added 2026-01-01)\n\n### L-03 Three\nb3 (added 2026-01-01)\n\n### L-04 Four\nb4 (added 2026-01-01)\n");
  const toks = Object.fromEntries(listRows(cfg2).map((r) => [r[0], r[1]]));
  const jobs = [
    ...["L-01", "L-02", "L-03", "L-04"].map((id) => arun(cfg2, ["confirm", id, ...ORG, "--expect", toks[id]])),
    ...[0, 1, 2, 3, 4, 5].map((i) => arun(cfg2, ["add", ...ORG], cand(`Late ${i}`, "x"))),
  ];
  for (const r of await Promise.all(jobs)) assert.equal(r.code, 0, r.err);
  const q = parsed(file(cfg2));
  assert.equal(q.skipped, 0);
  assert.equal(q.entries.length, 10);
  for (const e of q.entries.slice(0, 4)) assert.equal(e.confirmed, today());
  assert.equal(new Set(q.entries.map((e) => e.id)).size, 10);
});

// ---- AC: stale --expect refused ----

test("stale --expect: a changed entry, a removed entry and a wrong hash are refused with exit 2, the file byte-equal", () => {
  const cfg = scratch();
  seed(cfg, SEED2);
  const p = file(cfg);
  const t1 = tokenOf(cfg, "L-01");
  const before = read(p);
  for (const verb of ["edit", "rm", "confirm"]) {
    const wrong = run(cfg, [verb, "L-01", ...ORG, "--expect", "0".repeat(64)], cand("New title", "b"));
    assert.equal(wrong.code, 2, verb);
    assert.match(wrong.err, /^stale: re-review/, verb);
    assert.equal(read(p), before);
    const junk = run(cfg, [verb, "L-01", ...ORG, "--expect", "nothex"], cand("New title", "b"));
    assert.notEqual(junk.code, 0);
    assert.equal(read(p), before);
    const none = run(cfg, [verb, "L-01", ...ORG], cand("New title", "b"));
    assert.notEqual(none.code, 0, `${verb} without --expect`);
    assert.equal(read(p), before);
  }
  // the entry changes under the reviewer
  assert.equal(run(cfg, ["edit", "L-01", ...ORG, "--expect", t1], cand("Changed by someone", "other")).code, 0);
  const mid = read(p);
  for (const verb of ["edit", "rm", "confirm"]) {
    const r = run(cfg, [verb, "L-01", ...ORG, "--expect", t1], cand("Mine", "mine"));
    assert.equal(r.code, 2, verb);
    assert.match(r.err, /^stale: re-review/);
    assert.equal(read(p), mid);
  }
  // the entry is gone
  assert.equal(run(cfg, ["rm", "L-02", ...ORG, "--expect", tokenOf(cfg, "L-02")]).code, 0);
  const after = read(p);
  const gone = run(cfg, ["rm", "L-02", ...ORG, "--expect", "a".repeat(64)]);
  assert.equal(gone.code, 2);
  assert.match(gone.err, /^stale: re-review/);
  assert.equal(read(p), after);
});

// ---- AC: crash-safe (a driver loads the helper and breaks os.replace; the shipped file has no test hook) ----

const DRIVER = `
import importlib.machinery, importlib.util, io, os, sys, json, stat
sys.dont_write_bytecode = True
bin_, mode_, cfg = sys.argv[1], sys.argv[2], sys.argv[3]
loader = importlib.machinery.SourceFileLoader("lessons_helper", bin_)
spec = importlib.util.spec_from_loader("lessons_helper", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
def go(argv, text=""):
    sys.stdin = io.TextIOWrapper(io.BytesIO(text.encode()))
    try:
        return m.main(argv)
    except SystemExit as e:
        return e.code
real = os.replace
if mode_ in ("fail-final", "kill-final", "fail-prev", "kill-prev"):
    target = ".lessons.md.prev" if mode_.endswith("prev") else "lessons.md"
    def boom(src, dst, *a, **k):
        if dst == target:
            if mode_.startswith("kill"):
                os._exit(9)
            raise OSError(5, "boom")
        return real(src, dst, *a, **k)
    os.replace = boom
    rc = go(["add", "--org", "acme", "--config", cfg], "Crash title\\nbody\\n")
    sys.exit(rc if isinstance(rc, int) else 1)
if mode_ == "swap":
    outside = sys.argv[4]
    orig = m.take_lock
    def swapped(*a, **k):
        os.rename(os.path.join(cfg, "orgs", "acme"), os.path.join(cfg, "orgs", "acme-real"))
        os.symlink(outside, os.path.join(cfg, "orgs", "acme"))
        return orig(*a, **k)
    m.take_lock = swapped
    rc = go(["add", "--org", "acme", "--config", cfg], "Swap title\\nbody\\n")
    sys.exit(rc if isinstance(rc, int) else 1)
if mode_ == "fsync-fail":
    realf = os.fsync
    def f(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError(5, "EIO")
        return realf(fd)
    os.fsync = f
    rc = go(["add", "--org", "acme", "--config", cfg], "Durable title\\nbody\\n")
    sys.exit(rc if isinstance(rc, int) else 1)
if mode_ == "bootstrap":
    realm = os.mkdir
    def mk(path, *a, **k):
        if path == cfg and "dir_fd" not in k:
            realm(path, 0o700)  # the other writer wins the race right before ours
        return realm(path, *a, **k)
    os.mkdir = mk
    rc = go(["add", "--org", "acme", "--config", cfg], "Boot title\\nbody\\n")
    sys.exit(rc if isinstance(rc, int) else 1)
if mode_ == "root-swap":
    outside = sys.argv[4]
    realm = os.mkdir
    def mk(path, *a, **k):
        r = realm(path, *a, **k)
        if path == "newcfg" and "dir_fd" in k:
            os.rename(cfg, cfg + "-aside")
            os.symlink(outside, cfg)  # between the mkdir and any chmod of the new root
        return r
    os.mkdir = mk
    rc = go(["add", "--org", "acme", "--config", cfg], "Swap root\\nbody\\n")
    sys.exit(rc if isinstance(rc, int) else 1)
if mode_ in ("lock-enoent-once", "lock-enoent-always"):
    realo = os.open
    state = {"n": 0}
    def op(path, *a, **k):
        if isinstance(path, str) and path.endswith(".lock") and (mode_.endswith("always") or state["n"] == 0):
            state["n"] += 1
            raise FileNotFoundError(2, "transient")
        return realo(path, *a, **k)
    os.open = op
    m.time.sleep = lambda s: None
    rc = go(["add", "--org", "acme", "--config", cfg], "Lock title\\nbody\\n")
    print(state["n"])
    sys.exit(rc if isinstance(rc, int) else 1)
if mode_ == "nul":
    for argv in (["add", "--org", "a\\0b"], ["add", "--project", "P\\0"], ["add", "--agent", "x\\0"]):
        rc = go(argv + ["--config", cfg], "T\\nb\\n")
        if rc in (0, None): sys.exit(7)
    sys.exit(0)
if mode_ == "audit":
    opened = []
    sys.addaudithook(lambda ev, args: opened.append(str(args[0])) if ev == "open" else None)
    steps = [
        (["add", "--org", "acme"], "Audit one\\nbody\\n"), (["add", "--project", "P-1"], "Audit two\\nbody\\n"), (["add", "--agent", "wrangler"], "Audit three\\nbody\\n"),
        (["check", "--org", "acme"], "Audit four\\nbody\\n"), (["list", "--org", "acme"], ""), (["stale", "--project", "P-1"], ""), (["list", "--agent", "wrangler", "--full"], ""),
    ]
    for argv, text in steps:
        rc = go(argv + ["--config", cfg], text)
        if rc not in (0, None): sys.exit(10)
    print(json.dumps(opened))
    sys.exit(0)
`;
const driver = (mode, cfg, ...more) => {
  const d = scratch();
  const f = join(d, "driver.py");
  writeFileSync(f, DRIVER);
  const p = spawnSync("python3", ["-I", f, BIN, mode, cfg, ...more], { encoding: "utf8", env: ENV(cfg) });
  return { code: p.status, out: p.stdout, err: p.stderr };
};
const strays = (cfg) => readdirSync(join(cfg, "orgs", "acme")).filter((n) => n.includes(".tmp."));

test("crash-safe: a failure at the final replace leaves the old bytes, .prev holds them, and the retry succeeds", () => {
  const cfg = scratch();
  seed(cfg, SEED2);
  const old = read(file(cfg));
  const r = driver("fail-final", cfg);
  assert.notEqual(r.code, 0, r.err);
  assert.equal(read(file(cfg)), old);
  assert.equal(read(file(cfg, ".lessons.md.prev")), old);
  assert.equal(run(cfg, ["add", ...ORG], cand("Retry works", "ok")).code, 0);
  assert.equal(parsed(file(cfg)).entries.length, 3);
  assert.deepEqual(strays(cfg), []);
});

test("crash-safe: a failure at the .prev publish leaves the old file and no new file; a hard kill leaves a stray tmp the next run cleans", () => {
  const cfg = scratch();
  seed(cfg, SEED2);
  const old = read(file(cfg));
  assert.notEqual(driver("fail-prev", cfg).code, 0);
  assert.equal(read(file(cfg)), old);
  assert.ok(!existsSync(file(cfg, ".lessons.md.prev")));
  const k = driver("kill-final", cfg);
  assert.equal(k.code, 9);
  assert.equal(read(file(cfg)), old);
  assert.equal(run(cfg, ["add", ...ORG], cand("After the kill", "ok")).code, 0);
  assert.deepEqual(strays(cfg), []);
  assert.equal(parsed(file(cfg)).entries.length, 3);
  const cfg2 = scratch();
  seed(cfg2, SEED2);
  assert.equal(driver("kill-prev", cfg2).code, 9);
  assert.equal(read(file(cfg2)), SEED2);
  assert.equal(run(cfg2, ["add", ...ORG], cand("After the kill", "ok")).code, 0);
  assert.deepEqual(strays(cfg2), []);
});

test(".prev holds the previous content after each write", () => {
  const cfg = scratch();
  run(cfg, ["add", ...ORG], cand("One", "a"));
  assert.ok(!existsSync(file(cfg, ".lessons.md.prev")));
  const v1 = read(file(cfg));
  run(cfg, ["add", ...ORG], cand("Two", "b"));
  assert.equal(read(file(cfg, ".lessons.md.prev")), v1);
  const v2 = read(file(cfg));
  run(cfg, ["rm", "L-01", ...ORG, "--expect", tokenOf(cfg, "L-01")]);
  assert.equal(read(file(cfg, ".lessons.md.prev")), v2);
});

// ---- AC: symlink refused ----

test("symlinks refused: file, lock, orgs, orgs/<slug>, .prev, --config; a hardlinked file; nothing outside is written", () => {
  const out = scratch();
  const sentinel = join(out, "sentinel");
  const same = () => { assert.equal(read(sentinel), "SENTINEL"); assert.deepEqual(readdirSync(out), ["sentinel"]); };
  writeFileSync(sentinel, "SENTINEL");
  const cases = {
    file: (cfg) => { mkdirSync(join(cfg, "orgs", "acme"), { recursive: true }); symlinkSync(sentinel, file(cfg)); },
    lock: (cfg) => { mkdirSync(join(cfg, "orgs", "acme"), { recursive: true }); symlinkSync(sentinel, file(cfg, "lessons.md.lock")); },
    orgs: (cfg) => symlinkSync(out, join(cfg, "orgs")),
    slug: (cfg) => { mkdirSync(join(cfg, "orgs")); symlinkSync(out, join(cfg, "orgs", "acme")); },
    prev: (cfg) => { seed(cfg, SEED2); symlinkSync(sentinel, file(cfg, ".lessons.md.prev")); },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const cfg = scratch();
    setup(cfg);
    const r = run(cfg, ["add", ...ORG], cand("Refused", "x"));
    assert.equal(r.code, 1, name);
    same();
    if (name === "prev") assert.equal(read(file(cfg)), SEED2);
  }
  const cfg = scratch();
  const real = join(scratch(), "real");
  mkdirSync(real);
  symlinkSync(real, join(cfg, "link"));
  assert.equal(run(join(cfg, "link"), ["add", ...ORG], cand("Refused", "x")).code, 1);
  assert.deepEqual(readdirSync(real), []);
  for (const verb of ["list", "stale"]) {
    const c = scratch();
    mkdirSync(join(c, "orgs", "acme"), { recursive: true });
    symlinkSync(sentinel, file(c));
    assert.equal(run(c, [verb, ...ORG]).code, 1, verb);
  }
  const c2 = scratch();
  const p = seed(c2, SEED2);
  linkSync(p, join(c2, "hardlink"));
  const h = run(c2, ["add", ...ORG], cand("Refused", "x"));
  assert.equal(h.code, 1);
  assert.equal(read(p), SEED2);
});

test("a directory swapped for a symlink between steps does not redirect the write (fd-anchored)", () => {
  const out = scratch();
  writeFileSync(join(out, "sentinel"), "SENTINEL");
  const cfg = scratch();
  seed(cfg, SEED2);
  const r = driver("swap", cfg, out);
  assert.deepEqual(readdirSync(out), ["sentinel"], r.err);
  assert.equal(read(join(out, "sentinel")), "SENTINEL");
  if (r.code === 0) assert.equal(parsed(join(cfg, "orgs", "acme-real", "lessons.md")).entries.length, 3);
});

// ---- scopes ----

test("bad scope: .., separators, case, length, dot ids, other kinds, two scopes, no scope: refused and nothing is created", () => {
  const cfg = scratch();
  const bad = [
    ["--org", ".."], ["--org", "a/b"], ["--org", "a\\b"], ["--org", "Acme"], ["--org", "x".repeat(41)], ["--org", "-a"], ["--org", ""], ["--org", "a.b"],
    ["--project", "../x"], ["--project", "a/b"], ["--project", ".hidden"], ["--project", "x".repeat(101)], ["--project", ""], ["--project", ".."], ["--project", "  "],
    ["--agent", "../x"], ["--agent", "a/b"], ["--agent", ".x"], ["--agent", "x".repeat(101)], ["--agent", ""],
    ["--org", "acme", "--kind", "permissions"], ["--org", "acme", "--kind", "souls"], ["--org", "acme", "--kind", "../x"], ["--org", "acme", "--kind", "Lessons"],
    ["--project", "P-1", "--kind", "lessons"], ["--org", "acme", "--project", "P-1"], ["--project", "P-1", "--agent", "a"], [],
  ];
  for (const scope of bad) {
    for (const verb of ["add", "list", "stale"]) {
      const r = run(cfg, [verb, ...scope], cand("T", "b"));
      assert.equal(r.code, 1, `${verb} ${JSON.stringify(scope)}`);
    }
  }
  assert.deepEqual(tree(cfg), []);
  const n = driver("nul", cfg);
  assert.equal(n.code, 0, n.err);
  assert.deepEqual(tree(cfg), []);
});

test("only the three roots are touched: a snapshot of the tree lists the expected names", () => {
  const cfg = scratch();
  seed(cfg, "keep\n", ["agents", "wrangler.json"]);
  for (const s of [["--org", "acme"], ["--org", "acme", "--kind", "squads"], ["--project", "P-1"], ["--agent", "wrangler"]]) {
    assert.equal(run(cfg, ["add", ...s], cand("One", "a")).code, 0);
    assert.equal(run(cfg, ["add", ...s], cand("Two", "b")).code, 0);
  }
  assert.deepEqual(tree(cfg), [
    "agents", "agents/.wrangler.lessons.md.prev", "agents/wrangler.json", "agents/wrangler.lessons.md", "agents/wrangler.lessons.md.lock",
    "orgs", "orgs/acme", "orgs/acme/.lessons.md.prev", "orgs/acme/.squads.md.prev", "orgs/acme/lessons.md", "orgs/acme/lessons.md.lock", "orgs/acme/squads.md", "orgs/acme/squads.md.lock",
    "projects", "projects/P-1", "projects/P-1/.lessons.md.prev", "projects/P-1/lessons.md", "projects/P-1/lessons.md.lock",
  ]);
  assert.equal(read(join(cfg, "agents", "wrangler.json")), "keep\n");
});

test("modes: dirs 0700, files, lock and .prev 0600, even with umask 000; a missing config dir is created 0700", () => {
  const parent = scratch();
  const cfg = join(parent, "newcfg");
  const sh = (args, input) => spawnSync("sh", ["-c", 'umask 000; exec "$@"', "sh", BIN, ...args, "--config", cfg], { input, encoding: "utf8", env: ENV(parent) });
  assert.equal(sh(["add", ...ORG], cand("One", "a")).status, 0);
  assert.equal(sh(["add", ...ORG], cand("Two", "b")).status, 0);
  assert.equal(sh(["add", "--agent", "wrangler"], cand("Three", "b")).status, 0);
  for (const d of [cfg, join(cfg, "orgs"), join(cfg, "orgs", "acme"), join(cfg, "agents")]) assert.equal(mode(d), "700", d);
  for (const f of ["lessons.md", "lessons.md.lock", ".lessons.md.prev"]) assert.equal(mode(file(cfg, f)), "600", f);
  assert.equal(mode(join(cfg, "agents", "wrangler.lessons.md")), "600");
  assert.equal(mode(join(cfg, "agents", "wrangler.lessons.md.lock")), "600");
  // an existing file with loose bits is tightened by the next write
  chmodSync(file(cfg), 0o644);
  assert.equal(sh(["add", ...ORG], cand("Four", "d")).status, 0);
  assert.equal(mode(file(cfg)), "600");
});

// ---- AC: default souls never opened; herd export has no lessons ----

test("the default souls are never opened: souls/ mode 000 and bait files, every verb passes, only the three roots are opened", () => {
  const cfg = scratch();
  mkdirSync(join(cfg, "souls"));
  writeFileSync(join(cfg, "souls", "wrangler.md"), "SOUL BAIT");
  chmodSync(join(cfg, "souls"), 0o000);
  writeFileSync(join(cfg, "permissions.md"), "BAIT");
  mkdirSync(join(cfg, "orgs", "acme"), { recursive: true });
  writeFileSync(join(cfg, "orgs", "acme", "permissions.md"), "BAIT");
  writeFileSync(join(cfg, "orgs", "acme", ".seal"), "BAIT");
  const r = driver("audit", cfg);
  chmodSync(join(cfg, "souls"), 0o700);
  assert.equal(r.code, 0, r.err);
  const opened = JSON.parse(r.out.trim().split("\n").pop());
  const ok = /^\.?(lessons\.md|wrangler\.lessons\.md)(\.lock|\.prev|\.tmp\.\d+(\.prev)?)?$/;
  const dirs = new Set(["orgs", "projects", "agents", "acme", "P-1", "/", cfg, ...cfg.split("/").filter(Boolean)]);
  for (const p of opened) {
    if (/\.(py|pyc|so|dylib)$/.test(p) || /^\/(usr|System|Library|opt|private\/var\/db|etc|dev)\b/.test(p) || p.startsWith("<")) continue;
    if (p.startsWith(`${cfg}/`) || !p.startsWith("/")) {
      const base = p.split("/").pop();
      assert.ok(ok.test(base) || dirs.has(base) || dirs.has(p), `opened ${p}`);
    }
    assert.ok(!/souls|permissions|\.seal|work/.test(p), `opened ${p}`);
  }
  assert.ok(opened.some((p) => /lessons\.md/.test(p)));
  assert.ok(!/souls/i.test(readFileSync(BIN, "utf8")), "the helper source never names the souls folder");
  assert.equal(read(join(cfg, "orgs", "acme", "permissions.md")), "BAIT");
  assert.equal(run(cfg, ["list", ...ORG]).code, 0);
});

test("herd export carries no lessons: the export over a config with lessons has none, and the export paths never read the lesson files", () => {
  const cfg = scratch();
  run(cfg, ["add", ...ORG], cand("UNIQUE-LESSON-MARKER title", "UNIQUE-LESSON-MARKER body"));
  seed(cfg, "UNIQUE-PERMISSION-MARKER", ["orgs", "acme", "permissions.md"]);
  const herd = { agents: [{ id: "wrangler", name: "Wrangler", command: "claude", instructions: "do the work", soul: "wrangler" }], squads: [] };
  const r = exportHerd(herd, { souls: { wrangler: "a".repeat(64) }, home: "/h", now: 0, app: "x" });
  const text = JSON.stringify(r);
  assert.ok(r.file || r.header || r.data || text.length > 10);
  assert.ok(!/UNIQUE-/.test(text));
  for (const f of ["herd-export.js", "herd-share.js", "io.js"]) {
    const src = readFileSync(new URL(`../_lib/${f}`, import.meta.url), "utf8");
    assert.ok(!/["'`/]orgs\/|\.lessons\.md|lessons\.md|projects\/\$\{[^}]*\}\/lessons|permissions\.md|\.seal\b/.test(src), `${f} reads a lessons or permissions path`);
  }
});

// ---- format parity with _lib/lessons.js ----

test("format parity: a corpus of titles and bodies is accepted or refused like formatEntry and produces identical text", () => {
  const astral = (k) => "😀".repeat(k);
  const fit = (build) => { let k = 1; while (true) { try { L.formatEntry(build(k + 1)); k++; } catch { return k; } if (k > 400) return k; } };
  const kT = fit((k) => ({ n: 1, title: astral(k), body: ["b"], added: today() }));
  const kB = fit((k) => ({ n: 1, title: "T", body: [astral(k)], added: today() }));
  const abc = (len) => "abc ".repeat(Math.ceil(len / 4)).slice(0, len - 1) + "d";
  const corpus = [
    ["Plain title", ["one line"]], ["Three lines", ["a", "b", "c"]], [abc(120), ["b"]], [abc(121), ["b"]],
    [astral(kT), ["b"]], [astral(kT + 1), ["b"]], ["T", [astral(kB)]], ["T", [astral(kB + 1)]],
    ["Café title", ["b"]], ["Title", ["café body"]], ["a\u0007b", ["b"]], ["a  b", ["b"]], ["a b", ["b"]], ["a​b", ["b"]], [" lead", ["b"]], ["trail ", ["b"]],
    ["# hash", ["b"]], ["- dash", ["b"]], ["> quote", ["b"]], ["with <tag>", ["b"]], ["with `tick`", ["b"]],
    ["tag [org] here", ["b"]], ["tag [Project] here", ["b"]], ["tag [AGENT] here", ["b"]], ["tag [other] here", ["b"]],
    ["T", ["### heading"]], ["T", ["  indented"]], ["T", ["tail (added 2026-01-01)"]], ["T", ["tail (added 2026-13-45)"]], ["T", ["tail (added 2026-01-01 · bad src)"]],
    ["T", ["tail (confirmed 2026-01-01)"]], ["T", ["a (b) c"]], ["T", ["ends with (added"]],
    ["T", [abc(380)]], ["T", [abc(300), abc(80)]], ["T", [abc(385)]], ["T", [abc(392)]], ["T", [abc(400)]],
    ["Ünïcode títle", ["bödy"]], ["日本語のタイトル", ["本文"]],
  ];
  const src = [null, "T-MW1", "run-12", "bad src", "x".repeat(41), "a_b"];
  const cases = corpus.map(([t, b]) => [t, b, null]).concat(src.slice(1).map((s) => ["Src title", ["b"], s]));
  for (const [title, body, source] of cases) {
    const cfg = scratch();
    const label = JSON.stringify([title.slice(0, 40), body.map((x) => x.length), source]);
    let want = null;
    try { want = L.formatEntry({ n: 1, title, body, added: today(), source }); } catch { /* refused */ }
    const input = `${title}\n${body.join("\n")}\n`;
    const c = run(cfg, ["check", ...(source ? ["--source", source] : [])], input);
    const a = run(cfg, ["add", ...ORG, ...(source ? ["--source", source] : [])], input);
    if (want === null) {
      assert.equal(c.code, 1, `check should refuse ${label}`);
      assert.equal(a.code, 1, `add should refuse ${label}`);
      assert.ok(!existsSync(file(cfg)), label);
    } else {
      assert.equal(c.code, 0, `check should accept ${label}: ${c.all}`);
      assert.equal(a.code, 0, `add should accept ${label}: ${a.all}`);
      assert.equal(read(file(cfg)), `${want}\n`, label);
      const p = parsed(file(cfg));
      assert.equal(p.skipped, 0);
      assert.equal(p.entries.length, 1);
    }
  }
});

test("dedup: an exact normalised-title duplicate is refused by add, edit and check (case, spaces, NFC); other titles pass", () => {
  const cfg = scratch();
  assert.equal(run(cfg, ["add", ...ORG], cand("Run The Tests", "a")).code, 0);
  assert.equal(run(cfg, ["add", ...ORG], cand("Second", "b")).code, 0);
  const before = read(file(cfg));
  for (const t of ["Run The Tests", "run the tests", "RUN THE TESTS"]) {
    const a = run(cfg, ["add", ...ORG], cand(t, "x"));
    assert.equal(a.code, 1, t);
    assert.match(a.all, /duplicate title/);
    assert.equal(run(cfg, ["check", ...ORG], cand(t, "x")).code, 1);
  }
  const e = run(cfg, ["edit", "L-02", ...ORG, "--expect", tokenOf(cfg, "L-02")], cand("run the tests", "x"));
  assert.equal(e.code, 1);
  assert.match(e.all, /duplicate title/);
  assert.equal(read(file(cfg)), before);
  assert.equal(run(cfg, ["edit", "L-02", ...ORG, "--expect", tokenOf(cfg, "L-02")], cand("Second", "same title kept")).code, 0);
  assert.equal(run(cfg, ["check", ...ORG], cand("Another one", "x")).out.trim(), "ok");
  assert.equal(run(cfg, ["check"], cand("Run The Tests", "x")).out.trim(), "ok"); // no scope: no dedup
});

test("size limits: a file over 65536 bytes is refused for writes, and a result over it is refused", () => {
  const cfg = scratch();
  const entry = (n) => `### L-${String(n).padStart(2, "0")} Title ${n}\n${"filler ".repeat(30).trim()}\n\n`;
  let big = "";
  for (let n = 1; Buffer.byteLength(big) < 65536 - 100; n++) big += entry(n);
  seed(cfg, big);
  const before = read(file(cfg));
  const r = run(cfg, ["add", ...ORG], cand("One too many", "word ".repeat(30).trim()));
  assert.equal(r.code, 1);
  assert.match(r.all, /refused/);
  assert.equal(read(file(cfg)), before);
  const cfg2 = scratch();
  seed(cfg2, "x".repeat(70000));
  assert.equal(run(cfg2, ["add", ...ORG], cand("T", "b")).code, 1);
  assert.equal(read(file(cfg2)), "x".repeat(70000));
});

test("a malformed or duplicate-id entry blocks writes ('fix by hand') but not reads; text outside entries is kept byte for byte", () => {
  const cfg = scratch();
  const bad = "# Org lessons\n\nSome note.\n\n### L-01 Fine\nbody\n\n### L-01 Duplicate id\nbody\n";
  seed(cfg, bad);
  const r = run(cfg, ["add", ...ORG], cand("New", "b"));
  assert.equal(r.code, 1);
  assert.match(r.all, /fix by hand/);
  assert.equal(read(file(cfg)), bad);
  assert.equal(run(cfg, ["list", ...ORG]).code, 0);
  const cfg2 = scratch();
  const hand = "# Org lessons\n\nSome note.\n\n### L-1 Hand title\nBody one\n\n### L-7 Second\nBody two (added 2026-02-03 · T-1 · confirmed 2026-03-04)\n\ntrailing text\n";
  seed(cfg2, hand);
  assert.equal(run(cfg2, ["add", ...ORG], cand("Third", "b")).out.split("\t")[0], "L-08");
  assert.ok(read(file(cfg2)).startsWith(hand));
  const e = run(cfg2, ["edit", "L-07", ...ORG, "--expect", tokenOf(cfg2, "L-07")], cand("Second v2", "new body"));
  assert.equal(e.code, 0, e.all);
  const t = read(file(cfg2));
  assert.ok(t.startsWith("# Org lessons\n\nSome note.\n\n### L-1 Hand title\nBody one\n\n### L-07 Second v2\n"));
  assert.ok(t.includes("trailing text\n"));
  const x = parsed(file(cfg2)).entries.find((y) => y.id === "L-07");
  assert.deepEqual([x.added, x.source, x.confirmed], ["2026-02-03", "T-1", null]);
  assert.equal(run(cfg2, ["rm", "L-01", ...ORG, "--expect", tokenOf(cfg2, "L-01")]).code, 0);
  assert.ok(read(file(cfg2)).startsWith("# Org lessons\n\nSome note.\n\n### L-07"));
});

test("L-999999: the id space is exhausted, add is refused", () => {
  const cfg = scratch();
  const s = "### L-999999 Last\nbody\n";
  seed(cfg, s);
  const r = run(cfg, ["add", ...ORG], cand("T", "b"));
  assert.equal(r.code, 1);
  assert.equal(read(file(cfg)), s);
});

test("the edit token is the sha-256 of the canonical entry text; hand-edited entries use the same canonical form", () => {
  const cfg = scratch();
  seed(cfg, "### L-1 Hand title\r\nBody one (added 2026-02-03)\r\n");
  const e = parsed(file(cfg)).entries[0];
  const canon = L.formatEntry({ n: e.n, title: e.title, body: e.body, added: e.added, source: e.source, confirmed: e.confirmed });
  assert.equal(tokenOf(cfg, "L-01"), sha(canon));
  assert.equal(tokenOf(cfg, "L-1"), undefined); // rows print canonical ids
  const c = run(cfg, ["confirm", "L-1", ...ORG, "--expect", sha(canon)]);
  assert.equal(c.code, 0, c.all);
  assert.equal(parsed(file(cfg)).entries[0].confirmed, today());
});

test("undated entries: confirm is refused and invents no date; edit sets added; stale lists them", () => {
  const cfg = scratch();
  seed(cfg, "### L-01 No date\nbody\n");
  const before = read(file(cfg));
  const c = run(cfg, ["confirm", "L-01", ...ORG, "--expect", tokenOf(cfg, "L-01")]);
  assert.equal(c.code, 1);
  assert.match(c.all, /refused: undated entry, edit it first/);
  assert.equal(read(file(cfg)), before);
  assert.ok(run(cfg, ["stale", ...ORG]).out.includes("L-01"));
  const e = run(cfg, ["edit", "L-01", ...ORG, "--expect", tokenOf(cfg, "L-01")], cand("Now dated", "body"));
  assert.equal(e.code, 0, e.all);
  const x = parsed(file(cfg)).entries[0];
  assert.deepEqual([x.added, x.confirmed], [today(), null]);
  assert.ok(!run(cfg, ["stale", ...ORG]).out.includes("L-01"));
});

test("list and stale: columns, --full, --days, confirmed beats added, undated is stale, candidate text never printed", () => {
  const cfg = scratch();
  seed(cfg, [
    "### L-01 Old one\nb1 (added 2020-01-01)", "### L-02 Old but confirmed\nb2 (added 2020-01-01 · confirmed " + today() + ")",
    "### L-03 Fresh\nb3 (added " + today() + ")", "### L-04 Undated\nb4", "### L-05 Old source\nb5 (added 2020-02-02 · T-9)",
  ].join("\n\n") + "\n");
  const rows = listRows(cfg);
  assert.deepEqual(rows.map((r) => r[0]), ["L-01", "L-02", "L-03", "L-04", "L-05"]);
  assert.deepEqual(rows[1].slice(2), ["2020-01-01", today(), "Old but confirmed"]);
  assert.deepEqual(rows[3].slice(2), ["-", "-", "Undated"]);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r[1])));
  const full = run(cfg, ["list", ...ORG, "--full"]).out;
  assert.ok(full.includes("b5") && full.includes("T-9"));
  assert.ok(!/^ /m.test(run(cfg, ["list", ...ORG]).out), "no entry text without --full");
  const st = (extra = []) => run(cfg, ["stale", ...ORG, ...extra]).out.trim().split("\n").filter(Boolean).map((l) => l.split("\t")[0]);
  assert.deepEqual(st(), ["L-01", "L-04", "L-05"]);
  assert.deepEqual(st(["--days", "0"]), ["L-01", "L-04", "L-05"]);
  assert.deepEqual(st(["--days", "100000"]), ["L-04"]);
  assert.notEqual(run(cfg, ["stale", ...ORG, "--days", "x"]).code, 0);
  assert.notEqual(run(cfg, ["stale", ...ORG, "--days", "-1"]).code, 0);
  assert.equal(run(scratch(), ["list", ...ORG]).out, "");
  assert.equal(run(scratch(), ["list", ...ORG]).code, 0);
});

test("usage errors: unknown verbs and flags, missing ids, relative --config, exit 1, no stack trace", () => {
  const cfg = scratch();
  for (const args of [[], ["nope", ...ORG], ["add", ...ORG, "--wat"], ["edit", ...ORG, "--expect", "a".repeat(64)], ["rm", "X-1", ...ORG, "--expect", "a".repeat(64)], ["rm", "L-0", ...ORG, "--expect", "a".repeat(64)], ["list", ...ORG, "--days", "3"]]) {
    const r = run(cfg, args, cand("T", "b"));
    assert.equal(r.code, 1, JSON.stringify(args));
    assert.ok(!/Traceback/.test(r.all));
  }
  const rel = spawnSync(BIN, ["list", ...ORG, "--config", "relative/dir"], { encoding: "utf8", env: ENV(cfg) });
  assert.equal(rel.status, 1);
  assert.deepEqual(tree(cfg), []);
});

// ---- review round 1 ----

test("scan covers every field about to be published: confirm's stored title/body/source and edit's retained source", () => {
  const marks = ["AKIAZZZZ1234", "gh" + "p_abc12345", "sk-abc12345678"];
  const seeds = {
    title: `### L-01 Key ${marks[0]}\nclean body (added 2026-01-01)\n`,
    body: `### L-01 Clean title\nbody ${marks[1]} here (added 2026-01-01)\n`,
    source: `### L-01 Clean title\nclean body (added 2026-01-01 · ${marks[2]})\n`,
  };
  for (const [where, text] of Object.entries(seeds)) {
    const cfg = scratch();
    seed(cfg, text);
    const tok = tokenOf(cfg, "L-01");
    assert.ok(tok, where);
    const c = run(cfg, ["confirm", "L-01", ...ORG, "--expect", tok]);
    assert.equal(c.code, 1, `confirm ${where}`);
    assert.ok(!marks.some((m) => c.all.includes(m)), `confirm ${where} echoed`);
    assert.equal(read(file(cfg)), text, `confirm ${where} changed the file`);
    if (where === "source") {
      const e = run(cfg, ["edit", "L-01", ...ORG, "--expect", tok], cand("Entirely clean", "clean body"));
      assert.equal(e.code, 1, "edit keeps an unsafe source");
      assert.ok(!e.all.includes(marks[2]));
      assert.equal(read(file(cfg)), text);
    } else {
      const e = run(cfg, ["edit", "L-01", ...ORG, "--expect", tok], cand("Entirely clean", "clean body"));
      assert.equal(e.code, 0, `edit replaces an unsafe ${where}: ${e.all}`);
    }
    const rm = run(cfg, ["rm", "L-01", ...ORG, "--expect", tokenOf(cfg, "L-01") ?? tok]);
    assert.equal(rm.code, 0, `rm ${where}`);
  }
});

test("a failed directory fsync is not reported as success: nonzero, 'published, durability uncertain', no token", () => {
  const cfg = scratch();
  seed(cfg, SEED2);
  const r = driver("fsync-fail", cfg);
  assert.notEqual(r.code, 0, r.err);
  assert.equal(r.out, "");
  assert.match(r.err, /published/);
  assert.match(r.err, /durability is uncertain/);
  assert.equal(parsed(file(cfg)).entries.length, 3);
});

const fifo = (p) => assert.equal(spawnSync("mkfifo", ["-m", "600", p]).status, 0);

test("a named pipe never blocks the helper: lesson file, lock file and --text-file are refused as non-regular", () => {
  const cfg = scratch();
  mkdirSync(join(cfg, "orgs", "acme"), { recursive: true });
  fifo(file(cfg));
  for (const args of [["list", ...ORG], ["stale", ...ORG], ["add", ...ORG]]) {
    const r = run(cfg, args, cand("T", "b"));
    assert.equal(r.code, 1, `${args[0]} on a FIFO file (null = hung)`);
  }
  const cfg2 = scratch();
  mkdirSync(join(cfg2, "orgs", "acme"), { recursive: true });
  fifo(file(cfg2, "lessons.md.lock"));
  assert.equal(run(cfg2, ["add", ...ORG], cand("T", "b")).code, 1);
  const f = join(scratch(), "pipe");
  fifo(f);
  assert.equal(run(scratch(), ["check", "--text-file", f]).code, 1);
});

test("config bootstrap race: another writer creating the config dir first does not make add fail", () => {
  const parent = scratch();
  const cfg = join(parent, "newcfg");
  const r = driver("bootstrap", cfg);
  assert.equal(r.code, 0, r.err);
  assert.equal(parsed(file(cfg)).entries.length, 1);
  assert.equal(mode(cfg), "700");
});

// ---- review round 2 ----

test("config bootstrap: a root swapped for a symlink right after its mkdir is refused and the outside dir is never chmodded", () => {
  const parent = scratch();
  const cfg = join(parent, "newcfg");
  const out = join(scratch(), "outside");
  mkdirSync(out);
  chmodSync(out, 0o755);
  writeFileSync(join(out, "sentinel"), "SENTINEL");
  const r = driver("root-swap", cfg, out);
  assert.equal(r.code, 1, r.err);
  assert.equal(mode(out), "755");
  assert.deepEqual(readdirSync(out), ["sentinel"]);
  assert.equal(read(join(out, "sentinel")), "SENTINEL");
});

test("lock creation retries a transient ENOENT (bounded): one injected miss still lands the add, a persistent one is refused", () => {
  const cfg = scratch();
  const r = driver("lock-enoent-once", cfg);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split("\n").pop(), "1");
  assert.equal(parsed(file(cfg)).entries.length, 1);
  const cfg2 = scratch();
  const p = driver("lock-enoent-always", cfg2);
  assert.equal(p.code, 1);
  assert.ok(Number(p.out.trim().split("\n").pop()) <= 25, "the retry is bounded");
  assert.ok(!existsSync(file(cfg2)));
});

test("racing: repeated 10-writer rounds on fresh files never lose an add (lock creation is the hot spot)", async () => {
  for (let round = 0; round < 15; round++) {
    const cfg = scratch();
    mkdirSync(join(cfg, "orgs", "acme"), { recursive: true });
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => arun(cfg, ["add", ...ORG], cand(`Round ${round} lesson ${i}`, "b"))));
    for (const r of rs) assert.equal(r.code, 0, `round ${round}: ${r.err}`);
    assert.equal(parsed(file(cfg)).entries.length, 10);
    rmSync(cfg, { recursive: true, force: true });
  }
});
