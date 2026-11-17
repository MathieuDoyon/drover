// Inbox protocol 4 (T-MWJHXZ6Q72Q): agents-import (dry run + plan token + --confirm) and agents-export. The consumer is the only place that
// validates and applies (herd-export.js); the CLI is a transport. The consumer path runs for real; waits use until(), never a sleep.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const S = await import("../_lib/store.js");
const HE = await import("../_lib/herd-export.js");
const CFG = "drover.agents", NONCES = "drover.agents-import-seen";

const SONNET = "claude --model claude-sonnet-5-5 --effort medium";
const agent = (id, o = {}) => ({ id, name: id.toUpperCase(), command: SONNET, instructions: "", version: 1, ...o });
const fa = (id, o = {}) => ({ id, name: id.toUpperCase(), command: SONNET, instructions: "", ...o });
const file = (agents, squads = []) => JSON.stringify({ format: HE.FORMAT, version: 1, exported: "2026-11-16T00:00:00.000Z", app: "t", agents, squads });
const base = () => ({
  agents: [agent("wrangler", { soul: "wrangler", instructions: "code" }), agent("scout", { soul: "scout" })],
  squads: [{ id: "drive", name: "drive", leader: "wrangler", members: [{ agent: "scout", role: "Scout" }], version: 1 }],
});
const FRESH = file([fa("fresh")], [{ id: "crew", name: "crew", leader: "fresh", members: [{ agent: "scout", role: "Scout" }] }]);
const GHP = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const CANARY = "canary-env-value-7f3a9c";

let home, inbox, host, sets, envFiles, envFail, envReads;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "iagents-home-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(join(home, "mods/drover-agents/souls"), { recursive: true });
  for (const [n, t] of [["scout", "scout soul"], ["wrangler", "wrangler soul"], ["_herd", "herd rules"]]) writeFileSync(join(home, `mods/drover-agents/souls/${n}.md`), t);
  sets = []; envFiles = new Map(); envFail = false; envReads = 0;
  const state = new Proxy({}, { set(o, k, v) { sets.push(k); o[k] = v; return true; } });
  host = globalThis.__host = { appHome: home, home: join(home, "h"), props: {}, notified: [], state, agents: [], terminals: [], watchFolder: () => new Promise(() => {}) };
  host.readTextFile = async (p) => { envReads++; if (envFail) throw Object.assign(new Error("boom"), { code: "EIO" }); return envFiles.has(p) ? envFiles.get(p) : null; };
  host.exec = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { encoding: "utf8" }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
  host.state[CFG] = base();
  sets.length = 0;
});

const startLoop = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; IO.watchInbox(cx); };
const answer = (name) => until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `the inbox answered ${name}`);
let n = 0;
const send = async (cmd) => { const name = `${Math.floor(Date.now() / 1000)}-${++n}`; writeFileSync(join(inbox, `${name}.json`), JSON.stringify(cmd)); startLoop(); return answer(name); };
let nonce = 0;
const dry = (text, extra = {}) => send({ op: "agents-import", file: text, ...extra });
const confirm = (text, token, extra = {}) => send({ op: "agents-import", file: text, token, confirm: true, nonce: `nonce-${++nonce}-abcdef`, expiresAt: Date.now() + 3600000, ...extra });
const tokenOf = (reply) => /^token: ([0-9a-f]{64})$/m.exec(reply)?.[1];
const cfg = () => host.state[CFG];
const snap = () => JSON.stringify(cfg());

test("probe answers ok: protocol 4", async () => {
  assert.equal(S.PROTOCOL, 4);
  assert.equal(await send({ op: "protocol" }), "ok: protocol 4");
});

test("dry run writes nothing and returns the plan text and a token", async () => {
  const before = snap();
  const r = await dry(FRESH);
  assert.match(r, /^ok: dry run/, r);
  assert.match(r, /add agent fresh/);
  assert.match(r, /add squad crew/);
  assert.ok(tokenOf(r), r);
  assert.equal(snap(), before);
  assert.deepEqual(sets.filter((k) => k !== "drover.inbox-seen"), [], "no shared key but the seen list was written");
  assert.equal(host.state[NONCES], undefined);
});

