// Squads screen: the Share section and the Export and Import dialogs (wiring: facts read, nothing written before Apply, one setShared).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], readTextFile: async () => null, exec: async () => ({ code: 0, stdout: "", stderr: "" }), appHome: "/h", home: "/home/u" };
const C = await import("../_lib/config.js");
const { default: Agents } = await import("../drover-agents/main.js");
const { sha256 } = await import("../_lib/herd-export.js");
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);

const AGENTS = "drover.agents";
const CMD = "claude --model claude-sonnet-5-5";
const SOUL = "# scout", HERD = "# herd";
const a = (id, extra = {}) => ({ id, name: id.toUpperCase(), command: CMD, instructions: "", version: 1, ...extra });
const cfg0 = () => ({ agents: [a("scout", { soul: "scout" }), a("wrangler")], squads: [{ id: "drive", name: "Drive", leader: "scout", members: [{ agent: "wrangler", role: "code" }], version: 1 }] });
const file = (agents, squads = []) => JSON.stringify({ format: "drover-herdr.agents", version: 1, exported: "2026-11-16T00:00:00.000Z", app: "", agents, squads });

let host, sets, writes, clips, files;
const find = (n, id) => (n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean) ?? null);
const mkcx = () => { const cx = { notify() {}, stop_propagation() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)), timer: { every() {} }, write_to_clipboard: (s) => clips.push(s) }; return cx; };
const render = (v) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [], inputs: [] };
  const root = v.render(mkcx());
  const r = globalThis.__rec; globalThis.__rec = null;
  return { ...r, root: root[NODE] };
};
const click = (v, id) => { const n = find(render(v).root, id); assert.ok(n, `no ${id}`); n.args.on_click?.[0](null, mkcx()); };

beforeEach(() => {
  C.resetCache();
  sets = []; writes = []; clips = []; files = { "/h/mods/drover-agents/souls/scout.md": SOUL, "/h/mods/drover-agents/souls/_herd.md": HERD };
  host = globalThis.__host = {
    props: {}, state: { [AGENTS]: cfg0() }, notified: [], appHome: "/h", home: "/home/u",
    readTextFile: async (p) => files[p] ?? null,
    writeTextFile: async (p, text, expected) => { if ((files[p] ?? null) !== expected) throw Object.assign(new Error("stale"), { code: "ESTALE" }); files[p] = text; writes.push(p); return null; },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    closeOverlay() {}, openOverlay(o) { (host.opened ??= []).push(o); },
  };
});

const open = async (props) => {
  host.props = { overlay: "o", ...props };
  const v = new Agents();
  const cx = mkcx();
  v.init({}, cx);
  if (v.dialog.load) await v.dialog.load();
  return v;
};
const typeInto = (state, text) => { state.set_value(text); };

test("the Squads screen has a Share section whose buttons open the two dialogs", async () => {
  host.props = {};
  C.resetCache();
  const v = new Agents();
  v.init({}, mkcx());
  await until(() => C.ready("drover-agents"), "config loaded");
  const r = render(v);
  const ex = find(r.root, "export"), im = find(r.root, "import");
  assert.ok(ex && im, "Export and Import buttons");
  ex.args.on_click[0](null, mkcx());
  im.args.on_click[0](null, mkcx());
  assert.deepEqual(host.opened.map((o) => [o.kind, o.props]), [["dialog", { export: true }], ["dialog", { import: true }]]);
});

