// Remote project ownership guard (T-MWHVWQNL2HA, 2g): no local producer puts a card into a project that lives on another machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const RID = "P-REMOTE1";
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", project, archived: false, notes: [], ...extra });

let home, inbox;
const PKEY = "drover.projects", TKEY = "drover.tasks";
const LOCAL = { id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" };
const REMOTE = { id: "P-ONREM", name: "pairstone", repos: [], folders: [], branch: "main", remote: { machine: "box1", projectId: RID } };
function mkHost() {
  home = mkdtempSync(join(tmpdir(), "remote-home-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  const host = globalThis.__host = { appHome: home, props: {}, notified: [], state: {}, agents: [], terminals: [], watchFolder: () => new Promise(() => {}), exec: async () => ({ code: 1, stdout: "", stderr: "" }) };
  host.state[PKEY] = [LOCAL, REMOTE];
  host.state[TKEY] = [card("T-LOCAL1", "P-LOCAL", { id: "T-LOCAL1" })];
  return host;
}
const startLoop = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; IO.watchInbox(cx); };
let n = 0;
const send = async (cmd) => {
  const name = `rp${++n}`;
  writeFileSync(join(inbox, `${name}.json`), JSON.stringify(cmd));
  startLoop();
  return until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `answer ${name}`);
};

test("2g ownership: inbox add --project, project reassignment and start reject the remote project; other projects still work", async () => {
  const host = mkHost();
  const before = JSON.stringify(host.state[TKEY]);
  assert.match(await send({ op: "add", title: "x", project: "pairstone" }), /^error: .*box1/);
  assert.match(await send({ op: "add", title: "x", project: "P-ONREM" }), /^error: .*box1/, "by id too");
  assert.match(await send({ op: "project", id: "T-LOCAL1", project: "pairstone" }), /^error: .*box1/);
  assert.match(await send({ op: "start", task: "T-LOCAL1", project: "pairstone", runner: "claude" }), /^error: /);
  assert.equal(JSON.stringify(host.state[TKEY]), before, "nothing written");
  assert.match(await send({ op: "add", title: "fine", project: "mine" }), /^ok: T-/, "the local board still accepts other projects");
  assert.match(await send({ op: "project", id: "T-LOCAL1", project: "none" }), /^ok: /);
});

test("2g ownership: a card already in the remote project cannot be claimed or launched; Tasks/Board save rejects it", async () => {
  const host = mkHost();
  host.state[TKEY] = [card("T-X", "P-ONREM", { id: "T-X" }), card("T-LOCAL1", "P-LOCAL")];
  assert.match(await send({ op: "start", task: "T-X", runner: "claude" }), /^error: .*box1/);
  assert.equal(host.state[TKEY][0].agent ?? null, null, "not claimed");
  const r = await IO.launch(host.state[TKEY][0], { kind: "agent", id: "claude" }, {});
  assert.match(r.error, /box1/);
  const { add, update } = await import("../_lib/store.js");
  host.notified.length = 0;
  assert.equal(IO.save(add(host.state[TKEY], { title: "new", project: "P-ONREM" })), null, "create");
  assert.equal(IO.save(update(host.state[TKEY], "T-LOCAL1", { project: "P-ONREM" })), null, "edit: move a card into it");
  assert.equal(host.notified.length, 2);
  assert.match(host.notified[0].body, /box1/);
  assert.equal(host.state[TKEY].length, 2, "nothing saved");
  const ok = IO.save(add(host.state[TKEY], { title: "local", project: "P-LOCAL" }));
  assert.equal(ok.title, "local");
  assert.equal(host.state[TKEY].length, 3);
});


test("review M3: stored ownership counts too: task-less and bulk saves, moving a card out, and inbox edits of a retained card are rejected", async () => {
  const host = mkHost();
  const kept = card("T-KEPT", "P-ONREM", { id: "T-KEPT", archived: true }); // binding allows archived local cards
  host.state[TKEY] = [kept, card("T-LOCAL1", "P-LOCAL")];
  const { update } = await import("../_lib/store.js");
  const before = JSON.stringify(host.state[TKEY]);
  host.notified.length = 0;
  assert.equal(IO.save({ tasks: [{ ...kept, title: "changed" }, host.state[TKEY][1]] }), null, "task-less result (the editor autosave shape)");
  assert.equal(IO.save(update(host.state[TKEY], "T-KEPT", { project: null })), null, "moving a card out of the remote project");
  assert.equal(IO.save({ tasks: [{ ...kept, title: "x" }, { ...host.state[TKEY][1], title: "ok" }], task: host.state[TKEY][1] }), null, "bulk with an unrelated task");
  assert.equal(host.notified.length, 3);
  assert.equal(JSON.stringify(host.state[TKEY]), before);
  assert.ok(IO.save({ tasks: [kept, { ...host.state[TKEY][1], title: "fine" }], task: host.state[TKEY][1] }) !== null || host.state[TKEY][1].title === "fine", "a change to a local card only is saved");
  for (const cmd of [{ op: "project", id: "T-KEPT", project: "none" }, { op: "project", id: "T-KEPT", project: "mine" }, { op: "edit", id: "T-KEPT", title: "z" }, { op: "note", id: "T-KEPT", text: "n" }, { op: "move", id: "T-KEPT", column: "done" }, { op: "archive", id: "T-KEPT" }]) {
    assert.match(await send(cmd), /^error: .*box1/, cmd.op);
  }
  assert.equal(host.state[TKEY][0].project, "P-ONREM");
  assert.equal(host.state[TKEY][0].title, kept.title);
  assert.match(await send({ op: "edit", id: "T-LOCAL1", title: "still works" }), /^ok: /);
});
