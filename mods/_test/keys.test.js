// keys.js on temp files only: never the owner's keys.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SHORTCUTS, status, enable, disable, apply } from "../_lib/keys.js";

const [SIDEBAR, NEWTASK] = SHORTCUTS;
const canon = (o) => JSON.stringify(o, null, 2) + "\n";
const base = () => ({ global: { "cmd-b": "layout.toggle:sidebar" }, "layout:drover": { "cmd-alt-h": "app.hide" } });

async function tmp(text) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "keys-"));
  const file = path.join(dir, "keys.json");
  if (text != null) await fs.writeFile(file, text);
  let n = 0;
  const io = {
    read: async () => fs.readFile(file, "utf8").catch(() => null),
    write: async (p, t, expected) => {
      const cur = await fs.readFile(p, "utf8").catch(() => null);
      if (cur !== expected) throw new Error("stale");
      await fs.writeFile(p, t);
    },
    path: file,
    now: () => `2026-11-13T10-00-00-00${n++}Z`,
  };
  return { dir, file, io };
}

test("shortcut definitions", () => {
  assert.equal(SIDEBAR.key, "cmd-alt-b");
  assert.equal(SIDEBAR.section, "layout:drover");
  assert.deepEqual(SIDEBAR.binding, { command: "layout.toggle", args: { id: "drover" } });
  assert.equal(NEWTASK.key, "cmd-shift-c");
  assert.equal(NEWTASK.section, "global");
  assert.equal(NEWTASK.binding, "mod.open:drover-newtask");
});

test("status: off when absent, on when the exact binding is there", () => {
  assert.equal(status(canon(base()), SIDEBAR).state, "off");
  const on = base();
  on["layout:drover"]["cmd-alt-b"] = SIDEBAR.binding;
  assert.equal(status(canon(on), SIDEBAR).state, "on");
});

test("status: conflict when the key is bound to something else, with what it is bound to", () => {
  const o = base();
  o.global["cmd-shift-c"] = "app.quit";
  const s = status(canon(o), NEWTASK);
  assert.equal(s.state, "conflict");
  assert.match(s.message, /cmd-shift-c/);
  assert.match(s.message, /app\.quit/);
});

test("status: invalid for malformed, non-object, non-canonical, absent file", () => {
  for (const text of ["{nope", "[]", "null", '{"global":{}}', '{ "global": {} }\n', null]) {
    assert.equal(status(text, SIDEBAR).state, "invalid", String(text));
  }
});

test("enable adds only Drover's binding, creating its section, everything else untouched", () => {
  const r = enable(canon(base()), SIDEBAR);
  assert.equal(r.ok, true);
  const o = base();
  o["layout:drover"]["cmd-alt-b"] = SIDEBAR.binding;
  assert.equal(r.text, canon(o));
  const g = enable(canon(base()), NEWTASK);
  const o2 = base();
  o2.global["cmd-shift-c"] = "mod.open:drover-newtask";
  assert.equal(g.text, canon(o2));
  const fresh = enable(canon({ global: {} }), SIDEBAR);
  assert.deepEqual(JSON.parse(fresh.text)["layout:drover"], { "cmd-alt-b": SIDEBAR.binding });
});

test("enable when already on changes nothing", () => {
  const on = canon({ ...base(), "layout:drover": { "cmd-alt-b": SIDEBAR.binding } });
  const r = enable(on, SIDEBAR);
  assert.deepEqual([r.ok, r.changed, r.text], [true, false, on]);
});

test("enable refuses a key bound to something else; text not returned", () => {
  const o = base();
  o["layout:drover"]["cmd-alt-b"] = "tab.new";
  const r = enable(canon(o), SIDEBAR);
  assert.equal(r.ok, false);
  assert.match(r.error, /already bound/);
  assert.equal(r.text, undefined);
});

test("disable removes only the exact Drover binding; a different binding on that key stays", () => {
  const o = base();
  o["layout:drover"]["cmd-alt-b"] = SIDEBAR.binding;
  o.global["cmd-shift-c"] = "mod.open:drover-newtask";
  const r = disable(canon(o), NEWTASK);
  assert.equal(r.ok, true);
  const exp = base();
  exp["layout:drover"]["cmd-alt-b"] = SIDEBAR.binding;
  assert.equal(r.text, canon(exp));
  const other = base();
  other.global["cmd-shift-c"] = "app.quit";
  const d = disable(canon(other), NEWTASK);
  assert.equal(d.ok, false);
  assert.match(d.error, /not Drover/i);
  const off = disable(canon(base()), NEWTASK);
  assert.deepEqual([off.ok, off.changed], [true, false]);
});

