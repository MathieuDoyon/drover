// The real `drover agents export|import` script against the real consumer (T-MWJHXZ6Q72Q). The CLI is a transport: no validation in the shell.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, statSync, symlinkSync, chmodSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

register("./hooks.js", import.meta.url);
const IO = await import("../_lib/io.js");
const HE = await import("../_lib/herd-export.js");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "../drover-tasks/bin/drover");
const CFG = "drover.agents";
const SONNET = "claude --model claude-sonnet-5-5 --effort medium";
const agent = (id, o = {}) => ({ id, name: id.toUpperCase(), command: SONNET, instructions: "", version: 1, ...o });
const base = () => ({ agents: [agent("wrangler", { soul: "wrangler" }), agent("scout", { soul: "scout" })], squads: [{ id: "drive", name: "drive", leader: "wrangler", members: [{ agent: "scout", role: "Scout" }], version: 1 }] });
const fileText = JSON.stringify({ format: HE.FORMAT, version: 1, exported: "2026-11-16T00:00:00.000Z", app: "t", agents: [{ id: "fresh", name: "FRESH", command: SONNET, instructions: "hi" }], squads: [] });

let home, inbox, host, work, responder;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "icli-home-"));
  work = mkdtempSync(join(tmpdir(), "icli-work-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(join(home, "mods/drover-agents/souls"), { recursive: true });
  for (const n of ["scout", "wrangler", "_herd"]) writeFileSync(join(home, `mods/drover-agents/souls/${n}.md`), n);
  host = globalThis.__host = { appHome: home, home: join(home, "h"), props: {}, notified: [], state: { [CFG]: base() }, agents: [], terminals: [], watchFolder: () => new Promise(() => {}), readTextFile: async () => null };
  host.exec = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { encoding: "utf8" }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
  responder = null;
});
afterEach(() => { if (responder) clearInterval(responder); });

// A consumer: the real drain, started on a timer like the mod does (every pass reads the inbox).
const startConsumer = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; responder = setInterval(() => IO.watchInbox(cx), 20); };
const cli = (args, env = {}) => new Promise((resolve) => execFile("bash", [CLI, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_AGENTS_WAIT: "10", ...env } }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
const put = (text) => { const p = join(work, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, text); return p; };
const tokenOf = (s) => /^token: ([0-9a-f]{64})$/m.exec(s)?.[1];

test("import: dry run prints the plan and a token and writes nothing; --confirm applies; a second confirm of the same plan is stale", async () => {
  startConsumer();
  const f = put(fileText);
  const d = await cli(["agents", "import", f]);
  assert.equal(d.code, 0, d.stderr + d.stdout);
  assert.match(d.stdout, /add agent fresh/);
  assert.equal(host.state[CFG].agents.length, 2);
  const c = await cli(["agents", "import", f, "--confirm", tokenOf(d.stdout)]);
  assert.equal(c.code, 0, c.stderr + c.stdout);
  assert.match(c.stdout, /^ok: applied 1/);
  assert.deepEqual(host.state[CFG].agents.map((a) => a.id), ["wrangler", "scout", "fresh"]);
  const again = await cli(["agents", "import", f, "--confirm", tokenOf(d.stdout)]);
  assert.notEqual(again.code, 0);
  assert.match(again.stdout, /^stale:/);
  assert.equal(host.state[CFG].agents.length, 3);
});

test("import: a changed file is stale, a bad file is an error from the consumer (the shell validates nothing)", async () => {
  startConsumer();
  const d = await cli(["agents", "import", put(fileText)]);
  const other = put(fileText.replace("hi", "changed"));
  const c = await cli(["agents", "import", other, "--confirm", tokenOf(d.stdout)]);
  assert.notEqual(c.code, 0);
  assert.match(c.stdout, /^stale:/);
  const bad = await cli(["agents", "import", put("{nope")]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stdout, /^error:/);
  assert.equal(host.state[CFG].agents.length, 2);
});

test("import: usage errors never reach the inbox", async () => {
  for (const args of [["agents"], ["agents", "import"], ["agents", "import", "/nope/missing.json"], ["agents", "import", put(fileText), "--confirm", "short"], ["agents", "import", put(fileText), "--copy"], ["agents", "bogus"]]) {
    const r = await cli(args);
    assert.notEqual(r.code, 0, args.join(" "));
  }
  assert.deepEqual(readdirSync(inbox), []);
});

test("an old consumer (protocol 3) is refused cleanly: the request is never sent", async () => {
  responder = setInterval(() => {
    for (const n of readdirSync(inbox).filter((x) => x.endsWith(".json"))) {
      const cmd = JSON.parse(readFileSync(join(inbox, n), "utf8"));
      unlinkSync(join(inbox, n));
      writeFileSync(join(inbox, n.replace(/\.json$/, ".result")), cmd.op === "protocol" ? "ok: protocol 3" : "error: Unknown drover command");
    }
  }, 5);
  for (const args of [["agents", "import", put(fileText)], ["agents", "export"]]) {
    const r = await cli(args, NO_NODE);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /too old.*protocol 4/s);
    assert.equal(r.stdout, "");
  }
  assert.deepEqual(readdirSync(inbox).filter((n) => n.endsWith(".json")), [], "only the probes were sent");
});

