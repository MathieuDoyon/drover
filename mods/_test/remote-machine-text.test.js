// The remote-write texts name the machine the project is bound to (read at run time), never a hardcoded one (T-MWO2HF2JEN5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discoverPrivateWords, wholeWord } from "./private-words.js";

const U = await import("../_lib/remote-write-ui.js");
const W = await import("../_lib/remote-write.js");

test("OFF_TIP names the bound machine; generic when no binding is in scope", () => {
  for (const m of ["box1", "box2"]) assert.match(U.offTip(m), new RegExp(`\\b${m}\\b`));
  assert.ok(!/box1/.test(U.offTip("box2")));
  assert.match(U.offTip(), /the remote machine/);
  assert.match(U.OFF_TIP, /the remote machine/);
});

test("stale and unknown outcomes name the machine of the outcome", () => {
  for (const m of ["box1", "box2"]) {
    assert.equal(U.outcomeText({ status: "stale", machine: m }), `card changed on ${m}: reloaded, try again`);
    assert.equal(U.outcomeText({ status: "unknown", machine: m }), `outcome unknown: check the card on ${m}`);
  }
  assert.equal(U.outcomeText({ status: "stale" }), "card changed on the remote machine: reloaded, try again");
  assert.equal(U.outcomeText({ status: "unknown" }), "outcome unknown: check the card on the remote machine");
});

test("the 'Writes to' toggle label takes the bound machine", () => {
  assert.equal(U.writesToggle({ machine: "box1" }, null).label, "Writes to box1");
  assert.equal(U.writesToggle({ machine: "box2", writes: false }, null).label, "Writes to box2");
  assert.equal(U.writesToggle(undefined, null).label, "Writes to the remote machine");
});

test("the writer's own messages carry no machine name", () => {
  assert.equal(W.classify("error: stale: card T-1 is at rev 5").message, "card changed on the remote machine");
});

test("the shipped sources spell no private word (machines, user, host read at run time)", () => {
  const { words } = discoverPrivateWords();
  for (const f of ["../_lib/remote-write-ui.js", "../_lib/remote-write.js"]) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const w of words) assert.ok(!wholeWord(text, w), `${f} names a private word`);
  }
});