test("enable then disable restores the exact bytes", () => {
  for (const sc of SHORTCUTS) {
    const before = canon(base());
    assert.equal(disable(enable(before, sc).text, sc).text, before);
  }
});

test("apply on: backs up first, then writes with the old text as expected", async () => {
  const t = await tmp(canon(base()));
  const before = await fs.readFile(t.file, "utf8");
  const r = await apply(t.io, NEWTASK, true);
  assert.equal(r.ok, true);
  assert.equal(await fs.readFile(`${t.file}.bak-2026-11-13T10-00-00-000Z`, "utf8"), before);
  assert.equal(status(await fs.readFile(t.file, "utf8"), NEWTASK).state, "on");
});

test("apply off removes it again", async () => {
  const t = await tmp(canon(base()));
  const before = await fs.readFile(t.file, "utf8");
  await apply(t.io, SIDEBAR, true);
  const r = await apply(t.io, SIDEBAR, false);
  assert.equal(r.ok, true);
  assert.equal(await fs.readFile(t.file, "utf8"), before);
});

test("apply on a conflict: refuses, file and directory untouched (no backup)", async () => {
  const o = base();
  o.global["cmd-shift-c"] = "app.quit";
  const t = await tmp(canon(o));
  const before = await fs.readFile(t.file, "utf8");
  const r = await apply(t.io, NEWTASK, true);
  assert.equal(r.ok, false);
  assert.equal(await fs.readFile(t.file, "utf8"), before);
  assert.deepEqual(await fs.readdir(t.dir), ["keys.json"]);
});

test("apply on malformed / non-canonical / missing file: refuses, untouched, no backup", async () => {
  for (const text of ["{ broken", "[1]", '{"global":{"a":"b"}}']) {
    const t = await tmp(text);
    const r = await apply(t.io, SIDEBAR, true);
    assert.equal(r.ok, false, text);
    assert.equal(await fs.readFile(t.file, "utf8"), text);
    assert.deepEqual(await fs.readdir(t.dir), ["keys.json"]);
  }
  const t = await tmp(null);
  assert.equal((await apply(t.io, SIDEBAR, true)).ok, false);
  assert.deepEqual(await fs.readdir(t.dir), []);
});

test("apply: a file changed by someone else between read and write is not overwritten", async () => {
  const t = await tmp(canon(base()));
  const io = { ...t.io, write: async (p, text, expected) => {
    if (p === t.file) await fs.writeFile(t.file, canon({ global: { x: "y" } })); // concurrent edit before the real write
    return t.io.write(p, text, expected);
  } };
  const r = await apply(io, SIDEBAR, true);
  assert.equal(r.ok, false);
  assert.equal(await fs.readFile(t.file, "utf8"), canon({ global: { x: "y" } }));
});

test("cross-scope: the combo bound to another action in global/terminal/layout:drover refuses enable, naming section and action", async () => {
  const cases = [
    [SIDEBAR, { global: { "cmd-alt-b": "tab.new" } }, /global.*tab\.new/],
    [SIDEBAR, { terminal: { "cmd-alt-b": "terminal.copy" } }, /terminal.*terminal\.copy/],
    [NEWTASK, { terminal: { "cmd-shift-c": "terminal.copy" } }, /terminal.*terminal\.copy/],
    [NEWTASK, { "layout:drover": { "cmd-shift-c": "tab.new" } }, /layout:drover.*tab\.new/],
  ];
  for (const [sc, o, re] of cases) {
    const text = canon({ global: {}, ...o });
    assert.equal(status(text, sc).state, "conflict");
    const r = enable(text, sc);
    assert.equal(r.ok, false);
    assert.match(r.error, re);
    const t = await tmp(text);
    assert.equal((await apply(t.io, sc, true)).ok, false);
    assert.equal(await fs.readFile(t.file, "utf8"), text);
    assert.deepEqual(await fs.readdir(t.dir), ["keys.json"]);
  }
});

test("cross-scope: Drover's exact binding masked by another section is installed (ON) with a warning", () => {
  const sb = canon({ global: {}, terminal: { "cmd-alt-b": "terminal.copy" }, "layout:drover": { "cmd-alt-b": SIDEBAR.binding } });
  const s = status(sb, SIDEBAR);
  assert.deepEqual([s.state, s.installed], ["on", true]);
  assert.match(s.warning, /terminal\.copy/);
  const nt = canon({ global: { "cmd-shift-c": "mod.open:drover-newtask" }, "layout:drover": { "cmd-shift-c": "tab.new" } });
  assert.equal(status(nt, NEWTASK).installed, true);
  assert.equal(enable(nt, NEWTASK).changed, false);
});