test("no mod open: import says queued and leaves the request in the inbox", async () => {
  const r = await cli(["agents", "import", put(fileText)], { DROVER_AGENTS_WAIT: "1" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^queued: no Drover/m);
  const ops = readdirSync(inbox).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(inbox, n), "utf8")).op).sort();
  assert.deepEqual(ops, ["agents-import", "protocol"]);
});

// ---- review 1
const NO_NODE = { DROVER_NODE: "/nonexistent/node", DROVER_AGENTS_WAIT: "1" };
const withShared = () => writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.agents": base() }));

test("headless export: no mod open, node reads shared.json through the core; same bytes of meaning as the consumer's export", async () => {
  withShared();
  const r = await cli(["agents", "export", "--agent", "scout"], { DROVER_AGENTS_WAIT: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^ok: exported 1 agent/);
  const viaNode = JSON.parse(r.stdout);
  assert.deepEqual(viaNode.agents.map((a) => a.id), ["scout"]);
  assert.match(viaNode.agents[0].soulHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(readdirSync(inbox), [], "nothing was sent to the inbox");
  startConsumer();
  const viaMod = JSON.parse((await cli(["agents", "export", "--agent", "scout"], NO_NODE)).stdout);
  assert.equal(viaNode.agents[0].soulHash, viaMod.agents[0].soulHash, "both paths hash the soul the same way");
  assert.deepEqual(viaNode.agents, viaMod.agents);
});

test("headless export: filters, a secret and a bad id are errors from the core", async () => {
  const GHP = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.agents": { ...base(), agents: [...base().agents, agent("leaky", { instructions: `k ${GHP}` })] } }));
  const leak = await cli(["agents", "export"], { DROVER_AGENTS_WAIT: "1" });
  assert.notEqual(leak.code, 0);
  assert.match(leak.stderr, /leaky/);
  assert.ok(!leak.stderr.includes(GHP) && !leak.stdout.includes(GHP));
  withShared();
  assert.notEqual((await cli(["agents", "export", "--squad", "nope"], { DROVER_AGENTS_WAIT: "1" })).code, 0);
});

test("no node and no mod: export refuses cleanly", async () => {
  const e = await cli(["agents", "export"], NO_NODE);
  assert.notEqual(e.code, 0);
  assert.match(e.stderr, /no Drover Tasks, Board or Wakeups mod is open/);
});

test("--out: a file created while the export waits is never overwritten; a symlink is refused; a good file is 0600", async () => {
  const out = join(work, "race.json");
  responder = setInterval(() => {
    for (const nm of readdirSync(inbox).filter((x) => x.endsWith(".json"))) {
      const cmd = JSON.parse(readFileSync(join(inbox, nm), "utf8"));
      unlinkSync(join(inbox, nm));
      if (cmd.op === "agents-export") { writeFileSync(out, "precious"); chmodSync(out, 0o644); }
      writeFileSync(join(inbox, nm.replace(/\.json$/, ".result")), cmd.op === "protocol" ? "ok: protocol 4" : `ok: exported 0 agents, 0 squads\n---\n{"a":1}`);
    }
  }, 5);
  const r = await cli(["agents", "export", "--out", out], NO_NODE);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /exists/);
  assert.equal(readFileSync(out, "utf8"), "precious");
  assert.equal(statSync(out).mode & 0o777, 0o644, "untouched");
  clearInterval(responder); responder = null;
  const target = join(work, "target.json");
  const link = join(work, "link.json");
  symlinkSync(target, link);
  startConsumer();
  const l = await cli(["agents", "export", "--out", link], NO_NODE);
  assert.notEqual(l.code, 0);
  assert.ok(!existsSync(target), "the symlink was not followed");
  const ok = join(work, "good.json");
  assert.equal((await cli(["agents", "export", "--out", ok], NO_NODE)).code, 0);
  assert.equal(statSync(ok).mode & 0o777, 0o600);
});

test("export: JSON on stdout, the header on stderr; filters travel to the consumer", async () => {
  startConsumer();
  const r = await cli(["agents", "export", "--agent", "scout"], NO_NODE);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^ok: exported 1 agent, 0 squads/);
  assert.deepEqual(JSON.parse(r.stdout).agents.map((a) => a.id), ["scout"]);
  const s = await cli(["agents", "export", "--squad", "drive"], NO_NODE);
  assert.deepEqual(JSON.parse(s.stdout).agents.map((a) => a.id).sort(), ["scout", "wrangler"]);
  const bad = await cli(["agents", "export", "--agent", "nope"], NO_NODE);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /^error: .*nope/);
});