test("--confirm with the token applies in ONE setShared and the clash keeps mine", async () => {
  const f = file([fa("fresh"), fa("wrangler", { instructions: "other" })], [{ id: "crew", name: "crew", leader: "fresh", members: [] }]);
  const d = await dry(f);
  assert.match(d, /keep agent wrangler/);
  const r = await confirm(f, tokenOf(d));
  assert.match(r, /^ok: applied 2/, r);
  assert.deepEqual(sets.filter((k) => k === CFG), [CFG], "one write of drover.agents");
  assert.deepEqual(cfg().agents.map((a) => a.id), ["wrangler", "scout", "fresh"]);
  assert.equal(cfg().agents.find((a) => a.id === "wrangler").instructions, "code", "mine kept");
  assert.equal(cfg().agents.find((a) => a.id === "fresh").version, 1);
  assert.ok(cfg().squads.some((q) => q.id === "crew"));
  assert.equal(cfg().squads.find((q) => q.id === "drive").version, 1, "unrelated items untouched");
});

test("stale: the destination drifted between the dry run and the confirm", async () => {
  const d = await dry(FRESH);
  host.state[CFG] = { ...cfg(), agents: [...cfg().agents, agent("late")] };
  const drifted = snap();
  const r = await confirm(FRESH, tokenOf(d));
  assert.match(r, /^stale:/, r);
  assert.equal(snap(), drifted);
  assert.equal(host.state[NONCES], undefined, "a refused confirm does not burn its nonce");
});

test("stale: the file changed between the dry run and the confirm", async () => {
  const d = await dry(FRESH);
  const before = snap();
  const r = await confirm(file([fa("fresh", { instructions: "changed" })]), tokenOf(d));
  assert.match(r, /^stale:/, r);
  assert.equal(snap(), before);
});

test("a wrong or missing token never applies", async () => {
  const before = snap();
  assert.match(await confirm(FRESH, "0".repeat(64)), /^stale:/);
  assert.match(await confirm(FRESH, undefined), /^error:/);
  assert.match(await confirm(FRESH, 42), /^error:/);
  assert.equal(snap(), before);
});

test("a duplicate nonce answers already applied and writes nothing, also after the config changed", async () => {
  const d = await dry(FRESH);
  const tok = tokenOf(d);
  const first = await confirm(FRESH, tok, { nonce: "nonce-dup-abcdef" });
  assert.match(first, /^ok: applied/, first);
  assert.ok(host.state[NONCES].some((e) => e.n === "nonce-dup-abcdef"), "the nonce is persisted in shared state");
  // The person removes the agent again; a re-delivered request (a restarted consumer, the same shared state) must not add it back.
  host.state[CFG] = base();
  // A real restart: the state is reloaded from what was stored (a JSON round trip) and the consumer module is a fresh instance.
  const stored = JSON.parse(JSON.stringify({ ...host.state }));
  host.state = new Proxy(stored, { set(o, k, v) { sets.push(k); o[k] = v; return true; } });
  const fresh = await import("../_lib/io.js?restart=1");
  const after = snap();
  const name = `${Math.floor(Date.now() / 1000)}-${++n}`;
  writeFileSync(join(inbox, `${name}.json`), JSON.stringify({ op: "agents-import", file: FRESH, token: tok, confirm: true, nonce: "nonce-dup-abcdef", expiresAt: Date.now() + 3600000 }));
  const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
  fresh.watchInbox(cx);
  const again = await answer(name);
  assert.match(again, /already applied/, again);
  assert.equal(snap(), after);
});

test("copy, overwrite and acknowledgements are refused from the CLI", async () => {
  const f = file([fa("wrangler", { instructions: "other" })]);
  const before = snap();
  for (const choices of [{ "agent:wrangler": { action: "overwrite" } }, { "agent:wrangler": { action: "copy" } }, { "agent:wrangler": { action: "keep", ackEnv: true } }, { "agent:wrangler": { action: "keep", ackSoul: true } }]) {
    assert.match(await dry(f, { choices }), /^error: .*(UI|not available)/, JSON.stringify(choices));
    assert.match(await confirm(f, "0".repeat(64), { choices }), /^error:/);
  }
  assert.equal(snap(), before);
});

