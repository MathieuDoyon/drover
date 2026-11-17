// The pure logic behind the Export and Import dialogs: selection -> export, row choices -> plan choices, messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportName, allTicked, toggle, lockedAgents, exportView, rowOptions, toChoices, previewImport, applyImport, candidateIds, soulNames, settleFacts, labelOf } from "./herd-share.js";
import { sha256 } from "./herd-export.js";

const H = sha256("scout soul");
const CMD = "claude --model claude-sonnet-5-5";
const agent = (id, extra = {}) => ({ id, name: id.toUpperCase(), command: CMD, instructions: "", version: 1, ...extra });
const cfg0 = () => ({
  agents: [agent("scout", { soul: "scout", envLog: ["2026-01-01T00:00:00Z set GH_TOKEN"] }), agent("wrangler"), agent("qa")],
  squads: [{ id: "drive", name: "Drive", leader: "scout", members: [{ agent: "wrangler", role: "code" }], version: 1 }],
});
const expCtx = { souls: { scout: H }, now: Date.UTC(2026, 10, 16), app: "t" };
const file = (agents, squads = []) => JSON.stringify({ format: "drover-herdr.agents", version: 1, exported: "2026-11-16T00:00:00.000Z", app: "t", agents, squads });
const fa = (id, extra = {}) => ({ id, name: id.toUpperCase(), command: CMD, instructions: "", ...extra });
const ctxOf = (o = {}) => ({ localSouls: { scout: H }, envIds: new Set(), supported: 1, ...o });

test("exportName is dated and fixed-shape", () => {
  assert.equal(exportName(Date.UTC(2026, 10, 16, 23, 59)), "drover-herdr-agents-2026-11-16.json");
});

test("all agents and squads start ticked; ticking a squad locks its agents; a locked agent cannot be unticked", () => {
  const c = cfg0();
  let sel = allTicked(c);
  assert.deepEqual([...sel.agents].sort(), ["qa", "scout", "wrangler"]);
  assert.deepEqual([...sel.squads], ["drive"]);
  assert.deepEqual([...lockedAgents(c, sel)].sort(), ["scout", "wrangler"]);
  assert.deepEqual([...toggle(c, sel, "agent", "scout").agents].sort(), ["qa", "scout", "wrangler"], "locked: no change");
  assert.deepEqual([...toggle(c, sel, "agent", "qa").agents].sort(), ["scout", "wrangler"]);
  sel = toggle(c, sel, "squad", "drive");
  assert.equal(sel.squads.size, 0);
  assert.equal(lockedAgents(c, sel).size, 0);
  assert.deepEqual([...toggle(c, sel, "agent", "scout").agents].sort(), ["qa", "wrangler"], "unlocked after the squad is unticked");
});

test("exportView: a squad pulls its agents in even when they were unticked first", () => {
  const c = cfg0();
  const sel = { agents: new Set(), squads: new Set(["drive"]) };
  const v = exportView(c, sel, expCtx);
  assert.equal(v.ok, true);
  const d = JSON.parse(v.file);
  assert.deepEqual(d.agents.map((a) => a.id), ["scout", "wrangler"]);
  assert.equal(v.agents, 2);
  assert.equal(v.squads, 1);
});

test("exportView: nothing selected is not ok and has no file", () => {
  const v = exportView(cfg0(), { agents: new Set(), squads: new Set() }, expCtx);
  assert.equal(v.ok, false);
  assert.equal(v.file, undefined);
  assert.match(v.message, /Nothing selected/);
});

test("exportView: a secret blocks, the line names id, field and rule and never the value", () => {
  const c = cfg0();
  const secret = "gh" + "p_" + "A".repeat(30);
  c.agents[1].instructions = `use ${secret}`;
  const v = exportView(c, allTicked(c), expCtx);
  assert.equal(v.ok, false);
  assert.equal(v.file, undefined);
  assert.deepEqual(v.blocked, ["wrangler · instructions · github-token"]);
  assert.ok(!JSON.stringify(v).includes(secret));
});

test("exportView: warnings are text lines, home paths do not block", () => {
  const c = cfg0();
  c.agents[2].instructions = "see /home/u/notes";
  const v = exportView(c, allTicked(c), expCtx);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /qa/.test(w) && /home/i.test(w)));
});

test("exportView: an agent unticked but not in a ticked squad is left out", () => {
  const c = cfg0();
  const sel = toggle(c, allTicked(c), "agent", "qa");
  const d = JSON.parse(exportView(c, sel, expCtx).file);
  assert.deepEqual(d.agents.map((a) => a.id), ["scout", "wrangler"]);
});

// ---- import