test("export --out writes a private new file and refuses to overwrite", async () => {
  startConsumer();
  const out = join(work, "herd.json");
  const r = await cli(["agents", "export", "--out", out], NO_NODE);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).format, HE.FORMAT);
  assert.equal(statSync(out).mode & 0o077, 0, "owner only");
  assert.equal(r.stdout, "");
  const again = await cli(["agents", "export", "--out", out], NO_NODE);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /exists/);
  assert.ok(existsSync(out));
});

test("a node that cannot load the core (exit 3) falls back to an open mod; any other node failure is final", async () => {
  const fake = (code) => { const f = join(work, `node-${code}`); writeFileSync(f, `#!/bin/sh\necho "error: fake"\nexit ${code}\n`); chmodSync(f, 0o755); return f; };
  startConsumer();
  const viaMod = await cli(["agents", "export", "--agent", "scout"], { DROVER_NODE: fake(3) });
  assert.equal(viaMod.code, 0, viaMod.stderr);
  assert.deepEqual(JSON.parse(viaMod.stdout).agents.map((a) => a.id), ["scout"]);
  const final = await cli(["agents", "export"], { DROVER_NODE: fake(1) });
  assert.notEqual(final.code, 0);
  assert.match(final.stderr, /^error: fake/);
});

test("headless export through a symlink installed elsewhere (the box1 ~/.local/bin/drover layout)", async () => {
  withShared();
  const bin = mkdtempSync(join(tmpdir(), "icli-bin-"));
  const link = join(bin, "drover");
  symlinkSync(CLI, link);
  const chain = join(bin, "drover2"); // a link to a link, relative target
  symlinkSync("drover", chain);
  for (const l of [link, chain]) {
    const r = await new Promise((resolve) => execFile("bash", [l, "agents", "export", "--agent", "scout"], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_AGENTS_WAIT: "1" } }, (e, stdout, stderr) => resolve({ code: e ? 1 : 0, stdout, stderr })));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).agents.map((a) => a.id), ["scout"]);
  }
  assert.deepEqual(readdirSync(inbox), [], "node answered, no mod needed");
});

test("headless export: the user's real home (HOME, not --home) becomes ~, and the local-path warnings are printed", async () => {
  const H = mkdtempSync(join(tmpdir(), "icli-realhome-"));
  const cfg = base();
  cfg.agents[0].command = `${SONNET} --add-dir ${H}/notes`;
  cfg.agents[0].instructions = `read ${H}/docs/a.md`;
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.agents": cfg }));
  const r = await cli(["agents", "export", "--agent", "wrangler"], { DROVER_AGENTS_WAIT: "1", HOME: H });
  assert.equal(r.code, 0, r.stderr);
  const a = JSON.parse(r.stdout).agents[0];
  assert.equal(a.command, `${SONNET} --add-dir ~/notes`);
  assert.equal(a.instructions, "read ~/docs/a.md");
  assert.ok(!r.stdout.includes(H) && !r.stderr.includes(H));
  assert.match(r.stderr, /warning: wrangler · command · local-path/);
  assert.match(r.stderr, /warning: wrangler · instructions · local-path/);
});

test("export through the consumer (no node): same ~ rewrite and warnings", async () => {
  const cfg = base();
  cfg.agents[0].command = `${SONNET} --add-dir ${host.home}/notes`;
  host.state[CFG] = cfg;
  startConsumer();
  const r = await cli(["agents", "export", "--agent", "wrangler"], NO_NODE);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).agents[0].command, `${SONNET} --add-dir ~/notes`);
  assert.match(r.stderr, /warning: wrangler · command · local-path/);
});

