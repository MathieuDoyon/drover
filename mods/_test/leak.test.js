// C7: canary leak suite (scope.md section 6, "Canary leak protocol"). Fake canary values only, no network, a disposable HOME and appHome.
// 1. The canaries live in a fixture file OUTSIDE the capture tree.  2. A flow runs and each surface is captured to a file.
// 3. The scanner looks for each canary raw, JSON-escaped, URL-encoded and base64 (3 alignments, plain and url-safe).
// 4. The report holds surface, count and PASS / FAIL / NOT PROVEN, never a value.  5. The positive control fails first;
//    a capture that cannot be read (or is empty, or missing) is NOT PROVEN, never a pass.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, statSync, symlinkSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// ---- the fixture: canaries outside the capture tree. Odd characters on purpose, so each form differs from the raw one.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "leak-fixture-"));
const FIXTURE = join(FIXTURE_DIR, "canaries.json");
writeFileSync(FIXTURE, JSON.stringify({
  token: 'CANARY-fake-leak-a1"q\\z&k=v w+/-not-a-secret',
  other: "CANARY-fake-leak-b2-é?#%-not-a-secret",
}), { mode: 0o600 });
const CANARIES = JSON.parse(readFileSync(FIXTURE, "utf8"));

// ---- the scanner
const b64 = (buf) => buf.toString("base64");
const b64url = (buf) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_");
// The base64 of a value inside a longer string depends on the offset (mod 3): the stable middle of each of the 3 alignments.
function base64Needles(value, enc) {
  const v = Buffer.from(value, "utf8"), out = [];
  for (let k = 0; k < 3; k++) {
    const s = enc(Buffer.concat([Buffer.alloc(k), v])).replace(/=+$/, "");
    const skip = [0, 2, 3][k]; // chars that also encode the k padding bytes
    out.push(s.slice(skip, (k + v.length) % 3 ? -1 : undefined)); // the last char is partial unless the length is a multiple of 3
  }
  return out;
}
export function formsOf(value) {
  if (typeof value !== "string" || value.length < 8) throw new Error("a canary needs 8+ characters");
  const json = JSON.stringify(value).slice(1, -1);
  const u4 = (c, up) => { const h = c.charCodeAt(0).toString(16).padStart(4, "0"); return "\\u" + (up ? h.toUpperCase() : h); };
  const url = encodeURIComponent(value);
  const forms = [["raw", value], ["json", json], ["url", url], ["url-plus", url.replace(/%20/g, "+")],
    ["url-lower", url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
    ["url-lower-plus", url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()).replace(/%20/g, "+")],
    // JSON writers that escape non-ASCII (or everything) as \uXXXX, lower or upper hex
    ...[false, true].flatMap((up) => [[`json-u${up ? "U" : "l"}-ascii`, json.replace(/[^\x00-\x7f]/g, (c) => u4(c, up))],
      [`json-u${up ? "U" : "l"}-all`, [...value].map((c) => (c.charCodeAt(0) > 0xffff ? c : u4(c, up))).join("")]])];
  base64Needles(value, b64).forEach((n, i) => forms.push([`base64+${i}`, n]));
  base64Needles(value, b64url).forEach((n, i) => forms.push([`base64url+${i}`, n]));
  return forms.filter(([, n]) => n.length >= 6).map(([form, n]) => ({ form, needle: Buffer.from(n, "utf8") }));
}
function countIn(buf, needle) {
  let n = 0, at = buf.indexOf(needle);
  while (at !== -1) { n++; at = buf.indexOf(needle, at + 1); }
  return n;
}
// Every file under dir: [{ rel, buf }] or [{ rel, err }] for a file that cannot be read. A folder that cannot be listed throws.
function filesUnder(dir, root = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, root));
    else { try { out.push({ rel: relative(root, p), buf: readFileSync(p) }); } catch (e) { out.push({ rel: relative(root, p), err: codeOf(e) }); } }
  }
  return out;
}
const surfaceOf = (rel) => rel.split("/")[0].replace(/\.[^.]*$/, "");
// The report only ever shows ids from the caller's allowlist (`expected`); any other surface is "surface-<n>", so a file name never gets echoed.
const codeOf = (e) => (typeof e?.code === "string" && /^[A-Z0-9_]{2,20}$/.test(e.code) ? e.code : "Error");

