// T-MWMIQMBO1BQ: `drover next` through the real inbox consumer: runs parked on Review/Blocked cards take no slot and are named.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const S = await import("../_lib/store.js");
const C = await import("../_lib/config.js");

let home, inbox, host, A, n = 0;
afterEach(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  C.resetCache();
  home = mkdtempSync(join(tmpdir(), "slots-home-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  host = globalThis.__host = { appHome: home, home: join(home, "h"), props: {}, notified: [], state: {}, agents: [], terminals: [], watchFolder: () => new Promise(() => {}), exec: async () => ({ code: 0, stdout: "[]", stderr: "" }) };
  const { projects } = S.addProject([], { name: "A", repos: "/a" }, 1);
  A = projects[0];
  host.state["drover.projects"] = projects;
});

const ask = async (cmd) => {
  const name = `${Math.floor(Date.now() / 1000)}-${++n}`;
  writeFileSync(join(inbox, `${name}.json`), JSON.stringify(cmd));
  const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
  IO.watchInbox(cx);
  return until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `answer ${name}`);
};
const sq = (task, address) => ({ id: "R" + task, task, project: A.id, reportTo: "t81", started: 1, terminals: [{ address, agent: "wrangler" }] });

function world(columns) {
  let tasks = [];
  columns.forEach((column, i) => { tasks = S.add(tasks, { title: "c" + i, column, project: A.id }, 1000 + i).tasks; });
  tasks = S.add(tasks, { title: "ready", column: "todo", project: A.id }, 2000).tasks;
  const ids = tasks.map((t) => t.id);
  host.state["drover.tasks"] = tasks.map((t, i) => (i < columns.length ? { ...t, id: "T-" + (i + 1) } : t));
  host.state["drover.runs"] = [{ id: "Dt81", task: null, project: A.id, started: 1, terminals: [{ address: "t81", agent: "drover" }] }, ...columns.map((_, i) => sq("T-" + (i + 1), "t" + (i + 1)))];
  host.terminals = [{ address: "t81" }, ...columns.map((_, i) => ({ address: "t" + (i + 1) }))];
  return ids;
}

test("next: 2 runs on Review/Blocked cards leave 2 slots and name the waiting runs", async () => {
  world(["review", "blocked"]);
  const r = (await ask({ op: "next", from: "t81" })).split("\n");
  assert.equal(r[0], "ok: 2 slots · 2 waiting");
  assert.match(r[1], /ready/);
});

test("next: 2 In progress runs + 1 Review: 0 slots (and the waiting one is named); no terminal or run changed", async () => {
  world(["doing", "doing", "review"]);
  const runs = JSON.stringify(host.state["drover.runs"]), terms = JSON.stringify(host.terminals);
  assert.equal(await ask({ op: "next", from: "t81" }), "ok: 0 slots · 1 waiting");
  assert.equal(JSON.stringify(host.state["drover.runs"]), runs);
  assert.equal(JSON.stringify(host.terminals), terms);
});

test("next: a Review card moved back to In progress with the slots full: 0 slots, never negative", async () => {
  world(["doing", "doing", "doing"]); // 3 active against the limit of 2
  assert.equal(await ask({ op: "next", from: "t81" }), "ok: 0 slots");
});
