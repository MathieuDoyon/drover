// drover-lessons-read: a read-only, bounded, symlink-safe reader for the lesson files. Temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readdirSync, renameSync, rmSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "./stubs/until.js";

const BIN = new URL("../drover-agents/bin/drover-lessons-read", import.meta.url).pathname;
const root = () => realpathSync(mkdtempSync(join(tmpdir(), "lessons-read-")));
const put = (p, text = "x") => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
const run = (...args) => { const p = spawnSync(BIN, args, { encoding: "utf8", env: { PATH: process.env.PATH } }); return { code: p.status, out: p.stdout, err: p.stderr, json: p.status === 0 ? JSON.parse(p.stdout) : null }; };
const tree = (dir) => readdirSync(dir, { recursive: true }).sort().join("|");

test("reads a regular file: text and truncated false; many paths in one call, each answered", () => {
  const r = root();
  put(join(r, "orgs/acme/lessons.md"), "### L-1 Hello é\nbody\n");
  put(join(r, "agents/w.lessons.md"), "### L-2 Two\nb\n");
  const x = run("--root", r, "orgs/acme/lessons.md", "agents/w.lessons.md", "projects/P-1/lessons.md");
  assert.equal(x.code, 0, x.err);
  assert.deepEqual(x.json, {
    "orgs/acme/lessons.md": { text: "### L-1 Hello é\nbody\n", truncated: false },
    "agents/w.lessons.md": { text: "### L-2 Two\nb\n", truncated: false },
    "projects/P-1/lessons.md": null,
  });
});

test("never writes: the tree is the same after a run, nothing is created for a missing file", () => {
  const r = root();
  put(join(r, "orgs/acme/lessons.md"), "a");
  const before = tree(r);
  run("--root", r, "orgs/acme/lessons.md", "orgs/none/lessons.md", "projects/P-1/lessons.md");
  assert.equal(tree(r), before);
});

test("usage errors exit 1 with a message; a bad file never does", () => {
  const r = root();
  for (const args of [[], ["--root", r], ["--root", "rel", "a"], ["a"], ["--root", r, "/abs"], ["--root", r, "../x"], ["--root", r, "a/../b"], ["--root", r, "a//b"], ["--root", r, "./a"], ["--root", r, ""]] ) {
    const x = run(...args);
    assert.equal(x.code, 1, JSON.stringify(args));
    assert.match(x.err, /^drover-lessons-read: /);
    assert.equal(x.out, "");
  }
  assert.equal(run("--root", join(r, "gone"), "a").code, 0); // a missing root: every file is absent, not an error
});

test("a symlink leaf, a symlink in any parent, a directory, a FIFO and a device give null", () => {
  const r = root(), out = root();
  put(join(out, "secret.md"), "### L-1 secret\nx\n");
  put(join(out, "orgs/acme/lessons.md"), "### L-1 secret\nx\n");
  mkdirSync(join(r, "orgs"));
  symlinkSync(join(out, "orgs/acme"), join(r, "orgs/acme"));
  mkdirSync(join(r, "projects/P-1"), { recursive: true });
  symlinkSync(join(out, "secret.md"), join(r, "projects/P-1/lessons.md"));
  symlinkSync(out, join(r, "agents"));
  mkdirSync(join(r, "orgs/dir/lessons.md"), { recursive: true });
  spawnSync("mkfifo", [join(r, "orgs/dir/workflows.md")]);
  const x = run("--root", r, "orgs/acme/lessons.md", "projects/P-1/lessons.md", "agents/secret.md", "orgs/dir/lessons.md", "orgs/dir/workflows.md");
  assert.equal(x.code, 0, x.err);
  assert.deepEqual(Object.values(x.json), [null, null, null, null, null]);
});

test("the root itself may be a symlink (a system alias); only what is below it is checked", () => {
  const real = root(), alias = join(root(), "alias");
  put(join(real, "agents/w.lessons.md"), "ok");
  symlinkSync(real, alias);
  assert.deepEqual(run("--root", alias, "agents/w.lessons.md").json, { "agents/w.lessons.md": { text: "ok", truncated: false } });
});

test("bounded: a file over 64 KB is read for 65537 bytes only and flagged truncated", () => {
  const r = root();
  put(join(r, "a.md"), "### L-1 A\n" + "q".repeat(300000));
  const x = run("--root", r, "a.md");
  assert.equal(x.json["a.md"].truncated, true);
  assert.equal(Buffer.byteLength(x.json["a.md"].text), 65537);
  put(join(r, "exact.md"), "x".repeat(65536));
  assert.deepEqual(run("--root", r, "exact.md").json["exact.md"].truncated, false);
});

