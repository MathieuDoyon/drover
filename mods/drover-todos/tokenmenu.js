// Generic token menu helpers: pure, no I/O, no imports. Shared by the GitHub and Jira menus.
//   nextIndex(hi, n, dir)  highlight move, wraps; "up" | "down".
//   CLOSED                 the closed menu state.
//   lc(s)                  lower-case string.
//   rank(pool, typed, names) prefix matches first, then substring matches, case-insensitive; names(x) -> [string].
//   wordAt(content, caret) -> {range, word} | null. The word at the caret (range extended to the end of the word);
//                          null inside a token or glued to one.

export function nextIndex(hi, n, dir) {
  if (n <= 0) return 0;
  return dir === "up" ? (hi - 1 + n) % n : (hi + 1) % n;
}

export const CLOSED = { open: false, stage: null, items: [] };
export const lc = (s) => String(s).toLowerCase();
export const rank = (pool, typed, names) => {
  if (!typed) return pool;
  const t = lc(typed);
  const hit = (x) => names(x).map(lc);
  return [...pool.filter((x) => hit(x).some((n) => n.startsWith(t))), ...pool.filter((x) => !hit(x).some((n) => n.startsWith(t)) && hit(x).some((n) => n.includes(t)))];
};

// The word at the caret: its range (extended to the end of the word) and the text up to the caret.
export function wordAt(content, caret) {
  const { text, tokens } = content;
  const at = Math.max(0, Math.min(caret, text.length));
  if (tokens.some((s) => s.range.start < at && at < s.range.end)) return null;
  const floor = tokens.reduce((m, s) => (s.range.end <= at ? Math.max(m, s.range.end) : m), 0);
  let start = at;
  while (start > floor && !/\s/.test(text[start - 1])) start--;
  if (start === at && at > 0 && !/\s/.test(text[at - 1])) return null; // glued to a token
  const ceil = tokens.reduce((m, s) => (s.range.start >= at ? Math.min(m, s.range.start) : m), text.length);
  let end = at;
  while (end < ceil && !/\s/.test(text[end])) end++;
  return { range: { start, end }, word: text.slice(start, end) };
}