// scan(captureDir, canaries, expected) -> [{ surface, status: PASS|FAIL|NOT PROVEN, count, files, hits?, reason? }].
// hits names the canary label and the form, never the value. A surface in `expected` with no capture is NOT PROVEN.
export function scan(captureDir, canaries, expected = []) {
  const needles = Object.entries(canaries).flatMap(([label, v]) => formsOf(v).map((f) => ({ label, ...f })));
  const bySurface = new Map(expected.map((s) => [s, { files: [], reason: "nothing captured" }]));
  let files = [];
  try { files = filesUnder(captureDir); }
  catch (e) { return expected.map((surface) => ({ surface, status: "NOT PROVEN", count: 0, files: 0, reason: `capture unreadable (${codeOf(e)})` })); }
  for (const f of files) {
    const s = surfaceOf(f.rel);
    if (!bySurface.has(s)) bySurface.set(s, { files: [] });
    bySurface.get(s).files.push(f);
  }
  const results = [];
  let other = 0;
  for (const [name, { files: fs, reason }] of bySurface) {
    const surface = expected.includes(name) ? name : `surface-${++other}`;
    const bad = fs.find((f) => f.err);
    if (bad) { results.push({ surface, status: "NOT PROVEN", count: 0, files: fs.length, reason: `capture unreadable (${bad.err})` }); continue; }
    if (!fs.length) { results.push({ surface, status: "NOT PROVEN", count: 0, files: 0, reason }); continue; }
    if (fs.every((f) => f.buf.length === 0)) { results.push({ surface, status: "NOT PROVEN", count: 0, files: fs.length, reason: "capture is empty" }); continue; }
    let count = 0;
    const hits = [];
    for (const f of fs) {
      const hay = Buffer.concat([Buffer.from(f.rel), Buffer.from("\0"), f.buf]); // the file name is a surface too
      for (const n of needles) { const c = countIn(hay, n.needle); if (c) { count += c; hits.push(`${n.label}:${n.form}`); } }
    }
    results.push({ surface, status: count ? "FAIL" : "PASS", count, files: fs.length, ...(count ? { hits: [...new Set(hits)] } : {}) });
  }
  return results;
}
export const reportLine = (r) => `${r.status.padEnd(10)} ${r.surface} (files ${r.files}, matches ${r.count})${r.hits ? ` [${r.hits.join(", ")}]` : ""}${r.reason ? ` - ${r.reason}` : ""}`;

const capture = () => mkdtempSync(join(tmpdir(), "leak-capture-"));
const put = (dir, rel, text) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

// ---- 1. the positive control: a canary planted in each form MUST make the scanner FAIL. If this is red, no PASS below means anything.
test("positive control: a canary in each form, in each surface, makes the scanner FAIL", () => {
  const forms = formsOf(CANARIES.token);
  const kinds = new Set(forms.map((f) => f.form.replace(/\+\d$/, "")));
  assert.deepEqual([...kinds].sort(), ["base64", "base64url", "json", "json-uU-all", "json-uU-ascii", "json-ul-all", "json-ul-ascii", "raw", "url", "url-lower", "url-lower-plus", "url-plus"]);
  const dir = capture();
  const planted = {
    raw: CANARIES.token,
    json: JSON.stringify({ env: CANARIES.token }),
    url: `https://x.test/?t=${encodeURIComponent(CANARIES.token)}`,
    "url-plus": `t=${encodeURIComponent(CANARIES.token).replace(/%20/g, "+")}`,
    base64: `Authorization: Basic ${Buffer.from("user:" + CANARIES.token).toString("base64")}`,
    base64url: Buffer.from("xx" + CANARIES.token + "y").toString("base64url"),
    second: `second canary ${CANARIES.other}`,
  };
  for (const [name, text] of Object.entries(planted)) put(dir, `${name}.txt`, `before ${text} after`);
  const results = scan(dir, CANARIES);
  assert.equal(results.length, Object.keys(planted).length);
  for (const r of results) { assert.equal(r.status, "FAIL", `${r.surface} must FAIL`); assert.ok(r.count >= 1); }
  // every alignment of base64 is found (the value sits at offset 0, 1 and 2 of a longer string)
  for (const pad of ["", "x", "xy"]) {
    const d = capture();
    put(d, "s.txt", Buffer.from(pad + CANARIES.token + "tail").toString("base64"));
    assert.equal(scan(d, CANARIES)[0].status, "FAIL", `base64 at offset ${pad.length}`);
  }
});