test("an env-file check failure stops the dry run and the apply (never read as absent)", async () => {
  const d = await dry(FRESH);
  envFail = true;
  const before = snap();
  assert.match(await dry(FRESH), /^error: .*environment/i);
  assert.match(await confirm(FRESH, tokenOf(d)), /^error: .*environment/i);
  assert.equal(snap(), before);
  assert.equal(host.state[NONCES], undefined);
});

test("an orphan env file for a new id blocks that row; the rest still applies", async () => {
  envFiles.set(`${host.home}/.config/drover-herdr/agents/fresh.json`, `{"A":"${CANARY}"}`);
  const f = file([fa("fresh"), fa("other")]);
  const d = await dry(f);
  assert.match(d, /blocked agent fresh/);
  assert.ok(!d.includes(CANARY));
  const r = await confirm(f, tokenOf(d));
  assert.match(r, /^ok: applied 1/, r);
  assert.deepEqual(cfg().agents.map((a) => a.id), ["wrangler", "scout", "other"]);
});

test("a soul that is not installed holds the row for the UI; the result says so", async () => {
  const f = file([fa("ghosty", { soul: "ghost", soulHash: "1".repeat(64) }), fa("plain")]);
  const d = await dry(f);
  assert.match(d, /held agent ghosty/);
  const r = await confirm(f, tokenOf(d));
  assert.match(r, /^ok: applied 1/, r);
  assert.match(r, /held agent ghosty/);
  assert.deepEqual(cfg().agents.map((a) => a.id), ["wrangler", "scout", "plain"]);
});

test("a bad file is an error: nothing is written, no token", async () => {
  const before = snap();
  for (const text of ["{nope", "[]", JSON.stringify({ format: "other", version: 1 }), 42, undefined]) {
    const r = await dry(text);
    assert.match(r, /^error:/, r);
    assert.equal(tokenOf(r), undefined);
  }
  assert.equal(snap(), before);
});

test("a secret in the file blocks the row and is never echoed", async () => {
  const d = await dry(file([fa("leaky", { instructions: `use ${GHP}` }), fa("fine")]));
  assert.match(d, /blocked agent leaky/);
  assert.ok(!d.includes(GHP));
});

// ---- agents-export
const body = (r) => JSON.parse(r.slice(r.indexOf("\n---\n") + 5));

test("agents-export returns the whole herd as the file text, no env values", async () => {
  envFiles.set(`${host.home}/.config/drover-herdr/agents/scout.json`, `{"GH_TOKEN":"${CANARY}"}`);
  const r = await send({ op: "agents-export" });
  assert.match(r, /^ok: exported 2 agents, 1 squad/, r);
  assert.ok(!r.includes(CANARY));
  const d = body(r);
  assert.equal(d.format, HE.FORMAT);
  assert.deepEqual(d.agents.map((a) => a.id), ["wrangler", "scout"]);
  assert.match(d.agents[0].soulHash, /^[0-9a-f]{64}$/);
  assert.equal(snap(), JSON.stringify(base()), "read only");
});

test("agents-export filters by agent and by squad (a squad brings its agents)", async () => {
  assert.deepEqual(body(await send({ op: "agents-export", agents: ["scout"] })).agents.map((a) => a.id), ["scout"]);
  const d = body(await send({ op: "agents-export", squads: ["drive"] }));
  assert.deepEqual(d.agents.map((a) => a.id).sort(), ["scout", "wrangler"]);
  assert.deepEqual(d.squads.map((q) => q.id), ["drive"]);
  assert.match(await send({ op: "agents-export", agents: ["nope"] }), /^error: .*nope/);
  assert.match(await send({ op: "agents-export", agents: "scout" }), /^error:/);
});

test("agents-export: a secret blocks it and names the rule, not the value", async () => {
  host.state[CFG] = { ...cfg(), agents: [...cfg().agents, agent("leaky", { instructions: `key ${GHP}` })] };
  const r = await send({ op: "agents-export" });
  assert.match(r, /^error: [\s\S]*leaky/, r);
  assert.ok(!r.includes(GHP));
});

test("a round trip: export on one machine, import on an empty one", async () => {
  const exported = body(await send({ op: "agents-export" }));
  host.state[CFG] = { agents: [], squads: [] };
  const text = JSON.stringify(exported);
  const d = await dry(text);
  const r = await confirm(text, tokenOf(d));
  assert.match(r, /^ok: applied 3/, r);
  assert.deepEqual(cfg().agents.map((a) => a.id), ["wrangler", "scout"]);
  await drain();
});

