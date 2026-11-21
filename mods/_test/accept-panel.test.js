// B3b (T-MWO3FDGAIKD): the Tasks panel's check mark on a local Review row no longer moves the card to Done: it opens the proof / Accept dialog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tasks, host, render, card, IO, P, delta, none } from "./accept-host.js";

const panel = (tasks) => { const m = host(tasks, { runSpawn: false }); const t = new Tasks(); t.init({}, m.cx); return { t, ...m }; };
const review = () => [card(3, { column: "review" })];

test("the ✓ on a local Review row opens the proof dialog and moves nothing (red, unreviewed card)", () => {
  const { t, cx, raw, h } = panel(review());
  assert.ok(render(t, cx).ids.includes("done-T-3"), "the control is still there");
  const before = JSON.stringify(raw["drover.tasks"]);
  t.acceptRow(raw["drover.tasks"][0], cx);
  assert.equal(JSON.stringify(raw["drover.tasks"]), before, "no column change, no save");
  const o = h.overlays.at(-1);
  assert.deepEqual([o?.mod, o?.kind, o?.props], ["drover-todos", "dialog", { proof: { id: "T-3", project: P.id } }]);
});

test("render stays side-effect free and the row has an acceptRow action", () => {
  const { t, cx, calls } = panel(review());
  const r = delta(calls, () => render(t, cx));
  assert.deepEqual(r.d, none);
  assert.equal(typeof t.acceptRow, "function");
});

test("source: the Review row check mark no longer calls update(... done)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../drover-tasks/main.js", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes("icon(`done-${cardKey(task)}`") && !l.includes("remoteSend")) ?? "";
  assert.ok(line.includes("this.acceptRow(task)"), line);
  assert.match(src, /acceptRow\(task\) \{ openProof\(task\); \}/);
  assert.ok(!/column:\s*"done"/.test(line), line);
});