test("rowOptions: what a person may choose per row", () => {
  const p = previewImport(cfg0(), file([fa("fresh"), fa("scout", { command: "claude --model x" }), fa("qa", { name: "QA" }), fa("bad id")]), ctxOf(), {});
  const by = (id) => p.rows.find((r) => r.id === id || r.key.endsWith(id));
  assert.deepEqual(rowOptions(by("fresh")).map((o) => o.action), ["add", "skip"]);
  assert.deepEqual(rowOptions(by("scout")).map((o) => o.action), ["keep", "copy", "overwrite"]);
  assert.deepEqual(rowOptions(by("qa")), [], "identical: skipped, nothing to choose");
  assert.deepEqual(rowOptions(p.rows.find((r) => r.action === "blocked")), []);
});

test("previewImport: rows carry the full command and instructions, defaults are add and keep mine", () => {
  const long = "x".repeat(900);
  const p = previewImport(cfg0(), file([fa("fresh", { instructions: long }), fa("scout", { command: "claude --model other" })]), ctxOf(), {});
  assert.equal(p.ok, true);
  const fresh = p.rows.find((r) => r.id === "fresh");
  assert.equal(fresh.action, "add");
  assert.equal(fresh.instructions, long, "never truncated");
  assert.equal(fresh.command, CMD);
  const scout = p.rows.find((r) => r.id === "scout");
  assert.equal(scout.action, "keep");
  assert.equal(scout.command, "claude --model other");
  assert.ok(scout.warnings.some((w) => /command/i.test(w)));
  assert.equal(p.canApply, true, "the add writes");
});

test("previewImport: canApply is true when a row writes and false when none does", () => {
  assert.equal(previewImport(cfg0(), file([fa("fresh")]), ctxOf(), {}).canApply, true);
  assert.equal(previewImport(cfg0(), file([fa("qa", { name: "QA" })]), ctxOf(), {}).canApply, false);
  assert.equal(previewImport(cfg0(), file([fa("scout", { command: "claude --model other" })]), ctxOf(), {}).canApply, false, "keep mine writes nothing");
});

test("previewImport: a bad file gives errors, no rows, no apply", () => {
  const p = previewImport(cfg0(), "not json", ctxOf(), {});
  assert.equal(p.ok, false);
  assert.ok(p.errors.length);
  assert.equal(p.canApply, false);
});

test("previewImport: envIds that failed to read stop the preview with the reason", () => {
  const p = previewImport(cfg0(), file([fa("fresh")]), ctxOf({ envIds: { error: "EACCES" } }), {});
  assert.equal(p.ok, false);
  assert.match(p.errors[0], /environment/i);
});

test("toChoices: ui picks map to plan choices, junk is dropped, acks only ride with their action", () => {
  const ui = { "agent:scout": { action: "overwrite", ackEnv: true }, "agent:x": { action: "bogus" }, "squad:s": { action: "copy", ackSoul: true }, "other:y": { action: "copy" } };
  assert.deepEqual(toChoices(ui), { "agent:scout": { action: "overwrite", ackEnv: true }, "squad:s": { action: "copy", ackSoul: true } });
  assert.deepEqual(toChoices(undefined), {});
});

test("overwrite of an agent with an env file needs the tick, and the row says why", () => {
  const f = file([fa("scout", { command: "claude --model other" })]);
  const ctx = ctxOf({ envIds: new Set(["scout"]) });
  let p = previewImport(cfg0(), f, ctx, { "agent:scout": { action: "overwrite" } });
  const r = p.rows[0];
  assert.deepEqual(r.acks.map((a) => a.kind), ["env"]);
  assert.equal(r.acks[0].ticked, false);
  assert.match(r.acks[0].text, /GH_TOKEN/, "names only");
  assert.equal(p.canApply, false, "a held row writes nothing");
  p = previewImport(cfg0(), f, ctx, { "agent:scout": { action: "overwrite", ackEnv: true } });
  assert.equal(p.rows[0].acks[0].ticked, true);
  assert.equal(p.canApply, true);
});

test("a dropped soul needs its own tick before the agent is added", () => {
  const f = file([fa("fresh", { soul: "ghost" })]);
  let p = previewImport(cfg0(), f, ctxOf(), {});
  assert.deepEqual(p.rows[0].acks.map((a) => a.kind), ["soul"]);
  assert.equal(p.canApply, false);
  p = previewImport(cfg0(), f, ctxOf(), { "agent:fresh": { action: "add", ackSoul: true } });
  assert.equal(p.canApply, true);
});

test("blocked rows show reasons (rule names, never values) and the text of the file is not echoed", () => {
  const secret = "gh" + "p_" + "B".repeat(30);
  const p = previewImport(cfg0(), file([fa("evil", { instructions: secret })]), ctxOf(), {});
  const r = p.rows[0];
  assert.equal(r.action, "blocked");
  assert.deepEqual(r.blocked, ["instructions · github-token"]);
  assert.ok(!JSON.stringify(p.rows).includes(secret));
});

