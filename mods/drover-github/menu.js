// GitHub filter key/value menu: pure item builders. ESM, no I/O, imports ./query.js, ./filter.js and ./tokenmenu.js only.
//
// LIMITATION: the host InputState has no caret getter (gpui-kit d.ts: only set_selected_range), so the
// view calls menuState(content) with the caret at the END of the text. The menu therefore works at the end
// of the input only; editing in the middle opens no menu. menuState still takes a caret so a future host
// getter needs no change here.
//
//   KEYS                              the v1 keys [{key,label,glyph}], in menu order.
//   menuState(content, caret?, {scopes}) -> {open:false, stage:null, items:[]} or
//                                      {open:true, stage:"keys"|"values", range, typed, negated, key?, items}.
//                                      range = the word under the caret, which a pick replaces. The menu is
//                                      closed inside a token, right after a token with no space, for an unknown
//                                      key, a quoted value (`key:"..."`) and when nothing matches.
//   item = {id, label, glyph, hint, insert}, insert is one of
//                                      {range, text}   replace the range with text (key `author:`, Exclude `-`)
//                                      {range, token}  replace the range with a qualToken (structured, never reparsed)
//                                      {reset:true}    "Reset filter": the whole input becomes the configured default query (is:issue state:open unless set)
//   nextIndex(hi, n, dir)             highlight move, wraps; "up" | "down".
//
// Stage keys: the 17 keys (incl. Commenter, Comments; Created/Updated/Comments/Project/Mentions take a typed raw value such as `created:>2026-01-01`), then AND / OR / Exclude, then Reset filter. Typing filters by prefix first, then substring,
// case-insensitive, against the label and the key (auth -> Author). AND is implicit between words, so
// picking it inserts nothing (it only clears the typed word). OR inserts the plain word `OR ` (the query
// parser already reads it as the operator). Exclude inserts `-`: the word `-` is a pending negation, so the
// next key pick gives `-key:`; with `-` typed the operators are hidden.
// Stage values (after `key:`): Me (`@me`) for the people keys; `no:assignee|label|milestone|project`
// items ("No X", never `-no:`, no "Has X"); Exclude (`-key:`, text); fixed lists for is/state/draft/in;
// repo: the repo scopes (an org scope offers only free text). Label/people/milestone rows come from the caller
// ({values:{label:[{value}], assignee…:[{login,avatar}], milestone:[{value}]}}, see values.js): the menu never fetches. A typed value that is not
// a listed one gives "Use <typed>". Values are single words: a value with spaces is typed as key:"a b" (the menu reads the word
// after the space as a new word).
import { qualToken, tokenize } from "./filter.js";
import { outsideScope } from "./query.js";
import { nextIndex, CLOSED, lc, rank, wordAt } from "./tokenmenu.js";

export { nextIndex };

export const KEYS = [
  { key: "is", label: "Is", glyph: "▦" },
  { key: "state", label: "State", glyph: "◌" },
  { key: "label", label: "Label", glyph: "#" },
  { key: "assignee", label: "Assignee", glyph: "☺" },
  { key: "author", label: "Author", glyph: "☺" },
  { key: "involves", label: "Involves", glyph: "☺" },
  { key: "mentions", label: "Mentions", glyph: "@" },
  { key: "milestone", label: "Milestone", glyph: "⚑" },
  { key: "review-requested", label: "Review requested", glyph: "◎" },
  { key: "draft", label: "Draft", glyph: "✎" },
  { key: "project", label: "Project", glyph: "▤" },
  { key: "in", label: "In", glyph: "⌕" },
  { key: "repo", label: "Repo", glyph: "◆" },
  { key: "created", label: "Created", glyph: "▢" },
  { key: "updated", label: "Updated", glyph: "▣" },
  { key: "commenter", label: "Commenter", glyph: "☺" },
  { key: "comments", label: "Comments", glyph: "•" },
];
const OPS = [
  { id: "AND", label: "AND", glyph: "&", text: "" },
  { id: "OR", label: "OR", glyph: "|", text: "OR " },
  { id: "EXCLUDE", label: "Exclude", glyph: "−", text: "-" },
];
const PEOPLE = new Set(["author", "assignee", "involves", "mentions", "review-requested", "commenter"]);
const MAX_VALUES = 50;
const NO = new Set(["assignee", "label", "milestone", "project"]);
const FIXED = {
  is: ["issue", "pr", "open", "closed", "draft", "merged", "locked"],
  state: ["open", "closed"],
  draft: ["true", "false"],
  in: ["title", "body", "comments"],
};


