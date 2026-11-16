// Jira filter key/value menu: pure item builders. ESM, no I/O, imports ./query.js and ./tokenmenu.js only.
// Same shape as the GitHub menu: menuState(content, caret?, {values, defaultText}) ->
//   {open:false, stage:null, items:[]} or {open:true, stage:"keys"|"values", range, typed, negated, key?, items}.
// item = {id, label, glyph, hint, insert}; insert is {range, text} (a key `status:`, Exclude `-status:`, OR),
// {range, token} (a structured qualToken) or {reset:true}. The caret is assumed at the END of the input (the host has no
// caret getter). The menu is closed inside a token, right after a token with no space, for an unknown key, a quoted value
// (`key:"..."`) and when nothing matches.
//
// Keys stage: the keys below, then AND (inserts nothing) / OR / Exclude (`-`), then Reset filter. Typing filters by prefix,
// then substring, on the label and the key (ass -> Assignee). With `-` typed only the keys show.
// Values stage (after `key:`): Me for people keys, Unassigned for assignee, fixed lists (sprint functions, date presets,
// sort orders), then Jira rows from the caller ({values:{status:[{value,hint?}], ...}}, see values.js: the menu never
// fetches), Exclude (`-key:`, not for Sort), and "Use <typed>" for a typed value that is not listed (a raw date such as
// `created:>2026-01-01` is typed this way). A value with spaces is one structured token, picked from the list.
import { qualToken } from "./query.js";
import { nextIndex, CLOSED, lc, rank, wordAt } from "./tokenmenu.js";

export { nextIndex };

export const KEYS = [
  { key: "project", label: "Project", glyph: "▤" },
  { key: "status", label: "Status", glyph: "◌" },
  { key: "assignee", label: "Assignee", glyph: "☺" },
  { key: "reporter", label: "Reporter", glyph: "☺" },
  { key: "type", label: "Type", glyph: "▦" },
  { key: "label", label: "Label", glyph: "#" },
  { key: "priority", label: "Priority", glyph: "▲" },
  { key: "sprint", label: "Sprint", glyph: "↻" },
  { key: "created", label: "Created", glyph: "▢" },
  { key: "updated", label: "Updated", glyph: "▣" },
  { key: "order", label: "Sort", glyph: "⇅" },
];
const OPS = [
  { id: "AND", label: "AND", glyph: "&", text: "" },
  { id: "OR", label: "OR", glyph: "|", text: "OR " },
  { id: "EXCLUDE", label: "Exclude", glyph: "−", text: "-" },
];
const PEOPLE = new Set(["assignee", "reporter"]);
const MAX_VALUES = 50;
const FIXED = {
  sprint: [["Open sprints", "openSprints()"], ["Closed sprints", "closedSprints()"], ["Future sprints", "futureSprints()"]],
  created: [["Last 7 days", ">-7d"], ["Last 30 days", ">-30d"]],
  updated: [["Last 7 days", ">-7d"], ["Last 30 days", ">-30d"]],
  order: ["updated-desc", "updated-asc", "created-desc", "created-asc", "priority-desc", "status-asc"].map((v) => [v, v]),
};

export function menuState(content, caret = content.text.length, { values = {}, defaultText = "" } = {}) {
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
    const reset = negated || !rank([{ n: "Reset filter" }], body, (x) => [x.n]).length ? []
      : [{ id: "reset", label: "Reset filter", glyph: "↺", hint: defaultText, insert: { reset: true } }];
    const items = [...keys, ...ops, ...reset];
    return items.length ? { open: true, stage: "keys", range, typed: body, negated, items } : CLOSED;
  }
  const key = lc(body.slice(0, colon));
  const typed = body.slice(colon + 1);
  const def = KEYS.find((k) => k.key === key);
  if (!def || typed.includes('"')) return CLOSED;
  const tok = (value) => ({ range, token: qualToken({ kind: "qual", key, value, negated }) });
  const t = lc(typed);
  const listed = [];
  if (PEOPLE.has(key)) listed.push({ id: "me", label: "Me", glyph: "@", hint: "currentUser()", value: "me" });
  if (key === "assignee") listed.push({ id: "unassigned", label: "Unassigned", glyph: "∅", hint: "EMPTY", value: "unassigned" });
  for (const [label, value] of FIXED[key] ?? []) listed.push({ id: value, label, glyph: def.glyph, hint: value === label ? "" : value, value });
  const shown = listed.filter((i) => !t || lc(i.label).startsWith(t) || lc(i.value).startsWith(t) || lc(i.value).replace(/^@/, "").startsWith(t));
  const source = (values[key] ?? []).map((v) => ({ id: `v:${v.value}`, name: v.value, hint: v.hint ?? "" }));
  const ranked = rank(source, t, (x) => [x.name]);
  const exactAt = ranked.findIndex((x) => lc(x.name) === t);
  if (t && exactAt > 0) ranked.unshift(...ranked.splice(exactAt, 1)); // the exact typed value goes first so the cap can never hide it
  const items = [
    ...shown.map((i) => ({ id: i.id, label: i.label, glyph: i.glyph, hint: i.hint, insert: tok(i.value) })),
    ...ranked.slice(0, MAX_VALUES).map((x) => ({ id: x.id, label: x.name, glyph: def.glyph, hint: x.hint, insert: tok(x.name) })),
  ];
  if (!negated && key !== "order" && (!t || "exclude".startsWith(t))) {
    items.push({ id: "exclude", label: "Exclude", glyph: "−", hint: `-${key}:`, insert: { range, text: `-${key}:` } });
  }
  if (typed && !listed.some((i) => lc(i.value) === t) && !source.some((x) => lc(x.name) === t)) {
    items.push({ id: "use", label: `Use ${typed}`, glyph: "↵", hint: "", insert: tok(typed) });
  }
  return { open: true, stage: "values", range, typed, negated, key, items };
}
