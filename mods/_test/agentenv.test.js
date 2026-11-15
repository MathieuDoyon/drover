// drover-env wrapper: fail closed, never prints a value, exec replaces the process. Fake canary values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentEnv } from "../_lib/runs.js";

const WRAPPER = new URL("../drover-agents/bin/drover-env", import.meta.url).pathname;
const CANARY = "CANARY-fake-7f3a91-not-a-secret";
const CANARY2 = "CANARY-fake-b20c44-not-a-secret";
const MARK = "child-ran-marker";

const file = (env) => JSON.stringify({ version: 1, env });
const entry = (v = CANARY) => ({ value: v, secret: true });

// A disposable config home: <root>/agents (0700) with <id>.json (0600).
function home(content, { id = "bot", fileMode = 0o600, dirMode = 0o700 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentenv-"));
  const dir = join(root, "agents");
  mkdirSync(dir, { mode: 0o700 });
  if (content !== undefined) {
    const p = join(dir, `${id}.json`);
    writeFileSync(p, content);
    chmodSync(p, fileMode);
  }
  chmodSync(dir, dirMode);
  return { root, dir, path: join(dir, `${id}.json`) };
}

const CHILD = ["sh", "-c", `echo ${MARK}; echo "$FOO"`];
function run(h, args = ["bot", "--", ...CHILD], extraEnv = {}) {
  const r = spawnSync(WRAPPER, args, {
    env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: h.root, ...extraEnv },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function failsClosed(h, args, why) {
  const r = run(h, args);
  assert.equal(r.code, 1, why + ` (stderr: ${r.err})`);
  assert.ok(!r.out.includes(MARK), why + ": child must not run");
  for (const s of [r.out, r.err]) { assert.ok(!s.includes(CANARY), why + ": canary leaked"); assert.ok(!s.includes(CANARY2), why + ": canary leaked"); }
  assert.match(r.err, /^drover-env: /, why);
  return r;
}
const good = () => home(file({ FOO: entry() }));

test("success: variables reach the child, stdout/stderr of the wrapper add nothing", () => {
  const h = good();
  const r = run(h);
  assert.equal(r.code, 0);
  assert.equal(r.out, `${MARK}\n${CANARY}\n`); // only what the child printed
  assert.equal(r.err, "");
  rmSync(h.root, { recursive: true });
});

test("success: file value overrides the inherited one; inherited others stay", () => {
  const h = good();
  const r = run(h, ["bot", "--", "sh", "-c", 'echo "$FOO $KEEP"'], { FOO: "inherited", KEEP: "kept" });
  assert.equal(r.out, `${CANARY} kept\n`);
});

test("success: no canary in wrapper stderr and an empty env object is fine", () => {
  const h = home(file({}));
  const r = run(h);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
});

test("child exit code passes through", () => {
  const h = good();
  assert.equal(run(h, ["bot", "--", "sh", "-c", "exit 7"]).code, 7);
});

test("exec replaces the process: the child pid is the wrapper pid", async () => {
  const h = good();
  const p = spawn(WRAPPER, ["bot", "--", "sh", "-c", "echo $$"], { env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: h.root } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  await new Promise((res) => p.on("close", res));
  assert.equal(Number(out.trim()), p.pid);
});

test("unknown command: exit 127, no canary", () => {
  const h = good();
  const r = run(h, ["bot", "--", "no-such-command-drover-env"]);
  assert.equal(r.code, 127);
  assert.ok(!r.out.includes(CANARY) && !r.err.includes(CANARY));
});

test("fail closed: file mode other than 0600", () => {
  for (const m of [0o644, 0o640, 0o660, 0o400, 0o700, 0o666]) failsClosed(home(file({ FOO: entry() }), { fileMode: m }), undefined, `file mode ${m.toString(8)}`);
});

test("fail closed: directory mode other than 0700", () => {
  for (const m of [0o755, 0o750, 0o770, 0o500]) {
    const h = home(file({ FOO: entry() }), { dirMode: m });
    failsClosed(h, undefined, `dir mode ${m.toString(8)}`);
    chmodSync(h.dir, 0o700);
  }
});

test("fail closed: wrong owner (root only: chown needs it)", { skip: process.getuid() !== 0 }, () => {
  const h = good();
  spawnSync("chown", ["65534", h.path]);
  failsClosed(h, undefined, "file owner");
});

test("fail closed: symlinked file, symlinked agents dir", () => {
  const h = home(undefined);
  const real = home(file({ FOO: entry() }), { id: "real" });
  symlinkSync(real.path, h.path);
  failsClosed(h, undefined, "symlink file");
  const root = mkdtempSync(join(tmpdir(), "agentenv-"));
  symlinkSync(real.dir, join(root, "agents"));
  failsClosed({ root }, undefined, "symlink dir");
});

test("fail closed: larger than 8 KiB (even if the JSON is valid)", () => {
  failsClosed(home(file({ FOO: entry("x".repeat(8200) + CANARY) })), undefined, "oversize");
  // exactly at the limit is fine
  const pad = file({ FOO: entry("") }).length;
  const h = home(file({ FOO: entry("y".repeat(8192 - pad)) }));
  assert.equal(run(h, ["bot", "--", "true"]).code, 0);
});

test("fail closed: missing file, missing agents dir, bad agent id", () => {
  failsClosed(home(undefined), undefined, "missing file");
  failsClosed({ root: mkdtempSync(join(tmpdir(), "agentenv-")) }, undefined, "missing dir");
  const h = good();
  for (const id of ["", "../bot", "a/b", "bot.json", "a b", "x".repeat(65), ".hidden"]) failsClosed(h, [id, "--", ...CHILD], `agent id ${JSON.stringify(id)}`);
});

test("fail closed: usage errors (no child, no --, no id)", () => {
  const h = good();
  failsClosed(h, ["bot", "--"], "no child");
  failsClosed(h, ["bot"], "no --");
  failsClosed(h, ["bot", ...CHILD], "missing --");
  failsClosed(h, [], "no args");
});

test("fail closed: invalid JSON and schema, error text never echoes content", () => {
  const bad = [
    `{"version":1,"env":{"FOO":{"value":"${CANARY}"`, // truncated: python's json error would show position
    `not json ${CANARY}`,
    "",
    "[]",
    "null",
    JSON.stringify({ version: 2, env: { FOO: entry() } }),
    JSON.stringify({ version: true, env: { FOO: entry() } }),
    JSON.stringify({ env: { FOO: entry() } }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, env: [entry()] }),
    JSON.stringify({ version: 1, env: { FOO: CANARY } }),
    JSON.stringify({ version: 1, env: { FOO: { value: 5, secret: true } } }),
    JSON.stringify({ version: 1, env: { FOO: { secret: true } } }),
    JSON.stringify({ version: 1, env: { FOO: { value: CANARY + "\u0000" } } }),
    JSON.stringify({ version: 1, env: { FOO: null } }),
    `{"version":1,"env":{"FOO":{"value":"${CANARY}"},"FOO":{"value":"${CANARY2}"}}}`, // duplicate name
    `{"version":1,"env":{"F\\u004fO":{"value":"${CANARY}"},"FOO":{"value":"${CANARY2}"}}}`, // duplicate after decoding
  ];
  for (const c of bad) failsClosed(home(c), undefined, `schema ${c.slice(0, 40)}`);
});

// Name rules: the wrapper and parseAgentEnv (the editor/launch side) must agree on every name.
const NAMES = [
  "FOO", "GH_CONFIG_DIR", "_X", "A1", "GH_TOKEN", "A", "PATHX", "XPATH", "MY_HOME", "HCX", "HERDRX", "LDX", "PYTHO", "TERMINAL", "USERNAME", "SHELLY",
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TERM", "HC_X", "HC_TERMINAL_ID", "HERDR_X", "HERDR_ENV", "LD_X", "LD_PRELOAD", "DYLD_X", "DYLD_INSERT_LIBRARIES",
  "PYTHONPATH", "PYTHON", "PYTHONX",
  "foo", "Foo", "fOO", "1FOO", "9", "", "FOO-BAR", "FOO BAR", "FOO.BAR", "FOO=BAR", "FÖÖ", "FOO\n", "path", "hc_x",
];
test("name rules: wrapper and parseAgentEnv give identical verdicts", () => {
  for (const n of NAMES) {
    // GH_TOKEN alone is refused by the wrapper (see the test below), not by the name rules: pair it with its config dir.
    const text = file({ [n]: entry(), ...(n === "GH_TOKEN" ? { GH_CONFIG_DIR: entry("/some/dir") } : {}) });
    const js = !parseAgentEnv(text).error;
    const h = home(text);
    const r = run(h, ["bot", "--", "true"]);
    assert.ok(r.code === 0 || r.code === 1, JSON.stringify(n));
    assert.equal(r.code === 0, js, `name ${JSON.stringify(n)}: parseAgentEnv=${js} wrapper=${r.code}`);
    assert.ok(!r.out.includes(CANARY) && !r.err.includes(CANARY));
    rmSync(h.root, { recursive: true });
  }
  // sanity: the list covers both outcomes
  assert.ok(NAMES.some((n) => !parseAgentEnv(file({ [n]: entry() })).error));
  assert.ok(NAMES.some((n) => parseAgentEnv(file({ [n]: entry() })).error));
});

test("duplicate and size verdicts match parseAgentEnv too", () => {
  for (const text of [
    `{"version":1,"env":{"FOO":{"value":"a"},"FOO":{"value":"b"}}}`,
    file({ FOO: entry("z".repeat(9000)) }),
    file({ FOO: entry() }),
  ]) {
    const js = !parseAgentEnv(text).error;
    assert.equal(run(home(text), ["bot", "--", "true"]).code === 0, js);
  }
});

test("a deny-listed name can never override PATH or LD_PRELOAD in the child", () => {
  const h = home(file({ PATH: entry("/nowhere"), LD_PRELOAD: entry("/x.so") }));
  failsClosed(h, undefined, "deny");
});

test("default config dir is ~/.config/drover-herdr, found via HOME (override unset)", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentenv-home-"));
  mkdirSync(join(fakeHome, ".config", "drover-herdr", "agents"), { recursive: true, mode: 0o700 });
  chmodSync(join(fakeHome, ".config", "drover-herdr", "agents"), 0o700);
  const p = join(fakeHome, ".config", "drover-herdr", "agents", "bot.json");
  writeFileSync(p, file({ FOO: entry() })); chmodSync(p, 0o600);
  const r = spawnSync(WRAPPER, ["bot", "--", "sh", "-c", 'echo "$FOO"'], { env: { PATH: process.env.PATH, HOME: fakeHome }, encoding: "utf8" });
  assert.equal(r.stdout, CANARY + "\n");
  rmSync(fakeHome, { recursive: true });
});

test("the override gets the same dir checks; relative override is refused", () => {
  const h = home(file({ FOO: entry() }), { dirMode: 0o755 });
  failsClosed(h, undefined, "override dir mode");
  const r = spawnSync(WRAPPER, ["bot", "--", "true"], { env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: "relative/dir" }, encoding: "utf8" });
  assert.equal(r.status, 1);
});

test("fail closed: config dir (parent) that is group/world-writable, even non-sticky", () => {
  for (const m of [0o777, 0o770, 0o722, 0o702]) {
    const h = good();
    chmodSync(h.root, m);
    failsClosed(h, undefined, `parent mode ${m.toString(8)}`);
    chmodSync(h.root, 0o700);
  }
  const h = good();
  chmodSync(h.root, 0o755); // readable by others is fine, writable is not
  assert.equal(run(h).code, 0);
});

test("fail closed: config dir is a symlink", () => {
  const real = good();
  const link = join(mkdtempSync(join(tmpdir(), "agentenv-")), "cfg");
  symlinkSync(real.root, link);
  failsClosed({ root: link }, undefined, "symlinked config dir");
});

test("fail closed: a FIFO identity returns promptly with exit 1 (no hang)", () => {
  const h = home(undefined);
  execFileSync("mkfifo", ["-m", "600", h.path]);
  const r = spawnSync(WRAPPER, ["bot", "--", ...CHILD], { env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: h.root }, encoding: "utf8", timeout: 3000 });
  assert.equal(r.error, undefined, "wrapper hung on a FIFO");
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(MARK));
});

