import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256, stableJson, scanSecrets, homePath, scanItems, exportHerd, plan, apply, FORMAT, MAX_BYTES } from "./herd-export.js";

// Secret-shaped fixtures are built from parts so this file never trips the public-sync leak scan.
const GHP = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const PAT = "github" + "_pat_" + "11ABCDEFG0abcdefghij_klmnopqrstuvwxyz0123456789";
const ANT = "sk-" + "ant-" + "api03-abcdefghijklmnop";
const PEM = "-----BEGIN RSA PRIVATE" + " KEY-----";
const AKIA = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
const BEARER = "Bear" + "er " + "abcdefghijklmnopqrstuvwx1234";
const HOME = "/Us" + "ers/alice/projects/x";
const CANARY = "canary-env-value-7f3a9c";

const H1 = "1".repeat(64), H2 = "2".repeat(64);
const SONNET = "claude --model claude-sonnet-5-5 --effort medium";
const agent = (id, o = {}) => ({ id, name: id.toUpperCase(), command: SONNET, instructions: "", version: 1, ...o });
const squad = (id, leader, members = [], o = {}) => ({ id, name: id, leader, members, version: 1, ...o });
const cfg0 = () => ({
  agents: [agent("scout", { soul: "scout", instructions: "look" }), agent("wrangler", { soul: "wrangler" })],
  squads: [squad("drive", "wrangler", [{ agent: "scout", role: "Scout" }])],
});
const ctxOf = (o = {}) => ({ localSouls: { scout: H1, wrangler: H1 }, envIds: new Set(), supported: 1, ...o });
const file = (agents = [], squads = [], extra = {}) =>
  JSON.stringify({ format: FORMAT, version: 1, exported: "2026-11-16T00:00:00.000Z", app: "t", agents, squads, ...extra });
const fa = (id, o = {}) => ({ id, name: id.toUpperCase(), command: SONNET, instructions: "", ...o });
const row = (p, key) => p.rows.find((r) => r.key === key);

// ---- sha-256 (pure, no node:crypto in the module)