test("OFF leaves a pre-existing empty section: enable then disable is byte-identical", () => {
  const before = canon({ global: {}, "layout:drover": {} });
  assert.equal(disable(enable(before, SIDEBAR).text, SIDEBAR).text, before);
  assert.equal(disable(enable(before, NEWTASK).text, NEWTASK).text, before);
});

// A fixture shaped like the owner's keys.json (global, terminal with control characters, layout:drover with the sidebar binding).
const OWNER = canon({
  global: { "cmd-t": "tab.new", "cmd-b": "layout.toggle:sidebar", "cmd-p": "mod.open:picker", "ctrl-9": "space.select:9" },
  terminal: { "cmd-f": "terminal.search", "alt-left": "send:\u001bb", "cmd-backspace": "send:\u0015" },
  "layout:drover": { "cmd-alt-b": { command: "layout.toggle", args: { id: "drover" } } },
});

test("owner-shaped fixture: sidebar reads ON, Create task OFF, enable/disable round-trip byte for byte", () => {
  assert.equal(status(OWNER, SIDEBAR).state, "on");
  assert.equal(status(OWNER, NEWTASK).state, "off");
  assert.equal(enable(disable(OWNER, SIDEBAR).text, SIDEBAR).text, OWNER);
  assert.equal(disable(enable(OWNER, NEWTASK).text, NEWTASK).text, OWNER);
});

test("global shortcut: any other section (layout:main, mod:editor) masks it", () => {
  for (const section of ["layout:main", "mod:editor"]) {
    const text = canon({ global: {}, [section]: { "cmd-shift-c": "tab.new" } });
    assert.equal(status(text, NEWTASK).state, "conflict", section);
    const r = enable(text, NEWTASK);
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`${section}.*tab\\.new`));
    const on = canon({ global: { "cmd-shift-c": "mod.open:drover-newtask" }, [section]: { "cmd-shift-c": "tab.new" } });
    const s = status(on, NEWTASK);
    assert.deepEqual([s.installed, s.state], [true, "on"]);
    assert.match(s.warning, new RegExp(section));
  }
  // the sidebar keeps its three scopes: another layout's binding does not matter
  assert.equal(status(canon({ global: {}, "layout:main": { "cmd-alt-b": "tab.new" } }), SIDEBAR).state, "off");
});

test("status: installed and warning are separate", () => {
  const clean = status(canon({ global: { "cmd-shift-c": "mod.open:drover-newtask" } }), NEWTASK);
  assert.deepEqual([clean.installed, clean.warning, clean.state], [true, "", "on"]);
  const off = status(canon({ global: {} }), NEWTASK);
  assert.deepEqual([off.installed, off.warning, off.state], [false, "", "off"]);
  const conflict = status(canon({ terminal: { "cmd-shift-c": "terminal.copy" } }), NEWTASK);
  assert.deepEqual([conflict.installed, conflict.state], [false, "conflict"]);
  assert.match(conflict.warning, /terminal\.copy/);
});

test("a masked Drover binding can be switched OFF; the masking entry stays", () => {
  const text = canon({ global: { "cmd-shift-c": "mod.open:drover-newtask" }, terminal: { "cmd-shift-c": "terminal.copy" } });
  const r = disable(text, NEWTASK);
  assert.equal(r.ok, true);
  assert.equal(r.text, canon({ global: {}, terminal: { "cmd-shift-c": "terminal.copy" } }));
});

test("sidebar: mod:* sections also mask it (other layout:* still ignored)", () => {
  const absent = canon({ global: {}, "mod:editor": { "cmd-alt-b": "tab.new" } });
  assert.equal(status(absent, SIDEBAR).state, "conflict");
  const r = enable(absent, SIDEBAR);
  assert.equal(r.ok, false);
  assert.match(r.error, /mod:editor.*tab\.new/);
  const on = canon({ global: {}, "layout:drover": { "cmd-alt-b": SIDEBAR.binding }, "mod:editor": { "cmd-alt-b": "tab.new" } });
  const s = status(on, SIDEBAR);
  assert.deepEqual([s.state, s.installed], ["on", true]);
  assert.match(s.warning, /mod:editor/);
  assert.equal(status(canon({ global: {}, "layout:main": { "cmd-alt-b": "tab.new" } }), SIDEBAR).state, "off");
});
