// Canonical copy lives in mods/_lib. Pure: the Needs-you "Dismiss" state and the "Help wanted" message (T-MWXRH2E0KIS).
// The shared map is { key: { reason, at } }. A row stays hidden while its key AND reason match; a new reason brings it back.
export const DISMISS_KEY = "drover.needs.dismissed";
const clean = (m) => (m && typeof m === "object" && !Array.isArray(m) ? m : {});

export const isDismissed = (map, a) => clean(map)[a.key]?.reason === a.reason;
export const dismiss = (map, a, now) => ({ ...clean(map), [a.key]: { reason: a.reason, at: now } });
export function restore(map, key) {
  const { [key]: _gone, ...rest } = clean(map);
  return rest;
}
// A remote banner's Dismiss (T-MWZE693FFB9): same shared map as the Needs-you rows, key remote-banner:<localId>, reason = the remote's state,
// so a state change (stale -> never, ...) brings the banner back.
export const bannerKey = (r) => `remote-banner:${r.localId}`;
export const visibleBanners = (remotes, dismissed) => remotes.filter((r) => r.banner && !isDismissed(dismissed, { key: bannerKey(r), reason: r.state }));
// The grey "<project>: <machine> unreachable ..." line under the banners follows its banner: hidden while that banner is dismissed.
export const statusHidden = (r, dismissed) => Boolean(r.banner) && isDismissed(dismissed, { key: bannerKey(r), reason: r.state });
// A remote that answers again (state fresh) forgets its dismissal, so fixed-then-broken shows again. Same object back when nothing drops.
export function clearFresh(map, remotes) {
  const m = clean(map), gone = remotes.filter((r) => r.state === "fresh" && bannerKey(r) in m).map(bannerKey);
  return gone.length ? Object.fromEntries(Object.entries(m).filter(([k]) => !gone.includes(k))) : m;
}

// Bound the map by the clock alone, never by what a read returned (a read can be empty or partial for a moment, and a missing key must stay dismissed):
// an entry older than 30 days (by its `at`, or with no valid `at`) goes, then only the newest 200 stay (a tie keeps the smaller key).
// Same object back when nothing drops.
export const DISMISS_TTL = 30 * 86400000, DISMISS_CAP = 200;
export function prune(map, now) {
  const m = clean(map);
  const kept = Object.entries(m).filter(([, e]) => now - e?.at <= DISMISS_TTL)
    .sort(([ka, a], [kb, b]) => b.at - a.at || (ka < kb ? -1 : 1)).slice(0, DISMISS_CAP);
  return kept.length === Object.keys(m).length ? m : Object.fromEntries(kept);
}

// What an agent gets for "Send to agent". Card text is untrusted data: one line, no control characters, no quote that could close the title.
export const HELP_MAX = 200;
const line = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
// n counts UTF-16 units (.length); a code point is never split. A cut ends with "…" (1 unit).
const cut = (s, n) => {
  if (s.length <= n) return s;
  let out = "";
  for (const ch of s) { if (out.length + ch.length > n - 1) break; out += ch; }
  return n > 0 ? `${out}…` : "";
};
export function helpMessage(task, reason) {
  const id = cut(line(task.id), 40), why = cut(line(reason), 60);
  const head = `Help wanted on ${id}: "`, mid = `" (reason: `, tail = ")";
  const title = cut(line(task.title).replace(/"/g, "'"), HELP_MAX - head.length - mid.length - tail.length - why.length);
  return `${head}${title}${mid}${why}${tail}`;
}