// Independent controls: each planted form is written out by hand here, not built with the scanner's own helpers.
test("positive control: JSON with u-escapes (lower and upper hex, some or all characters) and lowercase percent hex FAIL", () => {
  const planted = {
    "json-u-lower": '{"v":"CANARY-fake-leak-b2-\\u00e9?#%-not-a-secret"}',
    "json-u-upper": '{"v":"CANARY-fake-leak-b2-\\u00E9?#%-not-a-secret"}',
    "json-u-all": `{"v":"${Array.from("CANARY-fake-leak-b2-\u00e9?#%-not-a-secret", (c) => "\\u" + ("0000" + c.codePointAt(0).toString(16)).slice(-4)).join("")}"}`,
    "json-u-all-upper": `{"v":"${Array.from("CANARY-fake-leak-b2-\u00e9?#%-not-a-secret", (c) => "\\u" + ("0000" + c.codePointAt(0).toString(16)).slice(-4).toUpperCase()).join("")}"}`,
    "json-u-token": `{"v":"${Array.from('CANARY-fake-leak-a1"q\\z&k=v w+/-not-a-secret', (c) => "\\u" + ("0000" + c.codePointAt(0).toString(16)).slice(-4)).join("")}"}`,
    "url-lower": "t=CANARY-fake-leak-a1%22q%5cz%26k%3dv%20w%2b%2f-not-a-secret",
    "url-lower-plus": "t=CANARY-fake-leak-a1%22q%5cz%26k%3dv+w%2b%2f-not-a-secret",
    "url-lower-other": "t=CANARY-fake-leak-b2-%c3%a9%3f%23%25-not-a-secret",
  };
  for (const [name, text] of Object.entries(planted)) {
    const d = capture();
    put(d, "s.txt", `before ${text} after`);
    assert.equal(scan(d, CANARIES)[0].status, "FAIL", name);
  }
});