test("sha256: known vectors", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  assert.equal(sha256("a".repeat(1000000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("sha256: matches node:crypto on lengths around the block edge and on unicode", () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) assert.equal(sha256("x".repeat(n)), createHash("sha256").update("x".repeat(n)).digest("hex"), `len ${n}`);
  for (const s of ["é", "日本語", "a😀b", "\u0000\u0001", "\ud800 lone"]) assert.equal(sha256(s), createHash("sha256").update(s).digest("hex"), s);
});

test("stableJson: key order does not matter, arrays keep order", () => {
  assert.equal(stableJson({ b: 1, a: { d: [2, 1], c: 3 } }), stableJson({ a: { c: 3, d: [2, 1] }, b: 1 }));
  assert.notEqual(stableJson([1, 2]), stableJson([2, 1]));
});

// ---- secret scan: each rule positive and negative

const rules = (s) => scanSecrets(s);
test("scanSecrets: github token", () => {
  assert.deepEqual(rules(`use ${GHP} here`), ["github-token"]);
  assert.deepEqual(rules("tokens start with the ghp prefix"), []);
});
test("scanSecrets: github fine-grained token", () => {
  assert.deepEqual(rules(PAT), ["github-pat"]);
  assert.deepEqual(rules("a fine-grained personal access token"), []);
});
test("scanSecrets: anthropic key", () => {
  assert.deepEqual(rules(`key ${ANT}`), ["anthropic-key"]);
  assert.deepEqual(rules("the anthropic key goes in the env file"), []);
});
test("scanSecrets: private key header", () => {
  assert.deepEqual(rules(`${PEM}\nMIIE`), ["private-key"]);
  assert.deepEqual(rules("never paste a private key"), []);
});
test("scanSecrets: key/token/secret assignment", () => {
  assert.deepEqual(rules("GH_" + "TOKEN=abc123"), ["secret-assignment"]);
  assert.deepEqual(rules("export STRIPE_API" + "_KEY = sk_live"), ["secret-assignment"]);
  assert.deepEqual(rules("set your GH_" + "TOKEN in the env file"), []);
  assert.deepEqual(rules("GH_" + "TOKEN="), []);
  assert.deepEqual(rules("the token is read from the environment"), []);
});
test("scanSecrets: aws access key id", () => {
  assert.deepEqual(rules(`id ${AKIA}`), ["aws-key"]);
  assert.deepEqual(rules("AKIA is the prefix of an access key id"), []);
});
test("scanSecrets: bearer credential", () => {
  assert.deepEqual(rules(`Authorization: ${BEARER}`), ["bearer-token"]);
  assert.deepEqual(rules("send a Bearer token in the header"), []);
  assert.deepEqual(rules("Bearer short"), []);
});
test("scanSecrets: secret flags", () => {
  assert.deepEqual(rules("tool --api-key abcd1234efgh5678"), ["secret-flag"]);
  assert.deepEqual(rules("tool --token=abcd1234efgh5678"), ["secret-flag"]);
  assert.deepEqual(rules("tool --password hunter2hunter2"), ["secret-flag"]);
  assert.deepEqual(rules("tool --token $GH_TOKEN"), []);
  assert.deepEqual(rules("pass --token <value>"), []);
  assert.deepEqual(rules("the --token flag is required"), []);
});
test("scanSecrets: a sentence mentioning token, key, password and secret is clean; non-strings are clean", () => {
  assert.deepEqual(rules("Rotate the token, the API key, the password and the secret regularly."), []);
  assert.deepEqual(rules(null), []);
  assert.deepEqual(rules(42), []);
});
test("scanSecrets: several rules in one text, each once, never the value", () => {
  const out = rules(`${GHP} ${GHP} ${AKIA}`);
  assert.deepEqual(out.sort(), ["aws-key", "github-token"]);
});
test("homePath: a home folder with a user name only", () => {
  assert.equal(homePath(`cd ${HOME}`), true);
  assert.equal(homePath("/ho" + "me/bob/x"), true);
  assert.equal(homePath("/Us" + "ers/<name>/x"), false);
  assert.equal(homePath("see the /home folder"), false);
});

// ---- export

const exportCfg = () => ({
  agents: [
    agent("scout", { soul: "scout", instructions: "look", envLog: ["2026-11-16T10:00:00.000Z set GH_TOKEN, GH_CONFIG_DIR"], env: { GH_TOKEN: CANARY } }),
    agent("wrangler", { soul: "wrangler", envLog: ["2026-11-16T10:00:00.000Z set A, B", "2026-11-16T11:00:00.000Z set A"] }),
    agent("plain", { instructions: "persona" }),
    agent("other"),
  ],
  squads: [squad("drive", "wrangler", [{ agent: "scout", role: "Scout" }]), squad("solo", "other", [])],
});
const expOpts = (o = {}) => ({ souls: { scout: H1, wrangler: H2 }, app: "1.2.3", now: Date.UTC(2026, 10, 16), envFiles: { scout: { GH_TOKEN: CANARY } }, ...o });

test("exportHerd: whole herd by default; format fields, soulHash, needsEnv count; no version, envLog, env names or values", () => {
  const r = exportHerd(exportCfg(), expOpts());
  assert.ok(r.file, JSON.stringify(r));
  assert.ok(!r.file.includes(CANARY), "canary env value leaked");
  assert.ok(!r.file.includes("envLog"));
  assert.ok(!r.file.includes("GH_CONFIG_DIR") && !r.file.includes("GH_TOKEN"));
  assert.ok(!/"version": 2|"env"/.test(r.file));
  const d = JSON.parse(r.file);
  assert.equal(d.format, FORMAT);
  assert.equal(d.version, 1);
  assert.equal(d.app, "1.2.3");
  assert.equal(d.exported, "2026-11-16T00:00:00.000Z");
  assert.equal(d.agents.length, 4);
  const scout = d.agents.find((a) => a.id === "scout");
  assert.deepEqual(scout, { id: "scout", name: "SCOUT", soul: "scout", soulHash: H1, command: SONNET, instructions: "look", needsEnv: 2 });
  assert.equal(d.agents.find((a) => a.id === "wrangler").needsEnv, 1);
  assert.equal(d.agents.find((a) => a.id === "plain").needsEnv, undefined);
  assert.equal(d.agents.find((a) => a.id === "plain").soul, undefined);
  assert.deepEqual(d.squads[0], { id: "drive", name: "drive", leader: "wrangler", members: [{ agent: "scout", role: "Scout" }] });
  assert.ok(r.file.includes('\n  "agents"'), "2-space indent");
});

test("exportHerd: a picked squad pulls its leader and members; a picked agent alone brings no squads", () => {
  const r = exportHerd(exportCfg(), expOpts({ squads: ["drive"] }));
  const d = JSON.parse(r.file);
  assert.deepEqual(d.agents.map((a) => a.id).sort(), ["scout", "wrangler"]);
  assert.deepEqual(d.squads.map((s) => s.id), ["drive"]);
  const r2 = JSON.parse(exportHerd(exportCfg(), expOpts({ agents: ["plain"] })).file);
  assert.deepEqual(r2.agents.map((a) => a.id), ["plain"]);
  assert.deepEqual(r2.squads, []);
});

test("exportHerd: unknown selection or empty selection is an error, not a file", () => {
  assert.ok(exportHerd(exportCfg(), expOpts({ agents: ["nope"] })).error);
  assert.ok(exportHerd(exportCfg(), expOpts({ agents: [], squads: [] })).error);
});

test("exportHerd: a soul with no local file is exported without soul and the export warns", () => {
  const r = exportHerd(exportCfg(), expOpts({ souls: { wrangler: H2 } }));
  const d = JSON.parse(r.file);
  assert.equal(d.agents.find((a) => a.id === "scout").soul, undefined);
  assert.equal(d.agents.find((a) => a.id === "scout").soulHash, undefined);
  assert.ok(r.warnings.some((w) => w.id === "scout" && w.rule === "soul-missing"));
});

test("exportHerd: a secret blocks the export; hits name id, field and rule, never the value; nothing is stripped", () => {
  const c = exportCfg();
  c.agents[0].command = `claude --api-key ${"abcd1234efgh5678"}`;
  c.agents[2].instructions = `my token ${GHP}`;
  c.agents[3].name = `Bob ${AKIA}`;
  c.squads[0].members[0].role = `${BEARER}`;
  c.squads[1].name = "Ok name";
  const r = exportHerd(c, expOpts());
  assert.equal(r.file, undefined);
  assert.deepEqual(r.blocked, [
    { id: "scout", field: "command", rule: "secret-flag" },
    { id: "plain", field: "instructions", rule: "github-token" },
    { id: "other", field: "name", rule: "aws-key" },
    { id: "drive", field: "role", rule: "bearer-token" },
  ]);
  const text = JSON.stringify(r);
  for (const v of [GHP, AKIA, "abcd1234efgh5678", BEARER]) assert.ok(!text.includes(v), "value in result");
});

test("exportHerd: an id the importer would refuse blocks (dots, overlength)", () => {
  const c = { agents: [agent("a.b"), agent("x".repeat(65))], squads: [] };
  const r = exportHerd(c, expOpts());
  assert.deepEqual(r.blocked.map((b) => [b.id.slice(0, 3), b.field, b.rule]), [["a.b", "id", "id-contract"], ["xxx", "id", "id-contract"]]);
});

test("exportHerd: a home path is a warning, not a block", () => {
  const c = exportCfg();
  c.agents[2].instructions = `work in ${HOME}`;
  const r = exportHerd(c, expOpts());
  assert.ok(r.file);
  assert.ok(r.warnings.some((w) => w.id === "plain" && w.field === "instructions" && w.rule === "home-path"));
});

test("scanItems: only the scanned fields, ids and fields reported", () => {
  const hits = scanItems({ agents: [agent("a", { soul: GHP })], squads: [] });
  assert.deepEqual(hits, []);
});

test("export then import into an empty herd gives the same agents and squads (versions reset)", () => {
  const src = exportCfg();
  const f = exportHerd(src, expOpts()).file;
  const empty = { agents: [], squads: [] };
  const p = plan(empty, f, ctxOf({ localSouls: { scout: H1, wrangler: H2 } }), {});
  assert.deepEqual(p.errors, []);
  assert.ok(p.rows.every((r) => r.action === "add"), JSON.stringify(p.rows.map((r) => [r.key, r.action])));
  const out = apply(empty, p, ctxOf({ localSouls: { scout: H1, wrangler: H2 } }));
  assert.deepEqual(out.config.agents.map((a) => a.id), ["scout", "wrangler", "plain", "other"]);
  assert.deepEqual(out.config.agents[0], { id: "scout", name: "SCOUT", soul: "scout", command: SONNET, instructions: "look", version: 1 });
  assert.deepEqual(out.config.squads.map((s) => [s.id, s.version]), [["drive", 1], ["solo", 1]]);
});

// ---- hostile input

const bad = (text, ctx = ctxOf()) => plan(cfg0(), text, ctx, {});
const fatal = (p) => { assert.ok(p.errors.length > 0, "expected errors"); assert.deepEqual(p.rows, []); assert.equal(p.token, null); };

test("plan: not JSON, wrong root, wrong format, bad or newer version", () => {
  fatal(bad("{nope"));
  fatal(bad("[]"));
  fatal(bad("null"));
  fatal(bad(JSON.stringify({ format: "other", version: 1, agents: [] })));
  fatal(bad(JSON.stringify({ format: FORMAT, version: 2, agents: [] })));
  assert.match(bad(JSON.stringify({ format: FORMAT, version: 2, agents: [] })).errors[0], /update Drover/i);
  fatal(bad(JSON.stringify({ format: FORMAT, version: "1", agents: [] })));
  fatal(bad(JSON.stringify({ format: FORMAT, version: 0, agents: [] })));
  fatal(bad(JSON.stringify({ format: FORMAT, version: 1.5, agents: [] })));
  fatal(bad(42));
});

test("plan: size cap is bytes, not characters", () => {
  const big = file([fa("a", { instructions: "x".repeat(MAX_BYTES) })]);
  fatal(bad(big));
  const wide = file([fa("a", { instructions: "é".repeat(MAX_BYTES / 2 + 100) })]);
  assert.ok(wide.length < MAX_BYTES);
  fatal(bad(wide));
});

test("plan: counts and shapes (agents/squads not arrays, > 200 agents, > 50 members, duplicate ids)", () => {
  fatal(bad(JSON.stringify({ format: FORMAT, version: 1, agents: {} })));
  fatal(bad(JSON.stringify({ format: FORMAT, version: 1, agents: [], squads: "x" })));
  fatal(bad(file(Array.from({ length: 201 }, (_, i) => fa("a" + i)))));
  fatal(bad(file([fa("a")], [squad("s", "a", Array.from({ length: 51 }, () => ({ agent: "a", role: "" })))])));
  fatal(bad(file([fa("a"), fa("a")])));
  fatal(bad(file([fa("a")], [squad("s", "a"), squad("s", "a")])));
  assert.deepEqual(bad(file(Array.from({ length: 200 }, (_, i) => fa("a" + i)))).errors, []);
});

test("plan: prototype keys anywhere are refused and nothing is polluted", () => {
  fatal(bad('{"format":"drover-herdr.agents","version":1,"agents":[],"__proto__":{"x":1}}'));
  fatal(bad(`{"format":"drover-herdr.agents","version":1,"agents":[{"id":"a","name":"A","command":"c","instructions":"","constructor":{"prototype":{}}}]}`));
  fatal(bad(`{"format":"drover-herdr.agents","version":1,"agents":[{"id":"a","name":"A","command":"c","extra":{"deep":[{"prototype":1}]}}]}`));
  assert.equal({}.x, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("plan: absurd nesting is refused, not a crash", () => {
  const deep = "[".repeat(5000) + "]".repeat(5000);
  fatal(bad(`{"format":"${FORMAT}","version":1,"agents":[{"id":"a","name":"A","command":"c","x":${deep}}]}`));
});

test("plan: a bad item blocks its own row only; ids follow the env contract", () => {
  const ids = ["a.b", "x".repeat(65), "", "../x", "a b", "é", 5, null];
  for (const id of ids) {
    const p = bad(file([fa("good"), { ...fa("x"), id }]));
    assert.deepEqual(p.errors, [], String(id));
    assert.equal(row(p, "agent:good").action, "add");
    const blocked = p.rows.filter((r) => r.action === "blocked");
    assert.equal(blocked.length, 1, `id ${String(id)}`);
    assert.ok(blocked[0].blocked.some((b) => b.code === "bad-id"));
  }
  assert.equal(row(bad(file([fa("x".repeat(64))])), `agent:${"x".repeat(64)}`).action, "add");
  assert.equal(row(bad(file([fa("A_b-9")])), "agent:A_b-9").action, "add");
});

test("plan: field types, lengths, empty and control characters block the row", () => {
  const cases = {
    "no name": { name: "  " }, "name not string": { name: 5 }, "long name": { name: "n".repeat(201) },
    "no command": { command: "   " }, "command array": { command: ["claude"] }, "long command": { command: "c".repeat(4001) },
    "command newline": { command: "claude\nrm -rf x" }, "command nul": { command: "claude\0" }, "name newline": { name: "a\nb" },
    "instructions object": { instructions: { a: 1 } }, "long instructions": { instructions: "i".repeat(100001) }, "instructions nul": { instructions: "a\0b" },
    "soul object": { soul: { a: 1 } },
  };
  for (const [label, o] of Object.entries(cases)) {
    const p = bad(file([{ ...fa("t"), ...o }]));
    assert.equal(row(p, "agent:t").action, "blocked", label);
  }
});

test("plan: items are rebuilt from allowed fields only (no version, envLog, env, extras)", () => {
  const p = bad(file([{ ...fa("n"), version: 99, envLog: ["x"], env: { A: "b" }, evil: 1, needsEnv: 3 }]));
  const item = row(p, "agent:n").item;
  assert.deepEqual(Object.keys(item).sort(), ["command", "id", "instructions", "name", "needsEnv"]);
  assert.equal(item.needsEnv, 3);
  const out = apply(cfg0(), p, ctxOf());
  assert.deepEqual(out.config.agents.at(-1), { id: "n", name: "N", command: SONNET, instructions: "", version: 1 });
});

test("plan: needsEnv is a small count or dropped", () => {
  for (const v of [-1, 1.5, "2", 1e9, null]) assert.equal(row(bad(file([{ ...fa("n"), needsEnv: v }])), "agent:n").item.needsEnv, undefined, String(v));
  assert.equal(row(bad(file([{ ...fa("n"), needsEnv: 2 }])), "agent:n").warnings.some((w) => w.code === "needs-env"), true);
});

test("plan: squads with bad refs, bad ids or too many chars are blocked rows", () => {
  const p = bad(file([fa("a")], [squad("s1", "ghost"), squad("s2", "a", [{ agent: "ghost", role: "" }]), squad("s.3", "a"), squad("s4", "a", [{ agent: "a", role: 5 }]), squad("s5", "scout", [{ agent: "a", role: "ok" }])]));
  assert.deepEqual(p.errors, []);
  assert.equal(row(p, "squad:s1").action, "blocked");
  assert.equal(row(p, "squad:s2").action, "blocked");
  assert.equal(row(p, "squad#2").action, "blocked");
  assert.equal(row(p, "squad:s4").action, "blocked");
  assert.equal(row(p, "squad:s5").action, "add");
});

test("plan: the file is scanned on import; a hit blocks the row and its squads, the rest still applies; no value in the plan", () => {
  const p = bad(file(
    [fa("leak", { instructions: `use ${GHP}` }), fa("fine"), fa("cmd", { command: `claude ${PEM}` })],
    [squad("uses-leak", "fine", [{ agent: "leak", role: "r" }]), squad("fine-squad", "fine", [{ agent: "fine", role: "ok" }]), squad("bad-role", "fine", [{ agent: "fine", role: AKIA }])],
  ));
  assert.equal(row(p, "agent:leak").action, "blocked");
  assert.deepEqual(row(p, "agent:leak").blocked, [{ code: "secret", field: "instructions", rule: "github-token" }]);
  assert.equal(row(p, "agent:cmd").action, "blocked");
  assert.equal(row(p, "squad:uses-leak").action, "blocked");
  assert.equal(row(p, "squad:bad-role").action, "blocked");
  assert.equal(row(p, "squad:fine-squad").action, "add");
  assert.equal(row(p, "agent:fine").action, "add");
  for (const v of [GHP, AKIA, PEM]) assert.ok(!JSON.stringify(p).includes(v), "value in plan");
  const out = apply(cfg0(), p, ctxOf());
  assert.ok(out.config.agents.some((a) => a.id === "fine"));
  assert.ok(!out.config.agents.some((a) => a.id === "leak" || a.id === "cmd"));
  assert.ok(!out.config.squads.some((s) => s.id === "uses-leak" || s.id === "bad-role"));
});

test("plan: warnings for home path and unknown harness; known harnesses and wrapper paths are quiet", () => {
  const codes = (cmd, instr = "") => row(bad(file([fa("w", { command: cmd, instructions: instr })])), "agent:w").warnings.map((w) => w.code);
  assert.deepEqual(codes("claude --x"), []);
  assert.deepEqual(codes("codex --no-daemon"), []);
  assert.deepEqual(codes("/opt/bin/pi --model m"), []);
  assert.ok(codes("bash -c whoami").includes("unknown-harness"));
  assert.ok(codes("./run.sh").includes("unknown-harness"));
  assert.ok(codes("claude", `cd ${HOME}`).includes("home-path"));
  assert.ok(codes(`claude --add-dir ${HOME}`).includes("home-path"));
});

// ---- clash matrix

const SAME = { name: "SCOUT", soul: "scout", soulHash: H1, command: SONNET, instructions: "look" };
const DIFF = { ...SAME, command: SONNET + " --effort high", instructions: "peek" };
const ch = (o) => ({ "agent:scout": o });

test("clash: new id -> add (or skip when the person says skip)", () => {
  const p = bad(file([fa("fresh")]));
  assert.equal(row(p, "agent:fresh").action, "add");
  assert.equal(plan(cfg0(), file([fa("fresh")]), ctxOf(), { "agent:fresh": { action: "skip" } }).rows[0].action, "skip");
});

test("clash: identical -> skip, whatever the choice; apply leaves the config byte-equal", () => {
  for (const choice of [undefined, { action: "copy" }, { action: "overwrite" }, { action: "keep" }]) {
    const p = plan(cfg0(), file([fa("scout", SAME)]), ctxOf(), choice ? ch(choice) : {});
    assert.equal(row(p, "agent:scout").action, "skip");
    assert.deepEqual(apply(cfg0(), p, ctxOf()).config, cfg0());
  }
});

test("clash: differs -> keep mine by default; apply changes nothing", () => {
  const p = plan(cfg0(), file([fa("scout", DIFF)]), ctxOf(), {});
  assert.equal(row(p, "agent:scout").action, "keep");
  assert.deepEqual(apply(cfg0(), p, ctxOf()).config, cfg0());
});

test("clash: differs + copy -> scout-2 with a suffixed name, version 1, original untouched", () => {
  const p = plan(cfg0(), file([fa("scout", DIFF)]), ctxOf(), ch({ action: "copy" }));
  const r = row(p, "agent:scout");
  assert.equal(r.action, "copy");
  assert.equal(r.newId, "scout-2");
  const out = apply(cfg0(), p, ctxOf());
  assert.deepEqual(out.config.agents.slice(0, 2), cfg0().agents);
  assert.deepEqual(out.config.agents[2], { id: "scout-2", name: "SCOUT 2", soul: "scout", command: DIFF.command, instructions: "peek", version: 1 });
});

test("clash: differs + overwrite -> version+1, envLog of the destination kept, nothing else of the old profile", () => {
  const c = cfg0();
  c.agents[0].envLog = ["2026-11-16T10:00:00.000Z set A"];
  c.agents[0].version = 4;
  const p = plan(c, file([fa("scout", DIFF)]), ctxOf(), ch({ action: "overwrite" }));
  assert.equal(row(p, "agent:scout").action, "overwrite");
  const out = apply(c, p, ctxOf());
  assert.deepEqual(out.config.agents[0], { id: "scout", name: "SCOUT", soul: "scout", command: DIFF.command, instructions: "peek", envLog: ["2026-11-16T10:00:00.000Z set A"], version: 5 });
  assert.deepEqual(out.config.agents[1], c.agents[1]);
});

test("clash: warns when command or instructions of an existing agent change, and on a name clash with another id", () => {
  const p = plan(cfg0(), file([fa("scout", DIFF), fa("twin", { name: "wrangler" })]), ctxOf(), {});
  const codes = row(p, "agent:scout").warnings.map((w) => w.code);
  assert.ok(codes.includes("command-changed") && codes.includes("instructions-changed"));
  assert.ok(row(p, "agent:twin").warnings.some((w) => w.code === "name-clash"));
  assert.equal(row(p, "agent:twin").action, "add");
});

test("clash matrix with env files: overwrite needs the ack; copy and keep do not; orphan env blocks add", () => {
  const withEnv = ctxOf({ envIds: new Set(["scout"]) });
  // overwrite without ack: held, not written
  let p = plan(cfg0(), file([fa("scout", DIFF)]), withEnv, ch({ action: "overwrite" }));
  assert.deepEqual(row(p, "agent:scout").pendingAck, ["env"]);
  let out = apply(cfg0(), p, withEnv);
  assert.deepEqual(out.config, cfg0());
  assert.deepEqual(out.held, ["agent:scout"]);
  // with ack: written
  p = plan(cfg0(), file([fa("scout", DIFF)]), withEnv, ch({ action: "overwrite", ackEnv: true }));
  assert.deepEqual(row(p, "agent:scout").pendingAck, []);
  out = apply(cfg0(), p, withEnv);
  assert.equal(out.config.agents[0].command, DIFF.command);
  assert.equal(out.config.agents[0].version, 2);
  // copy: new id, no ack
  p = plan(cfg0(), file([fa("scout", DIFF)]), withEnv, ch({ action: "copy" }));
  assert.deepEqual(row(p, "agent:scout").pendingAck, []);
  assert.equal(apply(cfg0(), p, withEnv).config.agents.length, 3);
  // keep with env: default
  p = plan(cfg0(), file([fa("scout", DIFF)]), withEnv, {});
  assert.equal(row(p, "agent:scout").action, "keep");
  // env names of the overwritten agent are shown (names only)
  const c = cfg0();
  c.agents[0].envLog = ["2026-11-16T10:00:00.000Z set GH_CONFIG_DIR, GH_TOKEN"];
  p = plan(c, file([fa("scout", DIFF)]), withEnv, ch({ action: "overwrite" }));
  assert.deepEqual(row(p, "agent:scout").envNames, ["GH_CONFIG_DIR", "GH_TOKEN"]);
});

test("orphan env file: add of an id with an env file and no agent is blocked, never read", () => {
  const ctx = ctxOf({ envIds: new Set(["fresh"]) });
  const p = plan(cfg0(), file([fa("fresh")]), ctx, {});
  assert.equal(row(p, "agent:fresh").action, "blocked");
  assert.ok(row(p, "agent:fresh").blocked.some((b) => b.code === "env-orphan"));
  assert.ok(!apply(cfg0(), p, ctx).config.agents.some((a) => a.id === "fresh"));
});

test("env facts: a failed presence check stops the plan; a missing envIds is the same as a failure", () => {
  fatal(plan(cfg0(), file([fa("fresh")]), ctxOf({ envIds: { error: "EACCES" } }), {}));
  fatal(plan(cfg0(), file([fa("fresh")]), ctxOf({ envIds: undefined }), {}));
  fatal(plan(cfg0(), file([fa("fresh")]), ctxOf({ envIds: ["fresh"] }), {}));
});

test("apply re-checks env facts: an env file that appeared since the plan stops the apply; so does a failed check", () => {
  const p = plan(cfg0(), file([fa("fresh")]), ctxOf(), {});
  assert.ok(apply(cfg0(), p, ctxOf({ envIds: new Set(["fresh"]) })).error);
  assert.ok(apply(cfg0(), p, ctxOf({ envIds: { error: "EIO" } })).error);
  assert.ok(apply(cfg0(), p, ctxOf({ envIds: undefined })).error);
  // overwrite that had no env at plan time but has one now needs the ack it never had
  const p2 = plan(cfg0(), file([fa("scout", DIFF)]), ctxOf(), ch({ action: "overwrite" }));
  const out = apply(cfg0(), p2, ctxOf({ envIds: new Set(["scout"]) }));
  assert.ok(out.error || out.stale, JSON.stringify(out));
});

// ---- souls

test("soul: unknown name is dropped with a warning that needs an ack; the row is held until ticked", () => {
  const f = file([fa("fresh", { soul: "ghost", soulHash: H1 })]);
  let p = plan(cfg0(), f, ctxOf(), {});
  const r = row(p, "agent:fresh");
  assert.equal(r.item.soul, undefined);
  assert.equal(r.item.soulHash, undefined);
  assert.ok(r.warnings.some((w) => w.code === "soul-dropped"));
  assert.deepEqual(r.pendingAck, ["soul"]);
  assert.deepEqual(apply(cfg0(), p, ctxOf()).config, cfg0());
  p = plan(cfg0(), f, ctxOf(), { "agent:fresh": { ackSoul: true } });
  assert.deepEqual(row(p, "agent:fresh").pendingAck, []);
  const out = apply(cfg0(), p, ctxOf());
  assert.deepEqual(out.config.agents.at(-1), { id: "fresh", name: "FRESH", command: SONNET, instructions: "", version: 1 });
});

test("soul: a hostile soul name (path, wrong charset) is never kept, even if the local map has it", () => {
  const ctx = ctxOf({ localSouls: { scout: H1, "../etc/passwd": H1, "Bad Name": H1 } });
  for (const soul of ["../etc/passwd", "Bad Name", "x".repeat(65), ""]) {
    const r = row(plan(cfg0(), file([fa("fresh", { soul })]), ctx, {}), "agent:fresh");
    assert.equal(r.item.soul, undefined, soul);
  }
});

test("soul: same name, different hash is a warning (no ack), the soul name is kept", () => {
  const p = plan(cfg0(), file([fa("fresh", { soul: "scout", soulHash: H2 })]), ctxOf(), {});
  const r = row(p, "agent:fresh");
  assert.equal(r.item.soul, "scout");
  assert.ok(r.warnings.some((w) => w.code === "soul-differs"));
  assert.ok(!r.warnings.some((w) => w.code === "soul-dropped"));
  assert.deepEqual(r.pendingAck, []);
});

test("soul: same hash is quiet; absent file and different hash are separate warnings", () => {
  const codes = (o) => row(plan(cfg0(), file([fa("fresh", o)]), ctxOf(), {}), "agent:fresh").warnings.map((w) => w.code).filter((c) => c.startsWith("soul"));
  assert.deepEqual(codes({ soul: "scout", soulHash: H1 }), []);
  assert.deepEqual(codes({ soul: "scout", soulHash: H2 }), ["soul-differs"]);
  assert.deepEqual(codes({ soul: "ghost", soulHash: H1 }), ["soul-dropped"]);
  assert.deepEqual(codes({}), []);
  assert.deepEqual(codes({ soul: "scout", soulHash: "nothex" }), []);
});

test("soul: a changed same-name soul never passes silently (identical content but other soul text still shows the warning)", () => {
  const p = plan(cfg0(), file([fa("scout", { ...SAME, soulHash: H2 })]), ctxOf(), {});
  assert.equal(row(p, "agent:scout").action, "skip");
  assert.ok(row(p, "agent:scout").warnings.some((w) => w.code === "soul-differs"));
});

// ---- copy ids

test("copy ids: first free suffix, counting cfg ids, file ids and other copies", () => {
  const c = cfg0();
  c.agents.push(agent("scout-2"));
  const f = file([fa("scout", DIFF), fa("scout-3"), fa("wrangler", { name: "W", command: "claude --x" })]);
  const p = plan(c, f, ctxOf(), { "agent:scout": { action: "copy" }, "agent:wrangler": { action: "copy" } });
  assert.equal(row(p, "agent:scout").newId, "scout-4");
  assert.equal(row(p, "agent:wrangler").newId, "wrangler-2");
  const ids = p.rows.filter((r) => r.action === "copy").map((r) => r.newId);
  assert.equal(new Set(ids).size, ids.length);
});

test("copy ids: two files ids that would take the same suffix get different ones", () => {
  const c = { agents: [agent("a"), agent("a-2")], squads: [] };
  const p = plan(c, file([fa("a", { command: "claude --z" }), fa("a-2", { command: "claude --z" })]), ctxOf(), { "agent:a": { action: "copy" }, "agent:a-2": { action: "copy" } });
  assert.deepEqual([row(p, "agent:a").newId, row(p, "agent:a-2").newId], ["a-3", "a-2-2"]);
});

test("copy ids: a 64-character id is truncated so the copy stays within 64, also across suffix widths", () => {
  const id = "m".repeat(64);
  const c = { agents: [agent(id)], squads: [] };
  const f = file([fa(id, { command: "claude --z" })]);
  let p = plan(c, f, ctxOf(), { [`agent:${id}`]: { action: "copy" } });
  assert.equal(row(p, `agent:${id}`).newId, "m".repeat(62) + "-2");
  // occupy -2 .. -9 so the suffix grows to two digits
  const occ = { agents: [agent(id), ...Array.from({ length: 8 }, (_, i) => agent("m".repeat(62) + `-${i + 2}`))], squads: [] };
  p = plan(occ, f, ctxOf(), { [`agent:${id}`]: { action: "copy" } });
  const nid = row(p, `agent:${id}`).newId;
  assert.equal(nid, "m".repeat(61) + "-10");
  assert.equal(nid.length, 64);
  assert.match(nid, /^[A-Za-z0-9_-]{1,64}$/);
  const out = apply(occ, p, ctxOf());
  assert.ok(out.config.agents.some((a) => a.id === nid));
});

test("copy ids: a candidate that has an env file is skipped, never adopted", () => {
  const p = plan(cfg0(), file([fa("scout", DIFF)]), ctxOf({ envIds: new Set(["scout", "scout-2"]) }), ch({ action: "copy" }));
  assert.equal(row(p, "agent:scout").newId, "scout-3");
});

test("copy ids: when no free suffix exists the row is blocked", () => {
  const taken = Array.from({ length: 1100 }, (_, i) => agent(`s-${i + 2}`));
  const c = { agents: [agent("s"), ...taken], squads: [] };
  const p = plan(c, file([fa("s", { command: "claude --z" })]), ctxOf(), { "agent:s": { action: "copy" } });
  assert.equal(row(p, "agent:s").action, "blocked");
  assert.ok(row(p, "agent:s").blocked.some((b) => b.code === "no-free-id"));
});

test("copy name suffix keeps the name within its limit", () => {
  const long = "n".repeat(200);
  const p = plan(cfg0(), file([fa("scout", { ...DIFF, name: long })]), ctxOf(), ch({ action: "copy" }));
  assert.equal(row(p, "agent:scout").item.name.length, 200);
  assert.ok(row(p, "agent:scout").item.name.endsWith(" 2"));
});

// ---- squads

test("squad refs: a squad in the file follows the copy of its agent; refs to local agents resolve against the config", () => {
  const f = file([fa("scout", DIFF)], [squad("crew", "scout", [{ agent: "wrangler", role: "W" }, { agent: "scout", role: "S" }])]);
  const p = plan(cfg0(), f, ctxOf(), ch({ action: "copy" }));
  assert.equal(row(p, "squad:crew").action, "add");
  assert.equal(row(p, "squad:crew").item.leader, "scout-2");
  assert.deepEqual(row(p, "squad:crew").item.members.map((m) => m.agent), ["wrangler", "scout-2"]);
  const out = apply(cfg0(), p, ctxOf());
  const s = out.config.squads.find((x) => x.id === "crew");
  assert.equal(s.leader, "scout-2");
  assert.ok(out.config.agents.some((a) => a.id === "scout-2"));
});

test("squad refs: a squad of an agent kept as mine points at mine; of an agent held for ack it is blocked", () => {
  const f = file([fa("scout", DIFF), fa("fresh", { soul: "ghost" })], [squad("k", "scout"), squad("h", "fresh")]);
  const p = plan(cfg0(), f, ctxOf(), {});
  assert.equal(row(p, "squad:k").item.leader, "scout");
  assert.equal(row(p, "squad:h").action, "blocked");
  assert.ok(row(p, "squad:h").blocked.some((b) => b.code === "ref-unavailable"));
});

test("squad clash: identical skips; differs keep/copy/overwrite (version+1); copy allocates an unused squad id", () => {
  const same = squad("drive", "wrangler", [{ agent: "scout", role: "Scout" }]);
  const diff = { ...same, name: "Other name", members: [{ agent: "scout", role: "Changed" }] };
  const f = (s) => file([], [s]);
  assert.equal(row(plan(cfg0(), f(same), ctxOf(), {}), "squad:drive").action, "skip");
  assert.equal(row(plan(cfg0(), f(diff), ctxOf(), {}), "squad:drive").action, "keep");
  const pc = plan(cfg0(), f(diff), ctxOf(), { "squad:drive": { action: "copy" } });
  assert.equal(row(pc, "squad:drive").newId, "drive-2");
  const outc = apply(cfg0(), pc, ctxOf());
  assert.ok(outc.config.squads.some((s) => s.id === "drive-2" && s.version === 1));
  const po = plan(cfg0(), f(diff), ctxOf(), { "squad:drive": { action: "overwrite" } });
  const outo = apply(cfg0(), po, ctxOf());
  const s = outo.config.squads.find((x) => x.id === "drive");
  assert.equal(s.version, 2);
  assert.equal(s.members[0].role, "Changed");
});

test("squad overwrite that leaves no dangling refs; overwrite of an agent keeps the squads that use it valid", () => {
  const p = plan(cfg0(), file([fa("scout", DIFF)]), ctxOf(), ch({ action: "overwrite" }));
  const out = apply(cfg0(), p, ctxOf());
  const ids = new Set(out.config.agents.map((a) => a.id));
  for (const s of out.config.squads) assert.ok(ids.has(s.leader) && s.members.every((m) => ids.has(m.agent)));
});

// ---- digest, token, stale preview, apply integrity

test("plan: digest is the sha-256 of the stable JSON of the destination; token binds file, destination and choices", () => {
  const f = file([fa("fresh")]);
  const p = plan(cfg0(), f, ctxOf(), {});
  assert.equal(p.digest, sha256(stableJson(cfg0())));
  assert.equal(p.token, sha256(`${sha256(f)}|${p.digest}|${stableJson({})}`));
  const reordered = { squads: cfg0().squads, agents: cfg0().agents.map((a) => Object.fromEntries(Object.entries(a).reverse())) };
  assert.equal(plan(reordered, f, ctxOf(), {}).digest, p.digest);
  assert.notEqual(plan(cfg0(), file([fa("other")]), ctxOf(), {}).token, p.token);
  assert.notEqual(plan(cfg0(), f, ctxOf(), { "agent:fresh": { action: "skip" } }).token, p.token);
  const moved = cfg0();
  moved.agents.push(agent("z"));
  assert.notEqual(plan(moved, f, ctxOf(), {}).token, p.token);
});

test("stale preview: an edit between plan and apply refuses and writes nothing; the edit survives", () => {
  const p = plan(cfg0(), file([fa("fresh")]), ctxOf(), {});
  const edited = cfg0();
  edited.agents.push(agent("added-elsewhere"));
  const out = apply(edited, p, ctxOf());
  assert.deepEqual(out, { stale: true });
  // an edit that changes an existing agent is drift too
  const edited2 = cfg0();
  edited2.agents[0].instructions = "changed";
  assert.deepEqual(apply(edited2, p, ctxOf()), { stale: true });
});

test("second apply of the same plan is stale; a plan that changed nothing can repeat", () => {
  const p = plan(cfg0(), file([fa("fresh")]), ctxOf(), {});
  const first = apply(cfg0(), p, ctxOf());
  assert.deepEqual(first.applied, [{ key: "agent:fresh", action: "add", id: "fresh" }]);
  assert.deepEqual(apply(first.config, p, ctxOf()), { stale: true });
  const noop = plan(cfg0(), file([fa("scout", SAME)]), ctxOf(), {});
  assert.deepEqual(apply(cfg0(), noop, ctxOf()).applied, []);
  assert.deepEqual(apply(cfg0(), noop, ctxOf()).config, cfg0());
});

test("apply: other keys of the config and unrelated items are carried over, input is not mutated", () => {
  const c = { ...cfg0(), extra: { keep: true } };
  const before = JSON.stringify(c);
  const p = plan(c, file([fa("fresh")]), ctxOf(), {});
  const out = apply(c, p, ctxOf());
  assert.equal(JSON.stringify(c), before);
  assert.deepEqual(out.config.extra, { keep: true });
  assert.deepEqual(out.config.agents.slice(0, 2), c.agents);
});

test("apply: a tampered plan is refused (token, secret in an item, bad id, dangling ref)", () => {
  const mk = () => plan(cfg0(), file([fa("fresh")], [squad("crew", "fresh")]), ctxOf(), {});
  let p = mk();
  p.rows.find((r) => r.key === "agent:fresh").item.command = `claude --token ${"abcd1234efgh5678"}`;
  assert.ok(apply(cfg0(), p, ctxOf()).error);
  p = mk();
  p.token = "0".repeat(64);
  assert.ok(apply(cfg0(), p, ctxOf()).error);
  p = mk();
  p.rows.find((r) => r.key === "agent:fresh").item.id = "bad.id";
  assert.ok(apply(cfg0(), p, ctxOf()).error);
  p = mk();
  p.rows.find((r) => r.key === "squad:crew").item.leader = "ghost";
  assert.ok(apply(cfg0(), p, ctxOf()).error);
  p = mk();
  p.rows.find((r) => r.key === "agent:fresh").action = "add-and-delete-everything";
  assert.ok(apply(cfg0(), p, ctxOf()).error);
  assert.ok(apply(cfg0(), null, ctxOf()).error);
  assert.ok(apply(cfg0(), { errors: ["x"], rows: [], token: null }, ctxOf()).error);
});

test("apply: an applied soul that no longer exists locally is stale, not kept", () => {
  const p = plan(cfg0(), file([fa("fresh", { soul: "scout", soulHash: H1 })]), ctxOf(), {});
  const out = apply(cfg0(), p, ctxOf({ localSouls: { wrangler: H1 } }));
  assert.deepEqual(out, { stale: true });
});

test("hostile choices: odd keys and actions are ignored and never reach the plan", () => {
  const choices = JSON.parse('{"__proto__":{"action":"overwrite"},"agent:scout":{"action":"rm -rf","ackEnv":"yes"},"agent:nope":{"action":"copy"}}');
  const p = plan(cfg0(), file([fa("scout", DIFF)]), ctxOf(), choices);
  assert.equal(row(p, "agent:scout").action, "keep");
  assert.equal({}.action, undefined);
  assert.equal(plan(cfg0(), file([fa("scout", DIFF)]), ctxOf(), null).rows.length, 1);
});

test("plan: a malformed destination config is an error, not a crash", () => {
  fatal(plan(null, file([]), ctxOf(), {}));
  fatal(plan({ agents: 1, squads: [] }, file([]), ctxOf(), {}));
});

// ---- review round 1

test("apply recomputes the plan: a valid but unreviewed id in a row is refused", () => {
  const p = plan(cfg0(), file([fa("foreign")]), ctxOf(), {});
  p.rows[0].item.id = "not-previewed";
  const out = apply(cfg0(), p, ctxOf());
  assert.ok(out.error || out.stale, JSON.stringify(out));
  assert.equal(out.config, undefined);
});

test("apply recomputes the plan: an action flipped from keep to overwrite is refused", () => {
  const p = plan(cfg0(), file([fa("scout", DIFF)]), ctxOf(), {});
  assert.equal(row(p, "agent:scout").action, "keep");
  row(p, "agent:scout").action = "overwrite";
  row(p, "agent:scout").pendingAck = [];
  const out = apply(cfg0(), p, ctxOf());
  assert.ok(out.error || out.stale, JSON.stringify(out));
  assert.equal(out.config, undefined);
});

test("apply recomputes the plan: changed command text, added rows and dropped acks are refused", () => {
  let p = plan(cfg0(), file([fa("foreign")]), ctxOf(), {});
  p.rows[0].item.command = "claude --dangerously-skip-permissions";
  assert.ok(apply(cfg0(), p, ctxOf()).error);
  p = plan(cfg0(), file([fa("foreign")]), ctxOf(), {});
  p.rows.push({ ...p.rows[0], key: "agent:extra", id: "extra", item: { ...p.rows[0].item, id: "extra" } });
  assert.ok(apply(cfg0(), p, ctxOf()).error);
  p = plan(cfg0(), file([fa("fresh", { soul: "ghost" })]), ctxOf(), {});
  p.rows[0].pendingAck = [];
  assert.ok(apply(cfg0(), p, ctxOf()).error);
});

test("apply: an untouched plan still applies; the file text does not travel in the plan JSON but can be passed in ctx", () => {
  const f = file([fa("fresh")]);
  const p = plan(cfg0(), f, ctxOf(), {});
  assert.ok(!JSON.stringify(p).includes("fresh\\n") && !("fileText" in JSON.parse(JSON.stringify(p))));
  const clone = JSON.parse(JSON.stringify(p));
  assert.ok(apply(cfg0(), clone, ctxOf()).error, "no bound file");
  assert.ok(apply(cfg0(), clone, ctxOf({ fileText: f })).config);
  assert.ok(apply(cfg0(), clone, ctxOf({ fileText: file([fa("other")]) })).error);
  assert.ok(apply(cfg0(), p, ctxOf()).config);
});

test("blocked rows carry no name, id or ref that holds a secret (agent, squad, malformed combos)", () => {
  const leak = GHP;
  const p = bad(file(
    [fa("a1", { name: leak }), fa("a2", { name: leak, command: "" }), fa("a3", { name: `x ${AKIA}`, command: "c\nd" }), fa(leak)],
    [squad("s1", "scout", [], { name: leak }), squad("s2", "scout", [{ agent: leak, role: "r" }]), { id: "s3", name: leak, leader: 5, members: "x" }, squad(leak, "scout")],
  ));
  assert.equal(p.rows.filter((r) => r.action === "blocked").length, 8);
  const text = JSON.stringify(p);
  for (const v of [GHP, AKIA]) assert.ok(!text.includes(v), "secret in plan");
  for (const r of p.rows) assert.equal(r.name, "");
});

test("env replay: each set replaces the names, clear empties them", () => {
  const e = (...lines) => ({ agents: [agent("scout", { envLog: lines })], squads: [] });
  const need = (c) => JSON.parse(exportHerd(c, expOpts({ souls: { scout: H1 } })).file).agents[0].needsEnv;
  assert.equal(need(e("2026-11-16T10:00:00.000Z set A, B", "2026-11-16T11:00:00.000Z set A")), 1);
  assert.equal(need(e("2026-11-16T10:00:00.000Z set A, B", "2026-11-16T11:00:00.000Z clear")), undefined);
  assert.equal(need(e("2026-11-16T10:00:00.000Z set A, B", "2026-11-16T11:00:00.000Z clear", "2026-11-16T12:00:00.000Z set C")), 1);
  const c = cfg0();
  c.agents[0].envLog = ["2026-11-16T10:00:00.000Z set A, B", "2026-11-16T11:00:00.000Z set A"];
  const p = plan(c, file([fa("scout", DIFF)]), ctxOf({ envIds: new Set(["scout"]) }), ch({ action: "overwrite" }));
  assert.deepEqual(row(p, "agent:scout").envNames, ["A"]);
});
