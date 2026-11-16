// Jira filter query model and JQL. ESM, imports ./tokenfilter.js only, no I/O.
//
// Model: the same nodes as the GitHub filter
//   {kind:"qual", key, value, negated}  e.g. status:"In Progress", -assignee:me
//   {kind:"op"}                         the OR operator
//   {kind:"text", text}                 one free word -> text ~ "word"
//
// Keys: project status assignee reporter type label priority sprint created updated order jql.
//   parseQuery(text)  -> model. Whitespace words; `-key:value` negates; `key:"two words"` keeps spaces; an exact
//                        upper-case OR is the operator; an unknown key or a word without a value is a text word
//                        (an empty value is dropped).
//   toJql(model)      -> JQL string ("" for an empty model). AND is implicit, OR joins the clauses beside it.
//                        EVERY value is JQL-quoted and escaped (backslash, quote, \n \r \t; other control chars removed),
//                        so a value can never break out of its string. Exceptions that are NOT quoted, by exact match only:
//                        assignee/reporter `me` | `@me` -> currentUser(), `unassigned` | `empty` -> EMPTY, and the sprint
//                        functions openSprints() closedSprints() futureSprints() (`sprint in ...`).
//                        created/updated: an optional leading > >= < <= = != then the value (default =), quoted.
//                        order:field[-asc|-desc] -> ORDER BY at the end (default ASC); an unknown field throws.
//                        jql:"..." is the person's own JQL, emitted verbatim in parentheses (alone: with none); its trailing ORDER BY
//                        moves to the end (an explicit order: token wins over it). Negated -> NOT (...).
//   jqlModel(text)    -> the one-token model of a JQL text; [] for blank text. Whitespace outside quotes collapses; a quoted
//                        literal keeps its text (a raw newline in it becomes the equal escape \\n). ORDER BY text inside a quoted literal is not a sort.
//   QUERY_KEY, DEFAULT_QUERY ([]), qualToken, tokenize, contentFromModel, restoreContent, defaultContent,
//   wordToken, wordTokens, createController, createLoader: from tokenfilter.js.
import { createTokenFilter, qualToken, createLoader } from "./tokenfilter.js";

export const QUERY_KEY = "drover.jira.query";
export const KEYS = ["project", "status", "assignee", "reporter", "type", "label", "priority", "sprint", "created", "updated", "order", "jql"];
export const DEFAULT_QUERY = [];

const FIELD = { project: "project", status: "status", assignee: "assignee", reporter: "reporter", type: "issuetype", label: "labels", priority: "priority", sprint: "sprint" };
const PEOPLE = new Set(["assignee", "reporter"]);
const SPRINT_FUNCS = new Set(["opensprints()", "closedsprints()", "futuresprints()"]);
const ORDER_FIELDS = new Set(["created", "updated", "priority", "status", "key", "summary", "assignee", "reporter", "duedate", "resolutiondate", "rank"]);
const QUAL = /^(-?)([A-Za-z]+):([\s\S]*)$/;

function words(text) {
  const out = [];
  let cur = "", has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) { if (has) out.push(cur); cur = ""; has = false; continue; }
    if (c === ":" && text[i + 1] === '"') {
      cur += c; has = true;
      const end = text.indexOf('"', i + 2);
      const stop = end === -1 ? text.length : end;
      cur += text.slice(i + 2, stop);
      i = stop;
    } else { cur += c; has = true; }
  }
  if (has) out.push(cur);
  return out;
}

export function parseQuery(text) {
  const model = [];
  for (const w of words(String(text ?? ""))) {
    if (w === "OR") { model.push({ kind: "op" }); continue; }
    const m = QUAL.exec(w);
    const key = m?.[2].toLowerCase();
    if (!m || !KEYS.includes(key)) { model.push({ kind: "text", text: w }); continue; }
    if (m[3] === "") continue;
    model.push({ kind: "qual", key, value: m[3], negated: m[1] === "-" });
  }
  return model;
}