export function menuState(content, caret = content.text.length, { scopes = [], values = {}, defaultText = "is:issue state:open" } = {}) {
  const w = wordAt(content, caret);
  if (!w) return CLOSED;
  const { range, word } = w;
  const negated = word.startsWith("-");
  const body = negated ? word.slice(1) : word;
  const colon = body.indexOf(":");
  const sign = negated ? "-" : "";
  if (colon === -1) {
    const keys = rank(KEYS, body, (k) => [k.label, k.key]).map((k) => ({
      id: k.key, label: k.label, glyph: k.glyph, hint: "", insert: { range, text: `${sign}${k.key}:` },
    }));
    const ops = negated ? [] : rank(OPS, body, (o) => [o.label]).map((o) => ({
      id: o.id, label: o.label, glyph: o.glyph, hint: "", insert: { range, text: o.text },
    }));
    // Reset filter: back to the configured default, defaultText (the controller handles {reset:true}). Not in a negation.
    const reset = negated || !rank([{ n: "Reset filter" }], body, (x) => [x.n]).length ? []
      : [{ id: "reset", label: "Reset filter", glyph: "↺", hint: defaultText, insert: { reset: true } }];
    const items = [...keys, ...ops, ...reset];
    return items.length ? { open: true, stage: "keys", range, typed: body, negated, items } : CLOSED;
  }
  const key = lc(body.slice(0, colon));
  const typed = body.slice(colon + 1);
  if (!KEYS.some((k) => k.key === key) || typed.includes('"')) return CLOSED;
  const tok = (k, value, neg) => ({ range, token: qualToken({ kind: "qual", key: k, value, negated: neg }) });
  const listed = [];
  if (PEOPLE.has(key)) listed.push({ id: "me", label: "Me", glyph: "@", hint: "@me", value: "@me" });
  // is:issue and is:pr exclude each other: with a positive one already in the query the other is not offered.
  const kinds = key === "is" && !negated ? tokenize(content).filter((n) => n.kind === "qual" && !n.negated && n.key === "is" && (n.value === "issue" || n.value === "pr")).map((n) => n.value) : [];
  const conflict = (v) => (v === "pr" && kinds.includes("issue")) || (v === "issue" && kinds.includes("pr"));
  for (const v of (FIXED[key] ?? []).filter((x) => !conflict(x))) listed.push({ id: v, label: v, glyph: "•", hint: KEYS.find((k) => k.key === key).label, value: v });
  if (key === "repo") for (const s of scopes.filter((x) => x.includes("/"))) listed.push({ id: s, label: s, glyph: "◆", hint: "scope", value: s });
  const t = lc(typed);
  // Source values (labels, people, milestones): rows after the fixed items, prefix matches first, capped.
  const source = (values[key] ?? []).map((v) => ({ id: `v:${v.login ?? v.value}`, name: v.login ?? v.value, avatar: v.avatar, color: v.color }));
  // The exact typed value goes first so the cap can never hide it.
  const ranked = rank(source, t, (x) => [x.name]);
  const exactAt = ranked.findIndex((x) => lc(x.name) === t);
  if (t && exactAt > 0) ranked.unshift(...ranked.splice(exactAt, 1));
  const sourceRows = ranked.slice(0, MAX_VALUES).map((x) => ({
    id: x.id, label: x.name, glyph: PEOPLE.has(key) ? "☺" : KEYS.find((k) => k.key === key).glyph, hint: "", avatar: x.avatar, insert: tok(key, x.name, negated),
  }));
  const shown = listed.filter((i) => !t || lc(i.value).startsWith(t) || lc(i.value).replace(/^@/, "").startsWith(t) || lc(i.label).startsWith(t))
    .map((i) => ({ id: i.id, label: i.label, glyph: i.glyph, hint: i.hint, insert: tok(key, i.value, negated) }));
  const items = [...shown, ...sourceRows];
  if (!negated && NO.has(key) && (!t || `no ${key}`.startsWith(t))) {
    items.push({ id: `no:${key}`, label: `No ${key}`, glyph: "∅", hint: `no:${key}`, insert: tok("no", key, false) });
  }
  if (!negated && (!t || "exclude".startsWith(t))) {
    items.push({ id: "exclude", label: "Exclude", glyph: "−", hint: `-${key}:`, insert: { range, text: `-${key}:` } });
  }
  if (typed && !conflict(t) && !listed.some((i) => lc(i.value) === t) && !source.some((x) => lc(x.name) === t)) {
    const outside = key === "repo" && scopes.length > 0 && scopes.every((s) => outsideScope([{ kind: "qual", key, value: typed, negated }], s));
    items.push({ id: "use", label: `Use ${typed}`, glyph: "↵", hint: outside ? "outside your scopes" : "", insert: tok(key, typed, negated) });
  }
  return { open: true, stage: "values", range, typed, negated, key, items };
}