// Swap race: right after the wrapper touches `agents`, replace that entry with a symlink to a
// 0755 directory holding a valid file with another canary. The wrapper must keep using what it checked.
test("swap race: agents/ replaced after its check is not followed", () => {
  const h = good();
  const evil = mkdtempSync(join(tmpdir(), "agentenv-evil-"));
  writeFileSync(join(evil, "bot.json"), file({ FOO: entry(CANARY2) }));
  chmodSync(join(evil, "bot.json"), 0o600);
  const harness = `
import importlib.machinery, importlib.util, os, sys
dest, evil = sys.argv[1], sys.argv[2]
swapped = []
def swap():
    if swapped: return
    swapped.append(1)
    os.rename(dest, dest + ".orig")
    os.symlink(evil, dest)
def hook(real):
    def f(path, *a, **k):
        r = real(path, *a, **k)
        if os.fsdecode(path).rstrip("/").endswith("agents"): swap()
        return r
    return f
os.lstat = hook(os.lstat)
os.open = hook(os.open)
loader = importlib.machinery.SourceFileLoader("drover_env", ${JSON.stringify(WRAPPER)})
spec = importlib.util.spec_from_loader("drover_env", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
m.main(["drover-env", "bot", "--", "sh", "-c", 'echo "$FOO"'])
`;
  const r = spawnSync("python3", ["-I", "-c", harness, join(h.root, "agents"), evil], {
    env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: h.root }, encoding: "utf8", timeout: 5000,
  });
  assert.ok(!r.stdout.includes(CANARY2), "followed the swapped directory");
  assert.ok(!r.stderr.includes(CANARY) && !r.stderr.includes(CANARY2));
  assert.equal(r.stdout, CANARY + "\n"); // still the original, checked directory
});