test("an environment file with no agent blocks the row with its message", () => {
  const p = previewImport(cfg0(), file([fa("fresh")]), ctxOf({ envIds: new Set(["fresh"]) }), {});
  assert.equal(p.rows[0].action, "blocked");
  assert.match(p.rows[0].blocked[0], /environment file already exists/);
});

test("applyImport: one config back, the message says agents start with no environment", () => {
  const c = cfg0();
  const f = file([fa("fresh")], [{ id: "s2", name: "S2", leader: "fresh", members: [] }]);
  const p = previewImport(c, f, ctxOf(), {});
  const r = applyImport(c, p.plan, ctxOf());
  assert.ok(r.config);
  assert.deepEqual(r.config.agents.map((a) => a.id), ["scout", "wrangler", "qa", "fresh"]);
  assert.match(r.message, /Added 1 agent and 1 squad/);
  assert.match(r.message, /no environment/);
});

test("applyImport: the config changed after the preview -> stale, no config, a message to preview again", () => {
  const c = cfg0();
  const p = previewImport(c, file([fa("fresh")]), ctxOf(), {});
  const changed = { ...c, agents: [...c.agents, agent("other")] };
  const r = applyImport(changed, p.plan, ctxOf());
  assert.equal(r.config, undefined);
  assert.equal(r.stale, true);
  assert.match(r.message, /changed since the preview/i);
});

test("applyImport: applying one plan twice does not add twice", () => {
  const c = cfg0();
  const p = previewImport(c, file([fa("fresh")]), ctxOf(), {});
  const first = applyImport(c, p.plan, ctxOf());
  const second = applyImport(first.config, p.plan, ctxOf());
  assert.equal(second.config, undefined);
  assert.equal(second.stale, true);
});

test("applyImport: held rows are reported, an apply with nothing to write says so", () => {
  const c = cfg0();
  const p = previewImport(c, file([fa("fresh", { soul: "ghost" })]), ctxOf(), {});
  const r = applyImport(c, p.plan, ctxOf());
  assert.equal(r.config, undefined);
  assert.match(r.message, /Nothing to apply/);
});

test("applyImport: an apply error passes through and writes nothing", () => {
  const r = applyImport(cfg0(), null, ctxOf());
  assert.equal(r.config, undefined);
  assert.ok(r.message);
});

test("candidateIds: the ids whose env files the plan must check (file ids, config ids, copy ids of clashes); never more than a cap", () => {
  const c = cfg0();
  const ids = candidateIds(c, file([fa("scout"), fa("fresh")]));
  assert.ok(ids.includes("scout") && ids.includes("fresh") && ids.includes("qa"));
  assert.ok(ids.includes("scout-2") && ids.includes("scout-9"), "copy ids of a clash");
  assert.ok(!ids.includes("fresh-2"), "no clash, no copy ids");
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(candidateIds(c, "not json"), c.agents.map((a) => a.id), "a bad file: just the config ids");
  const many = file(Array.from({ length: 300 }, (_, i) => fa(`a${i}`)));
  assert.ok(candidateIds(c, many).length <= 1000);
});

test("soulNames: the soul names to hash, only valid ones, from the config and the file", () => {
  const names = soulNames(cfg0(), file([fa("x", { soul: "ghost" }), fa("y", { soul: "../etc/passwd" }), fa("z", { soul: "Bad Name" })]));
  assert.deepEqual(names.sort(), ["ghost", "scout"]);
});

// ---- review round 1

const reader = (present, log = []) => async (ids) => { log.push(...ids); return new Set(ids.filter((i) => present.has(i))); };

test("settleFacts: a copy id past -9 is checked before it is accepted (orphan scout-10 is never used)", async () => {
  const c = cfg0();
  for (let n = 2; n <= 9; n++) c.agents.push(agent(`scout-${n}`));
  const f = file([fa("scout", { name: "SCOUT", soul: "scout", command: "claude --model other" })]);
  const present = new Set(["scout-10"]);
  const log = [];
  const ctx = await settleFacts(c, f, { localSouls: { scout: H }, supported: 1 }, { "agent:scout": { action: "copy" } }, reader(present, log));
  const p = previewImport(c, f, ctx, { "agent:scout": { action: "copy" } });
  assert.notEqual(p.rows[0].newId, "scout-10");
  assert.equal(p.rows[0].newId, "scout-11");
  assert.ok(log.includes("scout-10") && log.includes("scout-11"), "every allocated destination was read");
  assert.ok(ctx.envIds.has("scout-10"));
});

