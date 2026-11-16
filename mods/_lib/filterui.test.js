// The shared filter menu view: key handling over a fake view, and the token chip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../_test/hooks.js", import.meta.url);
const { menuView, tokenChip } = await import(new URL("./filterui.js", import.meta.url).href);

const T = new Proxy({}, { get: () => "#000" });
const items = [{ id: "a", label: "A", glyph: "x", hint: "" }, { id: "b", label: "B", glyph: "y", hint: "h" }, { id: "c", label: "C", glyph: "z", hint: "" }];
function fake(open = true) {
  const log = [];
  const view = {
    hi: -1, skipSubmit: true,
    menuNow: () => ({ open, items }),
    pick: (it) => log.push(["pick", it.id]),
    dismiss: () => log.push(["dismiss"]),
  };
  const cx = { stops: 0, notified: 0, stop_propagation() { this.stops++; }, notify() { this.notified++; } };
  return { view, log, cx };
}

test("Down/Up move the highlight (first press picks an end), wrapping", () => {
  const { view, cx } = fake();
  const v = menuView(view, T, cx);
  v.onKey({ key: "down" }, cx);
  assert.equal(view.hi, 0);
  v.onKey({ key: "down" }, cx); v.onKey({ key: "down" }, cx); v.onKey({ key: "down" }, cx);
  assert.equal(view.hi, 0, "wraps");
  view.hi = -1; v.onKey({ key: "up" }, cx);
  assert.equal(view.hi, 2);
  assert.equal(cx.stops, 5);
});

test("Enter picks only a highlighted item and skips the next submit; Esc dismisses", () => {
  const { view, log, cx } = fake();
  const v = menuView(view, T, cx);
  v.onKey({ key: "enter" }, cx);
  assert.deepEqual(log, [], "nothing highlighted: Enter falls through");
  assert.equal(view.skipSubmit, false, "a stale skip is cleared by each key");
  view.hi = 1; v.onKey({ key: "enter" }, cx);
  assert.deepEqual(log, [["pick", "b"]]);
  assert.equal(view.skipSubmit, true);
  v.onKey({ key: "escape" }, cx);
  assert.deepEqual(log.at(-1), ["dismiss"]);
});

test("a closed menu ignores keys; open/onOutside are exposed", () => {
  const { view, log, cx } = fake(false);
  const v = menuView(view, T, cx);
  assert.equal(v.open, false);
  v.onKey({ key: "escape" }, cx);
  assert.equal(cx.stops, 0);
  v.onOutside({}, cx);
  assert.deepEqual(log, [["dismiss"]]);
});

test("tokenChip renders a function of the token context", () => {
  const chip = tokenChip(T);
  assert.equal(typeof chip, "function");
  assert.ok(chip({ selected: true, token: { label: "a:b" } }));
});
