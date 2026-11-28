// T-MWZE693FFB9: a remote banner on the Tasks sidebar can be dismissed (shared map, key remote-banner:<localId>, reason = the banner's state).
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleBanners, bannerKey, createNeedsCache } from "../_lib/needs.js";
import { dismiss } from "../_lib/dismiss.js";

const R = (localId, state, banner = `${localId} is ${state}`) => ({ localId, name: localId, machine: "box1", projectId: "P-9", state, banner });

test("bannerKey is remote-banner:<localId>", () => {
  assert.equal(bannerKey(R("P-1", "stale")), "remote-banner:P-1");
});

test("visibleBanners: only remotes with a banner, none dismissed", () => {
  const rs = [R("A", "stale"), R("B", "fresh", null), R("C", "never")];
  assert.deepEqual(visibleBanners(rs, {}).map((r) => r.localId), ["A", "C"]);
  assert.deepEqual(visibleBanners(rs, undefined).map((r) => r.localId), ["A", "C"]);
});

test("visibleBanners: a dismissed banner is hidden while its state is the same, and comes back when the state changes", () => {
  const a = R("A", "stale");
  const map = dismiss({}, { key: bannerKey(a), reason: "stale" }, 1);
  assert.deepEqual(visibleBanners([a, R("C", "never")], map).map((r) => r.localId), ["C"]);
  assert.deepEqual(visibleBanners([R("A", "never")], map).map((r) => r.localId), ["A"]);
});

test("the cache repaints (refresh returns true) when only the dismissed map changed", () => {
  let dismissed = {};
  const c = createNeedsCache({ read: () => ({ remotes: [R("A", "stale")], dismissed }) });
  c.refresh();
  assert.equal(c.refresh(), false);
  dismissed = dismiss({}, { key: "remote-banner:A", reason: "stale" }, 1);
  assert.equal(c.refresh(), true);
  assert.deepEqual(visibleBanners(c.get().remotes, c.get().dismissed), []);
});

// ---- the Board's grey "<project>: <machine> unreachable ..." line follows its banner; a fresh remote forgets the dismissal ----
import { statusHidden, clearFresh } from "../_lib/dismiss.js";

test("statusHidden: the grey line hides while its banner is dismissed, reappears when the state changes, never hides for a remote with no banner", () => {
  const map = dismiss({}, { key: "remote-banner:A", reason: "stale" }, 1);
  assert.equal(statusHidden(R("A", "stale"), map), true);
  assert.equal(statusHidden(R("A", "never"), map), false);
  assert.equal(statusHidden(R("B", "stale"), map), false);
  assert.equal(statusHidden(R("A", "fresh", null), dismiss({}, { key: "remote-banner:A", reason: "fresh" }, 1)), false);
  assert.equal(statusHidden(R("A", "stale"), undefined), false);
});

test("clearFresh: a fresh remote drops its entry, so stale again shows the banner; other entries and non-fresh remotes stay", () => {
  let map = dismiss(dismiss({}, { key: "remote-banner:A", reason: "stale" }, 1), { key: "T-1", reason: "x" }, 1);
  const same = clearFresh(map, [R("A", "stale")]);
  assert.equal(same, map, "same object back when nothing drops");
  map = clearFresh(map, [R("A", "fresh", null)]);
  assert.deepEqual(Object.keys(map), ["T-1"]);
  assert.deepEqual(visibleBanners([R("A", "stale")], map).map((r) => r.localId), ["A"]);
});