test("settleFacts: more than 1000 candidates still check every id the plan writes", async () => {
  const c = cfg0();
  const many = Array.from({ length: 200 }, (_, i) => fa(`bulk${i}`));
  const present = new Set(["bulk199"]);
  const ctx = await settleFacts(c, file(many), { localSouls: {}, supported: 1 }, {}, reader(present));
  const p = previewImport(c, file(many), ctx, {});
  assert.equal(p.rows.find((r) => r.id === "bulk199").action, "blocked");
});

test("settleFacts: a failed read gives the error shape the plan refuses", async () => {
  const ctx = await settleFacts(cfg0(), file([fa("fresh")]), { localSouls: {}, supported: 1 }, {}, async () => ({ error: "EACCES" }));
  assert.equal(previewImport(cfg0(), file([fa("fresh")]), ctx, {}).ok, false);
});

test("labelOf: a secret-shaped name is hidden, an ordinary one is kept", () => {
  const secret = "gh" + "p_" + "D".repeat(30);
  assert.equal(labelOf(secret).includes(secret), false);
  assert.match(labelOf(secret), /hidden/);
  assert.equal(labelOf("Scout"), "Scout");
});

test("exportView: blocked lines and warnings never carry a secret-shaped id", () => {
  const secret = "gh" + "p_" + "E".repeat(30);
  const c = cfg0();
  c.agents.push(agent(secret, { instructions: "see /home/u/x" }));
  const v = exportView(c, allTicked(c), expCtx);
  assert.equal(v.ok, false, "a secret-shaped id now blocks (it used to export)");
  assert.ok(!JSON.stringify(v).includes(secret));
});

// ---- review round 2: ids and references are scanned too

const TOKEN = "gh" + "p_" + "H".repeat(30);
test("exportView: a secret-shaped agent id blocks the export, no file, redacted diagnostics", () => {
  const c = cfg0();
  c.agents.push(agent(TOKEN));
  const v = exportView(c, allTicked(c), expCtx);
  assert.equal(v.ok, false);
  assert.equal(v.file, undefined);
  assert.deepEqual(v.blocked, ["(hidden: looks like a secret) · id · github-token"]);
  assert.ok(!JSON.stringify(v).includes(TOKEN));
});

test("exportView: a secret-shaped squad id, leader or member reference blocks the export", () => {
  for (const mk of [
    (c) => { c.squads.push({ id: TOKEN, name: "S", leader: "scout", members: [], version: 1 }); },
    (c) => { c.agents.push(agent(TOKEN)); c.squads[0].leader = TOKEN; },
    (c) => { c.agents.push(agent(TOKEN)); c.squads[0].members.push({ agent: TOKEN, role: "x" }); },
  ]) {
    const c = cfg0();
    mk(c);
    const v = exportView(c, allTicked(c), expCtx);
    assert.equal(v.ok, false);
    assert.equal(v.file, undefined);
    assert.ok(!JSON.stringify(v).includes(TOKEN));
  }
});

test("previewImport: a secret-shaped id, leader or member reference blocks its row and is never echoed", () => {
  const f = file([fa(TOKEN), fa("fine")], [{ id: "sq", name: "S", leader: "fine", members: [{ agent: TOKEN, role: "" }] }, { id: TOKEN.replace("H", "I"), name: "T", leader: "fine", members: [] }]);
  const p = previewImport(cfg0(), f, ctxOf(), {});
  assert.equal(p.rows.filter((r) => r.action === "blocked").length, 3);
  assert.equal(p.rows.find((r) => r.id === "fine").action, "add");
  assert.ok(!JSON.stringify(p.rows).includes("H".repeat(30)));
  assert.ok(!JSON.stringify(p.rows).includes("I".repeat(10) + "H"));
});

// ---- job 4

test("exportView: passes the home so the file carries ~, and shows the local-path warning as a line", () => {
  const c = cfg0();
  c.agents[2].instructions = "read /Us" + "ers/me/notes/a.md";
  const v = exportView(c, allTicked(c), { ...expCtx, home: "/Us" + "ers/me" });
  assert.ok(v.ok);
  assert.ok(JSON.parse(v.file).agents[2].instructions.startsWith("read ~/notes"));
  assert.ok(v.warnings.some((w) => /qa/.test(w) && /local file/i.test(w)));
  assert.ok(!v.warnings.some((w) => /home folder/.test(w)));
});

test("previewImport: the local-path warning is a row warning", () => {
  const p = previewImport(cfg0(), file([fa("fresh", { instructions: "open ~/x/y" })]), ctxOf(), {});
  assert.ok(p.rows[0].warnings.some((w) => /local file/i.test(w)));
});