test("positive control: a canary in a file NAME fails, and the report never echoes the name or the value", () => {
  const d = capture();
  put(d, `${CANARIES.other}.txt`, "clean text");
  put(d, "sub/" + CANARIES.token.replace(/[\\/"]/g, "_") + ".txt", "clean text");
  const results = scan(d, CANARIES, ["logs"]);
  const text = JSON.stringify(results) + results.map(reportLine).join("\n");
  assert.ok(results.some((r) => r.status === "FAIL"), "the name is scanned");
  for (const v of Object.values(CANARIES)) for (const f of formsOf(v)) assert.equal(text.includes(f.needle.toString()), false, "the report holds no name or value");
  assert.ok(!text.includes("CANARY"), "no file name appears in the report");
});

test("a clean capture passes, and the report never holds a value", () => {
  const dir = capture();
  put(dir, "screen.json", JSON.stringify({ texts: ["set", "GH_TOKEN"] }));
  put(dir, "logs.txt", "drover-agents env: read failed: EACCES\n");
  const results = scan(dir, CANARIES);
  assert.deepEqual(results.map((r) => r.status), ["PASS", "PASS"]);
  const leaky = capture();
  put(leaky, "logs.txt", `oops ${CANARIES.token} ${CANARIES.other}`);
  const text = JSON.stringify(scan(leaky, CANARIES)) + scan(leaky, CANARIES).map(reportLine).join("\n");
  for (const v of Object.values(CANARIES)) for (const f of formsOf(v)) assert.equal(text.includes(f.needle.toString()), false, "the report must not hold the value");
  assert.match(text, /FAIL/);
});

test("unreadable, missing or empty capture is NOT PROVEN, never a pass", { skip: process.getuid?.() === 0 }, () => {
  const dir = capture();
  put(dir, "logs.txt", "clean text");
  put(dir, "locked.txt", "clean text");
  put(dir, "empty.txt", "");
  chmodSync(join(dir, "locked.txt"), 0o000);
  const got = Object.fromEntries(scan(dir, CANARIES, ["logs", "missing"]).map((r) => [r.surface, r.status]));
  assert.deepEqual(got, { logs: "PASS", missing: "NOT PROVEN", "surface-1": "NOT PROVEN", "surface-2": "NOT PROVEN" }, "file names never become report ids");
  chmodSync(join(dir, "locked.txt"), 0o600);
  // a folder that cannot be listed: every expected surface is NOT PROVEN
  const sub = join(dir, "sub");
  mkdirSync(sub);
  chmodSync(sub, 0o000);
  assert.equal(scan(dir, CANARIES, ["logs"]).every((r) => r.status === "NOT PROVEN"), true);
  chmodSync(sub, 0o700);
  assert.equal(scan(join(dir, "does-not-exist"), CANARIES, ["logs"])[0].status, "NOT PROVEN");
});

// ---- 2. the flows. A disposable HOME and appHome; the real helper (drover-env-write) and wrapper (drover-env) run for real,
// the Herdr host is a fake. Every surface is captured to <CAP>/<surface>.txt; the last test scans them all.
register("./hooks.js", import.meta.url);
const HELPER = new URL("../drover-agents/bin/drover-env-write", import.meta.url).pathname;
const WRAPPER = new URL("../drover-agents/bin/drover-env", import.meta.url).pathname;
const CAP = capture();
const app = mkdtempSync(join(tmpdir(), "leak-app-"));
const home = mkdtempSync(join(tmpdir(), "leak-home-"));
const cfg = `${home}/.config/drover-herdr`;
const envFile = (id = "w1") => `${cfg}/agents/${id}.json`;
const note = (surface, text) => appendFileSync(join(CAP, `${surface}.txt`), text.endsWith("\n") ? text : text + "\n");
const AGENTS = { agents: [
  { id: "lead", name: "Lead", command: "claude --model opus", soul: "", instructions: "", version: 1 },
  { id: "w1", name: "W1", command: "codex", soul: "", instructions: "", version: 1 },
], squads: [{ id: "s1", name: "Crew", version: 1, leader: "lead", members: [{ agent: "w1", role: "Inspector" }] }] };
const logs = [];
const origLog = console.log;
let host, calls, nextTerm = 0;
const tick = () => new Promise((r) => setImmediate(r));
const work = new Set(), errors = [];
const flush = async () => { while (work.size) await Promise.allSettled([...work]); await tick(); };
const liveCx = () => ({
  notify() {}, stop_propagation() {},
  spawn: (fn) => { const p = Promise.resolve().then(() => fn({ notify() {}, timer: { after() {} } })).catch((e) => errors.push(e)).finally(() => work.delete(p)); work.add(p); },
});
// Every setShared payload is captured at the write boundary (shared-state), not only the final value.
const sharedState = new Proxy({ "drover.agents": AGENTS, "drover.tasks": [{ id: "T-1", title: "Leak card", desc: "plain text", column: "todo", notes: [] }] },
  { set(t, k, v) { note("shared-state", `write ${String(k)} ${JSON.stringify(v)}`); t[k] = v; return true; } });
globalThis.__host = host = {
  appHome: app, home, props: { overlay: "ov" }, notified: [], closeCalls: [], state: sharedState,
  closeOverlay: () => host.closeCalls.push(1),
  fsGuard: (_op, p) => { if (!p.startsWith(app)) throw new Error("fs access denied"); },
  readTextFile: async (p) => { try { return readFileSync(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
  exec: async (cmd, args) => {
    if (cmd === "herdr-app") { calls.push([args[1], args.slice(2)]); return { code: 0, stdout: JSON.stringify({ terminal: `t${++nextTerm}` }) }; }
    if (cmd === `${app}/mods/drover-agents/bin/drover-workfolder`) return { code: 0, stdout: `${args[1]}\n` }; // default work folder is a global folder
    assert.equal(cmd, `${app}/mods/drover-agents/bin/drover-env-write`);
    host.before?.(args);
    const r = spawnSync(HELPER, args, { encoding: "utf8", env: { PATH: process.env.PATH } });
    note("env-write", `$ ${args[0]} exit=${r.status}\n--stdout--\n${r.stdout}\n--stderr--\n${r.stderr}`);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  },
};
calls = [];
const { default: Agents } = await import("../drover-agents/main.js");
const { launch } = await import("../_lib/io.js");

async function openAg(id) {
  host.props = { overlay: "ov", agent: id };
  const v = new Agents();
  v.init({}, liveCx());
  await flush();
  return v.dialog;
}
const setRow = (ed, name, value) => { const r = ed.addRow(); r.name.set_value(name); r.value.set_value(value); return r; };
const saveAg = async (ed) => { ed.save(liveCx()); await flush(); };
const w1 = () => host.state["drover.agents"].agents.find((a) => a.id === "w1");
// What the person sees: every text and id the editor draws, and the value of each input. While the person is typing, the input
// holds what they typed (that is the field working, masking it is the native UI's job: NOT PROVEN here), so those stages pass typed:true.
function screenOf(ed, { typed = false } = {}) {
  const rec = globalThis.__rec = { ids: [], texts: [], inputs: [] };
  try { ed.render({}); return JSON.stringify({ ids: rec.ids, texts: rec.texts, inputs: typed ? "(typed text not captured)" : rec.inputs.map((i) => i.value()), error: ed.error }); }
  finally { globalThis.__rec = undefined; }
}
// A step that must have really happened, so a PASS is never vacuous.
const did = (cond, what) => assert.ok(cond, `precondition: ${what}`);

test("flow: editor save, reopen, replace, a refused save and a delete (screen, env-write, logs, profile)", async () => {
  console.log = (...a) => logs.push(a.join(" "));
  try {
    let ed = await openAg("w1");
    setRow(ed, "GH_TOKEN", CANARIES.token); setRow(ed, "GH_CONFIG_DIR", "/fake/gh"); setRow(ed, "OTHER_KEY", CANARIES.other);
    note("screen", "# while typing"); note("screen", screenOf(ed, { typed: true }));
    await saveAg(ed);
    did(ed.error === null && readFileSync(envFile(), "utf8").includes("GH_TOKEN"), "the first save wrote the env file");
    ed = await openAg("w1");
    note("screen", "# reopened"); note("screen", screenOf(ed));
    ed.replaceRow(ed.rows.find((r) => r.nameText === "OTHER_KEY").key);
    ed.rows.find((r) => r.nameText === "OTHER_KEY").value.set_value(CANARIES.token);
    note("screen", "# replacing"); note("screen", screenOf(ed, { typed: true }));
    await saveAg(ed);
    // a refused save: the stage dir turns loose between prepare and commit; the helper fails closed and aborts
    const stage = `${app}/drover-env-stage`;
    ed = await openAg("w1");
    setRow(ed, "NEW_ONE", CANARIES.other);
    host.before = (a) => { if (a[0] === "commit") chmodSync(stage, 0o755); }; // prepare passed, the tmp holds the value, commit must refuse
    await saveAg(ed);
    host.before = null;
    did(typeof ed.error === "string" && ed.error.length > 0, "the loose stage dir refused the save");
    note("screen", "# refused save"); note("screen", screenOf(ed, { typed: true }));
    chmodSync(stage, 0o700);
    // an unreadable env file while the editor opens (a host error that carries free text with the value)
    const read = host.readTextFile;
    host.readTextFile = async () => { throw Object.assign(new Error(`denied ${CANARIES.token}`), { name: "ReadDenied" }); };
    ed = await openAg("w1");
    did(ed.envError, "the editor reported a read problem");
    note("screen", "# unreadable"); note("screen", screenOf(ed));
    host.readTextFile = read;
    note("profile", JSON.stringify(host.state["drover.agents"]));
    // delete: an agent outside every squad, with its own env file
    host.state["drover.agents"].agents.push({ id: "spare", name: "Spare", command: "codex", soul: "", instructions: "", version: 1 });
    ed = await openAg("spare");
    setRow(ed, "FOO", CANARIES.other);
    await saveAg(ed);
    did(readFileSync(envFile("spare"), "utf8").includes("FOO"), "the spare agent has an env file");
    ed.remove(liveCx()); await flush();
    did(!existsSync(envFile("spare")), "the delete removed the env file");
    note("screen", "# after delete (the editor still holds what was typed)"); note("screen", screenOf(ed, { typed: true }));
    assert.deepEqual(errors, []);
  } finally { console.log = origLog; }
});

// ---- the wrapper: drover-env on success and on every failure path. Each case has its own config root with a canary in the file,
// so a failure message that echoed the file would leak. The child prints nothing of its own, so any canary comes from the wrapper.
function wrapperCase(name, { content = JSON.stringify({ version: 1, env: { GH_TOKEN: { value: CANARIES.token, secret: true }, GH_CONFIG_DIR: { value: "/fake/gh", secret: true }, OTHER_KEY: { value: CANARIES.other, secret: true } } }),
  fileMode = 0o600, dirMode = 0o700, link = false, args, expectOk = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "leak-wrap-"));
  const dir = join(root, "agents");
  mkdirSync(dir, { mode: 0o700 });
  const p = join(dir, "bot.json");
  if (link) { writeFileSync(join(root, "real.json"), content, { mode: 0o600 }); symlinkSync(join(root, "real.json"), p); }
  else if (content !== null) { writeFileSync(p, content); chmodSync(p, fileMode); }
  chmodSync(dir, dirMode);
  const r = spawnSync(WRAPPER, args ?? ["bot", "--", "sh", "-c", "echo child-ran"], { env: { PATH: process.env.PATH, DROVER_HERDR_CONFIG_DIR: root }, encoding: "utf8" });
  chmodSync(dir, 0o700);
  note("wrapper", `$ ${name} exit=${r.status}\n--stdout--\n${r.stdout}\n--stderr--\n${r.stderr}`);
  if (expectOk) { assert.equal(r.status, 0, name); assert.equal(r.stdout, "child-ran\n"); }
  else { assert.notEqual(r.status, 0, `${name} must fail`); assert.ok(!r.stdout.includes("child-ran"), `${name}: the child must not run`); }
  return r;
}

test("flow: drover-env on success and on each failure path", () => {
  const big = JSON.stringify({ version: 1, env: { GH_TOKEN: { value: CANARIES.token, secret: true }, PAD: { value: "x".repeat(9000), secret: true } } });
  wrapperCase("success", { expectOk: true });
  wrapperCase("file mode 0644", { fileMode: 0o644 });
  wrapperCase("dir mode 0755", { dirMode: 0o755 });
  wrapperCase("symlinked file", { link: true });
  wrapperCase("missing file", { content: null });
  wrapperCase("oversize file", { content: big });
  // truncated AFTER a complete JSON-escaped value: an error that echoed the payload would hold the whole canary
  const truncated = `{"version":1,"env":{"GH_TOKEN":{"value":${JSON.stringify(CANARIES.token)},"secret":true},"GH_CONFIG_DIR":{"value":"/fake/gh"`;
  const echo = capture();
  put(echo, "echo.txt", truncated);
  assert.equal(scan(echo, CANARIES)[0].status, "FAIL", "the malformed payload carries a full canary, so an echo would be caught");
  wrapperCase("truncated json", { content: truncated });
  wrapperCase("not an object", { content: JSON.stringify({ version: 1, env: { GH_TOKEN: CANARIES.token } }) });
  wrapperCase("bad name", { content: JSON.stringify({ version: 1, env: { "bad name": { value: CANARIES.token } } }) });
  wrapperCase("duplicate name", { content: `{"version":1,"env":{"FOO":{"value":${JSON.stringify(CANARIES.token)}},"FOO":{"value":${JSON.stringify(CANARIES.other)}}}}` });
  wrapperCase("NUL in a value", { content: JSON.stringify({ version: 1, env: { FOO: { value: CANARIES.token + "\u0000" } } }) });
  wrapperCase("GH_TOKEN without GH_CONFIG_DIR", { content: JSON.stringify({ version: 1, env: { GH_TOKEN: { value: CANARIES.token } } }) });
  wrapperCase("bad version", { content: JSON.stringify({ version: 2, env: { FOO: { value: CANARIES.token } } }) });
  wrapperCase("no command after --", { args: ["bot", "--"] });
  wrapperCase("bad agent id", { args: ["../bot", "--", "sh", "-c", "echo child-ran"] });
  const r = wrapperCase("unknown command", { args: ["bot", "--", "no-such-command-leak-suite"] });
  assert.equal(r.status, 127);
});

// ---- launch: argv, runs, shared state, notices and logs, with the file present, then with a read that fails.
test("flow: launch wraps argv with no value; runs, shared state and notices hold none; a failing read logs a code only", async () => {
  did(readFileSync(envFile(), "utf8").includes("GH_TOKEN"), "w1 still has an env file");
  const run = await launch(null, { kind: "squad", id: "s1" });
  did(!run.error, "the squad launch worked");
  const task = host.state["drover.tasks"][0];
  const runT = await launch(task, { kind: "squad", id: "s1" });
  did(!runT.error, "the task launch worked");
  const argvs = calls.filter(([op]) => op === "tab.new" || op === "space.new").map(([, r]) => JSON.parse(r[r.indexOf("--argv") + 1]));
  did(argvs.some((a) => a[0].endsWith("/bin/drover-env") && a[1] === "w1" && a[2] === "--"), "w1 is wrapped");
  note("launch-argv", JSON.stringify(calls));
  note("runs", JSON.stringify(host.state["drover.runs"]));
  // a read that rejects with free text that holds a value, and a file that cannot be read
  const read = host.readTextFile;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    host.readTextFile = async () => { const e = new Error(`denied ${CANARIES.token}`); e.name = "ReadDenied"; throw e; };
    const bad = await launch(null, { kind: "squad", id: "s1" });
    did(bad.error, "the failing read stopped the launch");
    note("runs", JSON.stringify(bad));
    host.readTextFile = read;
    chmodSync(envFile(), 0o000);
    const locked = await launch(null, { kind: "squad", id: "s1" });
    did(locked.error, "the unreadable file stopped the launch");
    note("runs", JSON.stringify(locked));
    chmodSync(envFile(), 0o600);
  } finally { console.log = origLog; host.readTextFile = read; }
  assert.ok(logs.length > 0, "the failing paths logged something");
});

test("flow: a card note written by reconcile (claim expired) holds no value", async () => {
  const { reconcile } = await import("../_lib/runs.js");
  const { CLAIMING } = await import("../_lib/store.js");
  const tasks = [{ id: "T-2", title: "Claimed", desc: "", column: "doing", project: "p1", agent: CLAIMING, claimedAt: 1, notes: [] }];
  const out = reconcile(tasks, [], new Set(), Date.now(), "p1");
  did(out.tasks[0].notes.length === 1, "reconcile wrote a note");
  note("notes", JSON.stringify(out));
});

// ---- 3. the report
const SURFACES = ["screen", "env-write", "wrapper", "profile", "launch-argv", "runs", "shared-state", "notes", "logs"];
const NOT_PROVEN = [
  "the persisted shared.json on disk (the host is a fake: shared-state above is every setShared payload plus the final in-memory state)",
  "hc read / hc get of a live agent terminal (needs a running Herdr core and agent; none here)",
  "transcripts of real agent sessions (the model provider and the agent's own transcript store)",
  "crash artifacts (core dumps, crash reports)",
  "Herdr core logs and the mod runtime's own log files (the host is a fake here)",
  "what the masked input holds while a value is being typed, pasted or replaced (the input's own text is not scanned; needs the real UI)",
  "the native masked input: masking while typing, paste, reopen, reveal/copy/autofill (needs the real UI)",
  "a hostile agent that prints its own environment, ps eww, same-user readers (outside the promise, scope section 5)",
];
test("report: every surface is PASS, the uncovered ones are listed as NOT PROVEN", () => {
  note("shared-state", `final ${JSON.stringify(host.state)}`);
  note("profile", JSON.stringify(host.state["drover.agents"]));
  note("notes", JSON.stringify([host.state["drover.tasks"], host.notified]));
  note("logs", logs.join("\n"));
  const results = scan(CAP, CANARIES, SURFACES);
  const lines = [...results.map(reportLine), ...NOT_PROVEN.map((s) => `NOT PROVEN ${s}`)];
  console.log("\nleak report (no values):\n" + lines.map((l) => "  " + l).join("\n"));
  const text = lines.join("\n");
  for (const v of Object.values(CANARIES)) for (const f of formsOf(v)) assert.equal(text.includes(f.needle.toString()), false, "the report holds no value");
  assert.deepEqual(results.filter((r) => r.status !== "PASS").map(reportLine), []);
  assert.deepEqual(results.map((r) => r.surface).sort(), [...SURFACES].sort());
});

after(() => { for (const d of [CAP, app, home, FIXTURE_DIR, `${app}-stage`]) try { rmSync(d, { recursive: true, force: true }); } catch {} });