// Whitespace outside quotes collapses to one space (a token must hold no raw newline); inside a quoted literal it is kept
// verbatim, except that a raw newline, return or tab becomes its JQL escape (the same value) and other control chars drop.
const ESC = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const lit = (c) => ESC[c] ?? (/[\u0000-\u001f\u007f]/.test(c) ? "" : c);
function normalize(text) {
  let out = "", q = null, gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") { out += c + lit(text[i + 1] ?? ""); i++; continue; }
      if (c === q) q = null;
      out += lit(c);
      continue;
    }
    if (/\s/.test(c)) { gap = true; continue; }
    if (gap && out) out += " ";
    gap = false;
    if (c === '"' || c === "'") q = c;
    out += c;
  }
  return out;
}
export const jqlModel = (text) => {
  const v = normalize(String(text ?? ""));
  return v ? [{ kind: "qual", key: "jql", value: v, negated: false }] : [];
};

// A raw JQL split at its real ORDER BY: the first one outside quoted text (and escapes), always the last clause.
function splitOrder(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (i === 0 || /[\s)]/.test(text[i - 1])) {
      const m = /^order\s+by\s+/i.exec(text.slice(i));
      if (m) return { cond: text.slice(0, i).trim(), order: text.slice(i + m[0].length).trim() };
    }
  }
  return { cond: text.trim(), order: "" };
}

const tf = createTokenFilter({ parseQuery, defaultModel: DEFAULT_QUERY });
export { qualToken, createLoader };
export const { defaultContent, contentFromModel, restoreContent, tokenize, wordToken, wordTokens, createController } = tf;

const jq = (s) => `"${String(s).replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/[\u0000-\u001f\u007f]/g, "")}"`;

function clause(n) {
  const neg = n.negated;
  const v = n.value;
  if (n.key === "jql") return neg ? `NOT (${v})` : `(${v})`;
  if (n.key === "created" || n.key === "updated") {
    const m = /^(>=|<=|!=|>|<|=)?\s*([\s\S]*)$/.exec(v);
    const c = `${n.key} ${m[1] ?? "="} ${jq(m[2])}`;
    return neg ? `NOT (${c})` : c;
  }
  const field = FIELD[n.key];
  if (PEOPLE.has(n.key)) {
    const l = v.toLowerCase();
    if (l === "me" || l === "@me") return `${field} ${neg ? "!=" : "="} currentUser()`;
    if (l === "unassigned" || l === "empty") return `${field} ${neg ? "!=" : "="} EMPTY`;
  }
  if (n.key === "sprint" && SPRINT_FUNCS.has(v.toLowerCase())) return `sprint ${neg ? "not in" : "in"} ${v}`;
  return `${field} ${neg ? "!=" : "="} ${jq(v)}`;
}

function orderBy(v) {
  const m = /^([A-Za-z]+)(?:-(asc|desc))?$/i.exec(v);
  if (!m || !ORDER_FIELDS.has(m[1].toLowerCase())) throw new Error(`Unknown sort "${v}". Use order:updated-desc (fields: ${[...ORDER_FIELDS].join(", ")}).`);
  return `${m[1].toLowerCase()} ${(m[2] ?? "asc").toUpperCase()}`;
}

export function toJql(model) {
  let out = "", have = false, or = false, parts = 0, sole = null;
  const sorts = [];
  let rawSort = "";
  for (const n of model) {
    if (n.kind === "op") { if (have) or = true; continue; }
    let c;
    if (n.kind === "text") c = `text ~ ${jq(n.text)}`;
    else if (n.key === "order") { if (!n.negated) sorts.push(orderBy(n.value)); continue; }
    else if (n.key === "jql") {
      const { cond, order } = splitOrder(n.value);
      if (order && !n.negated) rawSort = order;
      if (!cond) continue;
      c = clause({ ...n, value: cond });
      if (!n.negated) sole = cond;
    } else c = clause(n);
    parts++;
    out += have ? (or ? " OR " : " AND ") + c : c;
    have = true; or = false;
  }
  if (parts === 1 && sole !== null) out = sole; // one raw JQL token alone is sent as it is, without parentheses
  const order = sorts.length ? sorts.join(", ") : rawSort;
  return order ? `${out}${out ? " " : ""}ORDER BY ${order}` : out;
}