test("Export: copies the full file, never reads an env file, and Save writes under the exports folder with the folder helper", async () => {
  const reads = [];
  const base = host.readTextFile;
  host.readTextFile = async (p) => { reads.push(p); return base(p); };
  const execs = [];
  host.exec = async (...x) => { execs.push(x); return { code: 0, stdout: "", stderr: "" }; };
  const v = await open({ export: true });
  assert.ok(render(v).texts.some((t) => /No secret-shaped text/.test(t)));
  click(v, "copy");
  assert.equal(clips.length, 1);
  const d = JSON.parse(clips[0]);
  assert.deepEqual(d.agents.map((x) => x.id), ["scout", "wrangler"]);
  assert.equal(d.agents[0].soulHash, sha256(SOUL + "\n" + HERD), "the soul hash is the installed files, as the CLI computes it");
  click(v, "save");
  await until(() => writes.length === 1, "saved");
  assert.match(writes[0], /^\/home\/u\/\.config\/drover-herdr\/exports\/drover-herdr-agents-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(files[writes[0]], clips[0], "the saved text is the copied text");
  assert.deepEqual(execs[0][1].slice(0, 2), ["ensure", "/home/u/.config/drover-herdr/exports"]);
  assert.ok(execs[0][1].includes("--root"));
  assert.ok(!reads.some((p) => /\/agents\/[^/]+\.json$/.test(p)), "export never opens an env file");
  await until(() => render(v).texts.some((t) => t.startsWith("Saved /home/u/")), "the path is shown");
});

test("Export: a secret blocks Copy and Save, and the screen names id, field and rule but not the value", async () => {
  const secret = "gh" + "p_" + "C".repeat(30);
  host.state[AGENTS].agents[1].instructions = `token ${secret}`;
  const v = await open({ export: true });
  const r = render(v);
  assert.ok(r.texts.includes("• wrangler · instructions · github-token"));
  assert.ok(!r.texts.join("\n").includes(secret));
  click(v, "copy");
  click(v, "save");
  await new Promise((res) => setImmediate(res));
  assert.equal(clips.length, 0);
  assert.equal(writes.length, 0);
});

test("Export: unticking an agent in no squad leaves it out; a squad's agents are locked", async () => {
  host.state[AGENTS].agents.push(a("qa"));
  const v = await open({ export: true });
  click(v, "xa-scout"); // locked by the Drive squad
  click(v, "xa-qa");
  click(v, "copy");
  assert.deepEqual(JSON.parse(clips[0]).agents.map((x) => x.id), ["scout", "wrangler"]);
});

test("Import: Preview reads facts, shows the rows, and writes nothing; Apply makes one setShared and says agents start with no environment", async () => {
  const v = await open({ import: true });
  const d = v.dialog;
  typeInto(d.text, file([a("fresh", { version: undefined })].map(({ version, ...x }) => x)));
  click(v, "preview");
  await until(() => d.view?.ok, "previewed");
  assert.equal(d.view.rows.length, 1);
  assert.equal(host.state[AGENTS].agents.length, 2, "nothing written by a preview");
  const before = host.state[AGENTS];
  click(v, "apply");
  await until(() => d.result, "applied");
  assert.notEqual(host.state[AGENTS], before);
  assert.deepEqual(host.state[AGENTS].agents.map((x) => x.id), ["scout", "wrangler", "fresh"]);
  assert.match(d.result, /no environment/);
});

test("Import: a path is read with the host reader; a bad path is an error, not a crash", async () => {
  files["/home/u/x.json"] = file([{ id: "fresh", name: "F", command: CMD, instructions: "" }]);
  const v = await open({ import: true });
  const d = v.dialog;
  typeInto(d.path, "~/x.json");
  click(v, "preview");
  await until(() => d.view?.ok, "previewed from the path");
  typeInto(d.path, "relative.json");
  click(v, "preview");
  await until(() => d.error, "path error");
  assert.match(d.error, /absolute/);
  assert.equal(d.view, null);
});

test("Import: an env file that cannot be read stops the preview; the plan is never made with a guess", async () => {
  const base = host.readTextFile;
  host.readTextFile = async (p) => { if (/\/agents\//.test(p)) throw Object.assign(new Error("x"), { code: "EACCES" }); return base(p); };
  const v = await open({ import: true });
  typeInto(v.dialog.text, file([{ id: "fresh", name: "F", command: CMD, instructions: "" }]));
  click(v, "preview");
  await until(() => v.dialog.view, "view");
  assert.equal(v.dialog.view.ok, false);
  assert.match(v.dialog.view.errors[0], /environment/i);
  click(v, "apply");
  await new Promise((r) => setImmediate(r));
  assert.equal(host.state[AGENTS].agents.length, 2);
});

test("Import: the config changing between Preview and Apply refuses the stale plan and previews again; nothing is applied", async () => {
  const v = await open({ import: true });
  const d = v.dialog;
  typeInto(d.text, file([{ id: "fresh", name: "F", command: CMD, instructions: "" }]));
  click(v, "preview");
  await until(() => d.view?.ok, "previewed");
  host.state[AGENTS] = { ...host.state[AGENTS], agents: [...host.state[AGENTS].agents, a("other")] }; // another dialog saved
  click(v, "apply");
  await until(() => /changed since the preview/i.test(d.error ?? "") && d.view?.ok && !d.busy, "stale message and a fresh preview");
  assert.deepEqual(host.state[AGENTS].agents.map((x) => x.id), ["scout", "wrangler", "other"], "only the other edit is there");
  click(v, "apply");
  await until(() => d.result, "the fresh plan applies");
  assert.deepEqual(host.state[AGENTS].agents.map((x) => x.id), ["scout", "wrangler", "other", "fresh"]);
});

test("Import: overwrite of an agent with an env file stays held until its tick; ticking it lets Apply run", async () => {
  files["/home/u/.config/drover-herdr/agents/scout.json"] = "{}";
  const v = await open({ import: true });
  const d = v.dialog;
  typeInto(d.text, file([{ id: "scout", name: "SCOUT", soul: "scout", command: "claude --model other", instructions: "" }]));
  click(v, "preview");
  await until(() => d.view?.ok, "previewed");
  click(v, "agent:scout-overwrite");
  await until(() => !d.busy, "settled");
  assert.equal(d.view.canApply, false);
  click(v, "agent:scout-ack-env");
  await until(() => !d.busy, "settled");
  assert.equal(d.view.canApply, true);
  click(v, "apply");
  await until(() => d.result, "applied");
  assert.equal(host.state[AGENTS].agents[0].command, "claude --model other");
  assert.equal(host.state[AGENTS].agents[0].version, 2);
});

// ---- review round 1

test("Import: row choices are frozen while Apply is reading its facts; the confirmed plan is what applies", async () => {
  const v = await open({ import: true });
  const d = v.dialog;
  typeInto(d.text, file([{ id: "fresh", name: "F", command: CMD, instructions: "" }, { id: "scout", name: "SCOUT", soul: "scout", command: "claude --model other", instructions: "" }]));
  click(v, "preview");
  await until(() => d.view?.ok, "previewed");
  assert.equal(d.view.rows.find((r) => r.id === "scout").action, "keep");
  let release;
  const gate = new Promise((r) => { release = r; });
  const base = host.readTextFile;
  host.readTextFile = async (p) => { await gate; return base(p); };
  click(v, "apply");
  click(v, "agent:scout-overwrite"); // while busy
  release();
  await until(() => d.result, "applied");
  assert.equal(host.state[AGENTS].agents.find((x) => x.id === "scout").command, CMD, "scout was kept, as confirmed");
  assert.ok(host.state[AGENTS].agents.some((x) => x.id === "fresh"));
});

test("Import: an orphan env file on copy id scout-10 is never adopted through the dialog", async () => {
  for (let n = 2; n <= 9; n++) host.state[AGENTS].agents.push(a(`scout-${n}`));
  files["/home/u/.config/drover-herdr/agents/scout-10.json"] = "{}";
  const v = await open({ import: true });
  const d = v.dialog;
  typeInto(d.text, file([{ id: "scout", name: "SCOUT", soul: "scout", command: "claude --model other", instructions: "" }]));
  click(v, "preview");
  await until(() => d.view?.ok, "previewed");
  click(v, "agent:scout-copy");
  await until(() => !d.busy, "settled");
  assert.equal(d.view.rows[0].newId, "scout-11");
  click(v, "apply");
  await until(() => d.result, "applied");
  assert.ok(host.state[AGENTS].agents.some((x) => x.id === "scout-11"));
  assert.ok(!host.state[AGENTS].agents.some((x) => x.id === "scout-10"));
});

test("Export: a secret-shaped agent or squad name is never drawn in the checklist, before or after the souls load", async () => {
  const secret = "gh" + "p_" + "F".repeat(30), secret2 = "gh" + "p_" + "G".repeat(30);
  host.state[AGENTS].agents[1].name = secret;
  host.state[AGENTS].squads[0].name = secret2;
  host.props = { overlay: "o", export: true };
  const v = new Agents();
  v.init({}, mkcx());
  assert.ok(!render(v).texts.join("\n").includes(secret), "while loading");
  await v.dialog.load();
  const t = render(v).texts.join("\n");
  assert.ok(!t.includes(secret) && !t.includes(secret2), "after loading");
});

test("Import: every line of long instructions can be reviewed before Apply (show more)", async () => {
  const long = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  const v = await open({ import: true });
  const d = v.dialog;
  typeInto(d.text, file([{ id: "fresh", name: "F", command: CMD, instructions: long }]));
  click(v, "preview");
  await until(() => d.view?.ok, "previewed");
  assert.ok(!render(v).texts.includes("line 2099"));
  click(v, "agent:fresh-ins-more");
  assert.ok(render(v).texts.includes("line 2099"), "the tail is reachable");
});

test("Export: a secret-shaped agent id blocks the whole boundary: no JSON drawn, Copy and Save refuse, nothing on screen", async () => {
  const token = "gh" + "p_" + "J".repeat(30);
  host.state[AGENTS].agents.push(a(token));
  const v = await open({ export: true });
  const r = render(v);
  assert.equal(v.dialog.view().ok, false);
  assert.ok(!r.texts.join("\n").includes(token), "not on screen");
  assert.ok(!r.ids.includes("export-text"), "no preview box");
  click(v, "copy");
  click(v, "save");
  await new Promise((res) => setImmediate(res));
  assert.equal(clips.length, 0);
  assert.equal(writes.length, 0);
});

test("Export: the dialog passes the host home: its path becomes ~ in the copied file", async () => {
  host.state[AGENTS].agents[1].instructions = "read /home/u/notes/a.md";
  const v = await open({ export: true });
  click(v, "copy");
  assert.equal(JSON.parse(clips[0]).agents[1].instructions, "read ~/notes/a.md");
  assert.ok(render(v).texts.some((t) => /wrangler · instructions: names a local file/.test(t)));
});

test("Import: a ~ command from a friend is stored with this machine's absolute home; instructions keep ~", async () => {
  const v = await open({ import: true });
  const d = v.dialog;
  typeInto(d.text, file([{ id: "fresh", name: "F", command: "~/.local/bin/claude --add-dir ~/notes", instructions: "read ~/notes" }]));
  click(v, "preview");
  await until(() => d.view?.ok, "previewed");
  assert.equal(d.view.rows[0].command, "/home/u/.local/bin/claude --add-dir /home/u/notes", "the preview shows what will run");
  click(v, "apply");
  await until(() => d.result, "applied");
  const f = host.state[AGENTS].agents.find((x) => x.id === "fresh");
  assert.equal(f.command, "/home/u/.local/bin/claude --add-dir /home/u/notes");
  assert.equal(f.instructions, "read ~/notes");
});