test("a multibyte character split by the cap is trimmed, not an error; invalid UTF-8 gives null", () => {
  const r = root();
  put(join(r, "m.md"), "a".repeat(65536 - 1) + "日本"); // the cap lands inside the first character
  const x = run("--root", r, "m.md");
  assert.equal(x.json["m.md"].truncated, true);
  assert.equal(x.json["m.md"].text, "a".repeat(65535));
  writeFileSync(join(r, "bad.md"), Buffer.from([0x23, 0xff, 0xfe, 0x0a]));
  assert.equal(run("--root", r, "bad.md").json["bad.md"], null);
});

test("an unreadable file gives null, not an error", { skip: process.getuid?.() === 0 }, () => {
  const r = root();
  put(join(r, "p.md"), "x");
  spawnSync("chmod", ["000", join(r, "p.md")]);
  assert.equal(run("--root", r, "p.md").json["p.md"], null);
});

// Deterministic races: with DROVER_LESSONS_READ_PAUSE=<dir> the helper stops before opening each path part, prints "step <n> <part>" to
// stderr and waits for the file <dir>/go-<n>. The test swaps the tree at that point.
async function paused(r, rel, swaps) {
  const ctl = root();
  const child = spawn(BIN, ["--root", r, rel], { env: { PATH: process.env.PATH, DROVER_LESSONS_READ_PAUSE: ctl } });
  let err = "", out = "";
  child.stderr.on("data", (d) => { err += d; });
  child.stdout.on("data", (d) => { out += d; });
  let done = false;
  const closed = new Promise((res) => child.on("close", () => { done = true; res(); }));
  for (let n = 0; n < rel.split("/").length; n++) {
    await until(() => done || err.includes(`step ${n} `), `step ${n}`); // a refused component ends the walk: no later step
    if (done) break;
    swaps[n]?.();
    writeFileSync(join(ctl, `go-${n}`), "");
  }
  await closed;
  return JSON.parse(out)[rel];
}

test("race: the leaf swapped for a symlink between the checks and the open is refused", async () => {
  const r = root(), out = root();
  put(join(out, "secret.md"), "SECRET");
  put(join(r, "orgs/acme/lessons.md"), "real");
  const got = await paused(r, "orgs/acme/lessons.md", { 2: () => { rmSync(join(r, "orgs/acme/lessons.md")); symlinkSync(join(out, "secret.md"), join(r, "orgs/acme/lessons.md")); } });
  assert.equal(got, null);
});

test("race: the leaf swapped for a FIFO is refused and the helper does not block", async () => {
  const r = root();
  put(join(r, "orgs/acme/lessons.md"), "real");
  const got = await paused(r, "orgs/acme/lessons.md", { 2: () => { rmSync(join(r, "orgs/acme/lessons.md")); spawnSync("mkfifo", [join(r, "orgs/acme/lessons.md")]); } });
  assert.equal(got, null);
});

test("race: a parent directory swapped for a symlink before it is opened is refused", async () => {
  const r = root(), out = root();
  put(join(out, "acme/lessons.md"), "SECRET");
  put(join(r, "orgs/acme/lessons.md"), "real");
  const got = await paused(r, "orgs/acme/lessons.md", { 1: () => { renameSync(join(r, "orgs/acme"), join(r, "orgs/acme-gone")); symlinkSync(join(out, "acme"), join(r, "orgs/acme")); } });
  assert.equal(got, null);
});

test("race: a parent swapped AFTER its descriptor is open never redirects the read (it reads the original, never the link target)", async () => {
  const r = root(), out = root();
  put(join(out, "acme/lessons.md"), "SECRET");
  put(join(r, "orgs/acme/lessons.md"), "real");
  const got = await paused(r, "orgs/acme/lessons.md", { 2: () => { renameSync(join(r, "orgs/acme"), join(r, "orgs/acme-gone")); symlinkSync(join(out, "acme"), join(r, "orgs/acme")); } });
  assert.deepEqual(got, { text: "real", truncated: false });
});

test("the pause hook off: no env, no waiting", () => {
  const r = root();
  put(join(r, "a/b.md"), "x");
  const t = statSync(BIN);
  assert.ok(t.mode & 0o100, "executable");
  assert.equal(run("--root", r, "a/b.md").code, 0);
  assert.equal(existsSync(join(r, "go-0")), false);
});