// #70 raised PROTOCOL to 5. Every gate is a minimum: an install on 4 (box1) keeps working, and so does 5.
test("agents export passes the protocol gate at 4 and at 5 (a minimum, not an equality)", async () => {
  for (const level of [4, 5]) {
    responder = setInterval(() => {
      for (const nm of readdirSync(inbox).filter((x) => x.endsWith(".json"))) {
        const cmd = JSON.parse(readFileSync(join(inbox, nm), "utf8"));
        unlinkSync(join(inbox, nm));
        writeFileSync(join(inbox, nm.replace(/\.json$/, ".result")), cmd.op === "protocol" ? `ok: protocol ${level}` : `ok: exported 0 agents, 0 squads\n---\n{"a":1}`);
      }
    }, 5);
    const r = await cli(["agents", "export"], NO_NODE);
    assert.equal(r.code, 0, `protocol ${level}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '{"a":1}');
    clearInterval(responder); responder = null;
  }
});

// ---- T-MWKX53UF8OI: a machine with no saved agents exports the default herd, like the mod does
const RUNS = await import("../_lib/runs.js");
const DEF_IDS = { agents: RUNS.DEFAULT_AGENTS.map((a) => a.id), squads: RUNS.DEFAULT_SQUADS.map((q) => q.id) };
for (const [label, shared] of [
  ["no shared.json", null],
  ["no drover.agents key", { "drover.tasks": [] }],
  ["null config", { "drover.agents": null }],
  ["agents not an array", { "drover.agents": { agents: "x", squads: [] } }],
  ["squads not an array", { "drover.agents": { agents: [], squads: {} } }],
]) {
  test(`headless export, ${label}: the default herd, nothing sent to the inbox`, async () => {
    if (shared) writeFileSync(join(home, "shared.json"), JSON.stringify(shared));
    for (const n of ["_herd", ...RUNS.DEFAULT_AGENTS.map((a) => a.soul).filter(Boolean)]) writeFileSync(join(home, `mods/drover-agents/souls/${n}.md`), n);
    const r = await cli(["agents", "export"], { DROVER_AGENTS_WAIT: "1" });
    assert.equal(r.code, 0, r.stderr);
    const f = JSON.parse(r.stdout);
    assert.deepEqual(f.agents.map((a) => a.id), DEF_IDS.agents);
    assert.deepEqual(f.squads.map((q) => q.id), DEF_IDS.squads);
    assert.deepEqual(readdirSync(inbox), []);
  });
}

test("headless export: an intentionally empty saved herd stays empty; a corrupt shared.json is an error, not the defaults", async () => {
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.agents": { agents: [], squads: [] } }));
  const empty = await cli(["agents", "export"], { DROVER_AGENTS_WAIT: "1" });
  assert.notEqual(empty.code, 0, "the core refuses an empty herd; the defaults do not replace it");
  assert.match(empty.stderr, /^error:/);
  assert.ok(!empty.stderr.includes("trail-boss") && !empty.stdout.includes("trail-boss"));
  writeFileSync(join(home, "shared.json"), "{not json");
  const bad = await cli(["agents", "export"], { DROVER_AGENTS_WAIT: "1" });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /^error: cannot read shared\.json/);
  assert.equal(bad.stdout.trim(), "");
});

test("headless export, no saved agents: same herd as the consumer's export (parity)", async () => {
  for (const n of ["_herd", ...RUNS.DEFAULT_AGENTS.map((a) => a.soul).filter(Boolean)]) writeFileSync(join(home, `mods/drover-agents/souls/${n}.md`), n);
  const viaNode = JSON.parse((await cli(["agents", "export"], { DROVER_AGENTS_WAIT: "1" })).stdout);
  delete host.state[CFG];
  startConsumer();
  const viaMod = JSON.parse((await cli(["agents", "export"], NO_NODE)).stdout);
  assert.deepEqual(viaNode.agents, viaMod.agents);
  assert.deepEqual(viaNode.squads, viaMod.squads);
});

test("no node: the export through the mod says the headless route was skipped (stderr only; stdout stays the file)", async () => {
  startConsumer();
  const r = await cli(["agents", "export", "--agent", "scout"], NO_NODE);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^ok: exported 1 agent[^\n]*\n(.*\n)*note: node not found \(\/nonexistent\/node\)/);
  assert.deepEqual(JSON.parse(r.stdout).agents.map((a) => a.id), ["scout"]);
  const fake = join(work, "node-3"); writeFileSync(fake, "#!/bin/sh\nexit 3\n"); chmodSync(fake, 0o755);
  const r3 = await cli(["agents", "export", "--agent", "scout"], { DROVER_NODE: fake });
  assert.match(r3.stderr, /note: this node cannot load the export core/);
  const ok = await cli(["agents", "export", "--agent", "scout"], { DROVER_AGENTS_WAIT: "1" });
  assert.doesNotMatch(ok.stderr, /note:/);
});