// ---- review 1 (T-MWJHXZ6Q72Q)
test("no echo: an unscanned soul name or a pre-validation id never reaches a result", async () => {
  const soul = await dry(file([fa("a1", { soul: GHP })]));
  assert.ok(!soul.includes(GHP), "soul name echoed");
  assert.match(soul, /^ok: dry run/);
  envFail = true;
  const id = await dry(file([fa(GHP)]));
  assert.ok(!id.includes(GHP), "id echoed by the env error");
  assert.match(id, /^error:/);
  const unk = await dry(file([fa("z1", { command: `${GHP.toLowerCase()}-tool --x` })]));
  assert.ok(!unk.toLowerCase().includes(GHP.toLowerCase()), "program name echoed");
});

test("the dry run prints the full command and instructions of every non-blocked agent row, and nothing of a blocked one", async () => {
  const cmd = "claude --model claude-sonnet-5-5 --flag-marker-xyz", ins = "do the instruction-marker-abc thing\nsecond line";
  const d = await dry(file([fa("shown", { command: cmd, instructions: ins }), fa("leaky", { instructions: `use ${GHP}` })]));
  assert.ok(d.includes(cmd), d);
  assert.ok(d.includes("instruction-marker-abc"));
  assert.ok(d.includes("second line"));
  assert.ok(!d.includes(GHP));
});

test("the token binds the reviewed rows: a held row turned into an add by a new local soul is stale", async () => {
  const f = file([fa("ghosty", { soul: "newlocal", soulHash: "1".repeat(64) })]);
  const d = await dry(f);
  assert.match(d, /held agent ghosty/);
  writeFileSync(join(home, "mods/drover-agents/souls/newlocal.md"), "now installed");
  const r = await confirm(f, tokenOf(d));
  assert.match(r, /^stale:/, r);
  assert.deepEqual(cfg().agents.map((a) => a.id), ["wrangler", "scout"]);
});

test("the token binds the reviewed rows: a blocked orphan env row turned into an add is stale", async () => {
  const p = `${host.home}/.config/drover-herdr/agents/fresh.json`;
  envFiles.set(p, "{}");
  const f = file([fa("fresh")]);
  const d = await dry(f);
  assert.match(d, /blocked agent fresh/);
  envFiles.delete(p);
  assert.match(await confirm(f, tokenOf(d)), /^stale:/);
  assert.equal(cfg().agents.length, 2);
});

test("export never opens an environment file, and an unreadable one does not stop it", async () => {
  envFail = true;
  const r = await send({ op: "agents-export" });
  assert.match(r, /^ok: exported/, r);
  assert.equal(envReads, 0);
});

test("a confirm must carry an absolute expiry, at most a day ahead; after it nothing applies, however the file arrived", async () => {
  const d = await dry(FRESH);
  const tok = tokenOf(d);
  assert.match(await confirm(FRESH, tok, { expiresAt: undefined }), /^error: .*expiresAt/i);
  assert.match(await confirm(FRESH, tok, { expiresAt: "soon" }), /^error: .*expiresAt/i);
  assert.match(await confirm(FRESH, tok, { expiresAt: Date.now() + 86400000 + 3600000 }), /^error: .*expiresAt/i);
  assert.match(await confirm(FRESH, tok, { expiresAt: Date.now() - 1 }), /^error: expired/);
  assert.equal(cfg().agents.length, 2);
});

test("an out-of-range, negative, NaN, float or huge expiresAt is a fixed error, never a throw; the request is still answered once", async () => {
  const d = await dry(FRESH);
  const tok = tokenOf(d);
  for (const v of [-8640000000000001, -9007199254740991, -1, 0, 8.64e15 + 1, 1e300, 1.5, null, "NaN", [], {}, true]) {
    const r = await confirm(FRESH, tok, { expiresAt: v });
    assert.match(r, /^error: (expired|a confirm needs expiresAt)/, `${JSON.stringify(v)}: ${r}`);
    assert.ok(!/RangeError|Invalid time/.test(r));
  }
  assert.equal(cfg().agents.length, 2);
  assert.match(await confirm(FRESH, tok), /^ok: applied 2/, "the consumer is still alive and a good confirm applies");
});