test("fail closed: symlinked config dir spelled with a trailing slash, /. or /..", () => {
  const real = good();
  const parent = mkdtempSync(join(tmpdir(), "agentenv-"));
  const link = join(parent, "link");
  symlinkSync(real.root, link);
  for (const spelling of [link + "/", link + "//", link + "/.", link + "/./", real.root + "/.."]) {
    const r = spawnSync(WRAPPER, ["bot", "--", ...CHILD], { env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: spelling }, encoding: "utf8" });
    assert.equal(r.status, 1, `spelling ${spelling} (stderr: ${r.stderr})`);
    assert.ok(!r.stdout.includes(MARK) && !r.stdout.includes(CANARY) && !r.stderr.includes(CANARY));
  }
  // a plain trailing slash on a real directory is harmless
  const r = spawnSync(WRAPPER, ["bot", "--", "true"], { env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: real.root + "/" } });
  assert.equal(r.status, 0);
});

test("fail closed: GH_TOKEN without GH_CONFIG_DIR never starts the child (it would act as the person's gh login)", () => {
  failsClosed(home(file({ GH_TOKEN: entry() })), undefined, "token without config dir");
  failsClosed(home(file({ GH_TOKEN: entry(), FOO: entry("x") })), undefined, "token, other var");
  const ok = run(home(file({ GH_TOKEN: entry(), GH_CONFIG_DIR: entry("/some/dir") })));
  assert.equal(ok.code, 0);
  assert.equal(run(home(file({ GH_CONFIG_DIR: entry("/some/dir") }))).code, 0, "config dir alone is fine");
  const r = run(home(file({ GH_TOKEN: entry() })));
  assert.match(r.err, /GH_CONFIG_DIR/);
});