// A controlled clock: Date.now moves forward; the consumer reads it for the expiry and the receipts.
const realNow = Date.now;
const advance = (ms) => { const base = Date.now(); Date.now = () => base + ms; };
afterEach(() => { Date.now = realNow; });

test("an applied request redelivered as a NEW file after its receipt was pruned is expired, not applied", async () => {
  const d = await dry(FRESH);
  const tok = tokenOf(d);
  const payload = { op: "agents-import", file: FRESH, token: tok, confirm: true, nonce: "nonce-redeliver-abcdef", expiresAt: Date.now() + 3600000 };
  assert.match(await send(payload), /^ok: applied 2/);
  host.state[CFG] = base(); // back to the reviewed destination
  advance(3 * 86400000);
  assert.match(await dry(FRESH), /^ok: dry run/); // time passes
  const d2 = await dry(file([fa("other")]));
  assert.match(await confirm(file([fa("other")]), tokenOf(d2)), /^ok: applied 1/); // this apply prunes the old receipt
  assert.ok(!host.state[NONCES].some((e) => e.n === "nonce-redeliver-abcdef"), "the receipt is gone");
  host.state[CFG] = base();
  const again = await send(payload);
  assert.match(again, /^error: expired/, again);
  assert.deepEqual(cfg().agents.map((a) => a.id), ["wrangler", "scout"]);
});

test("receipts are never evicted by count, and expired ones neither count nor block", async () => {
  host.state[NONCES] = Array.from({ length: 300 }, (_, i) => ({ n: `old-nonce-${String(i).padStart(4, "0")}`, exp: Date.now() + 1800000 }));
  const d = await dry(FRESH);
  assert.match(await confirm(FRESH, tokenOf(d)), /^ok: applied/);
  assert.equal(host.state[NONCES].length, 301);
  assert.equal(host.state[NONCES][0].n, "old-nonce-0000");
});

test("20000 expired receipts do not disable confirms: they are pruned before the capacity check", async () => {
  host.state[NONCES] = Array.from({ length: 20000 }, (_, i) => ({ n: `dead-nonce-${i}-abc`, exp: Date.now() - 3 * 86400000 }));
  const d = await dry(FRESH);
  assert.match(await confirm(FRESH, tokenOf(d)), /^ok: applied 2/);
  assert.equal(host.state[NONCES].length, 1);
  host.state[NONCES] = Array.from({ length: 20000 }, (_, i) => ({ n: `live-nonce-${i}-abc`, exp: Date.now() + 1800000 }));
  const d2 = await dry(file([fa("more")]));
  assert.match(await confirm(file([fa("more")]), tokenOf(d2)), /^error: too many/, "live receipts still cap");
});

// ---- job 6: the exporter's home becomes ~ on every export path; the import path knows the receiver's home

test("agents-export: the host home becomes ~ in command and instructions, and the local-path warning is in the header", async () => {
  cfg().agents[0].command = `${SONNET} --add-dir ${host.home}/notes`;
  cfg().agents[0].instructions = `read ${host.home}/docs/a.md`;
  const r = await send({ op: "agents-export" });
  assert.match(r, /^ok: exported 2 agents/, r);
  const d = body(r);
  assert.equal(d.agents[0].command, `${SONNET} --add-dir ~/notes`);
  assert.equal(d.agents[0].instructions, "read ~/docs/a.md");
  assert.ok(!r.slice(0, r.indexOf("\n---\n")).includes(host.home), "the header names no home");
  assert.match(r, /^warning: wrangler · command · local-path$/m);
  assert.match(r, /^warning: wrangler · instructions · local-path$/m);
});

test("agents-import through the inbox: a ~/ command is stored with this machine's home", async () => {
  const f = file([fa("fresh", { command: "~/bin/claude --add-dir ~/n" })]);
  const d = await dry(f);
  assert.match(d, /^ok: dry run/, d);
  const r = await confirm(f, tokenOf(d));
  assert.match(r, /^ok: applied/, r);
  assert.equal(cfg().agents.find((a) => a.id === "fresh").command, `${host.home}/bin/claude --add-dir ${host.home}/n`);
});
