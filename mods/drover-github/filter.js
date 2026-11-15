// GitHub filter token input: pure helpers. ESM, only imports ./query.js, no I/O.
//
// Input content (host InputContent): {text, tokens:[{range:{start,end}, token:{id,text,label}}]}.
// A qualifier is a token whose id is JSON {key,value,negated}. Its value is read back from the
// id, never reparsed from the display text, so a value with spaces or quotes survives intact.
// Only the plain text between tokens goes through parseQuery.
//
//   QUERY_KEY                       shared key the committed content is saved under.
//   qualToken(node)                 -> {id,text,label}. text/label are `[-]key:value`, value
//                                      wrapped in quotes when it has whitespace (display only).
//   defaultContent()                -> content with the is:issue and state:open tokens.
//   contentFromModel(model)         -> content: qualifiers become tokens, others plain text.
//   usableModel(text)               -> model of the configured default query text; DEFAULT_QUERY when it parses to nothing.
//   restoreContent(saved, fallback) -> content. Missing or invalid saved value -> fallback (default: is:issue state:open);
//                                      a valid empty content stays empty (the user cleared the filter).
//   tokenize(content)               -> query model (nodes in input order).
//   wordToken(content, caret)       -> {range, token} | null. The word ending at the caret (the
//                                      caret may sit after the space just typed) if it is a
//                                      `key:value` qualifier outside any token; null otherwise
//                                      (plain words, OR, empty value, an unclosed quote). With
//                                      {delimited:true} the char before the caret must be whitespace
//                                      (the change path); without it an unterminated word converts (Enter).
//   wordTokens(content,{final})     -> [{range,token}] every complete key:value word in the plain spans
//                                      (quote-aware); the word at the very end converts only with final.
//   ghErrorMessage(stderr,scope,model) -> user-facing text for a failed gh call.
//   createLoader({run,onResult,onError}) latest-wins request runner, see below.
//   createController({input,scopes,save,enqueue}) the view's event logic over an InputState-like
//                                      input; see below.
//   planRequests(scopes,limit,fields,model) -> [{scope,args}] skipping scopes the query is outside of.
//   emptyText(model, scopes)        -> filter-aware message for an empty result.
import { parseQuery, toArgs, outsideScope, DEFAULT_QUERY, githubSearchArgs } from "./query.js";

export const QUERY_KEY = "drover.github.query";

const CONTROL = /[\u0000-\u001f\u007f]/;
const stripOk = (s) => typeof s === "string" && s.length > 0 && !CONTROL.test(s);

function display(node) {
  const v = /\s/.test(node.value) ? `"${node.value}"` : node.value;
  return `${node.negated ? "-" : ""}${node.key}:${v}`;
}

export function qualToken(node) {
  const text = display(node);
  return { id: JSON.stringify({ key: node.key, value: node.value, negated: Boolean(node.negated) }), text, label: text };
}

function nodeOf(token) {
  try {
    const o = JSON.parse(token.id);
    if (o && typeof o.key === "string" && o.key && typeof o.value === "string" && o.value
      && typeof o.negated === "boolean") return { kind: "qual", key: o.key, value: o.value, negated: o.negated };
  } catch { /* not ours */ }
  return null;
}

export function contentFromModel(model) {
  let text = "";
  const tokens = [];
  for (const n of model) {
    if (n.kind === "qual") {
      const token = qualToken(n);
      tokens.push({ range: { start: text.length, end: text.length + token.text.length }, token });
      text += `${token.text} `;
    } else {
      text += `${n.kind === "op" ? "OR" : n.text} `;
    }
  }
  return { text, tokens };
}

export const defaultContent = () => contentFromModel(DEFAULT_QUERY);

// The configured default (Drover Config / mod.json) as a model; text that parses to nothing falls back to DEFAULT_QUERY.
export function usableModel(text) {
  const m = parseQuery(text);
  return m.length ? m : DEFAULT_QUERY;
}

function valid(c) {
  if (!c || typeof c !== "object" || typeof c.text !== "string" || !Array.isArray(c.tokens)) return false;
  let prev = 0;
  for (const s of c.tokens) {
    const r = s?.range, t = s?.token;
    if (!r || !t || !Number.isInteger(r.start) || !Number.isInteger(r.end)) return false;
    if (r.start < prev || r.end <= r.start || r.end > c.text.length) return false;
    if (![t.id, t.text, t.label].every(stripOk) || c.text.slice(r.start, r.end) !== t.text) return false;
    if (!nodeOf(t)) return false;
    prev = r.end;
  }
  return true;
}

export function restoreContent(saved, fallback = defaultContent()) {
  return valid(saved) ? { text: saved.text, tokens: saved.tokens.map((s) => ({ range: { ...s.range }, token: { ...s.token } })) } : fallback;
}

export function tokenize(content) {
  const model = [];
  let at = 0;
  const spans = [...content.tokens].sort((a, b) => a.range.start - b.range.start);
  for (const s of spans) {
    model.push(...parseQuery(content.text.slice(at, s.range.start)));
    const n = nodeOf(s.token);
    if (n) model.push(n);
    at = s.range.end;
  }
  model.push(...parseQuery(content.text.slice(at)));
  return model;
}

// Words of text[from,to) with offsets; `:"` opens a quote that runs to the next quote.
function words(text, from, to) {
  const out = [];
  let start = -1, open = false;
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (start >= 0) { out.push({ start, end: i, open: false }); start = -1; }
      continue;
    }
    if (start < 0) start = i;
    if (c === ":" && text[i + 1] === '"') {
      const close = text.indexOf('"', i + 2);
      if (close === -1 || close >= to) { open = true; i = to; } else i = close;
    }
  }
  if (start >= 0) out.push({ start, end: to, open });
  return out;
}

export function wordToken(content, caret, { delimited = false } = {}) {
  const { text, tokens } = content;
  if (delimited && !(caret > 0 && /\s/.test(text[caret - 1]))) return null;
  let end = Math.min(caret, text.length);
  if (end > 0 && /\s/.test(text[end - 1])) end--;
  if (tokens.some((s) => s.range.start < end && end <= s.range.end)) return null;
  const from = tokens.reduce((m, s) => (s.range.end <= end ? Math.max(m, s.range.end) : m), 0);
  const last = words(text, from, end).at(-1);
  if (!last || last.end !== end || last.open) return null;
  const parsed = parseQuery(text.slice(last.start, last.end));
  if (parsed.length !== 1 || parsed[0].kind !== "qual") return null;
  return { range: { start: last.start, end: last.end }, token: qualToken(parsed[0]) };
}

export function wordTokens(content, { final = false } = {}) {
  const { text } = content;
  const spans = [...content.tokens].sort((a, b) => a.range.start - b.range.start);
  const out = [];
  let at = 0;
  const scan = (from, to) => {
    for (const w of words(text, from, to)) {
      if (w.open || (!final && w.end === text.length)) continue;
      const parsed = parseQuery(text.slice(w.start, w.end));
      if (parsed.length === 1 && parsed[0].kind === "qual") out.push({ range: { start: w.start, end: w.end }, token: qualToken(parsed[0]) });
    }
  };
  for (const s of spans) { scan(at, s.range.start); at = s.range.end; }
  scan(at, text.length);
  return out;
}

export function ghErrorMessage(stderr, scope, model) {
  const first = String(stderr ?? "").trim().split("\n")[0];
  // Ends with a period: the list view appends " Showing the last good list."
  const sentence = (t) => (t.endsWith(".") ? t : `${t}.`);
  if (/invalid search query/i.test(first)) {
    return sentence(`GitHub rejected the query (unknown user, label or qualifier?): ${toArgs(model).join(" ")}`);
  }
  return sentence(`gh failed for ${scope}: ${first || "no output"}`);
}

// Latest wins: a commit while a request runs replaces the one queued behind it. When the running
// request finishes and something newer is queued, its result (or error) is dropped and the newest
// runs. commit() resolves when the queue is empty.
export function createLoader({ run, onResult, onError }) {
  let running = null, pending = null, drain = null;
  async function loop() {
    while (running) {
      const req = running;
      let ok = false, value, error;
      try { value = await run(req); ok = true; } catch (e) { error = e; }
      if (pending) { running = pending; pending = null; continue; }
      try { if (ok) onResult?.(req, value); else onError?.(req, error); } catch { /* a view error must not wedge the queue */ }
      running = null;
    }
  }
  return {
    commit(req) {
      if (running) { pending = req; return drain; }
      running = req;
      drain = loop();
      return drain;
    },
    state: () => ({ running, pending }),
  };
}

export function planRequests(scopes, limit, fields, model) {
  return scopes.map((scope) => ({ scope, args: githubSearchArgs(scope, limit, fields, model) })).filter((p) => p.args);
}

export function emptyText(model, scopes) {
  if (!scopes.length) return "Add an org or repo with + scope to search.";
  const args = toArgs(model);
  if (model.length && scopes.every((s) => outsideScope(model, s))) {
    return `${args.join(" ")} is outside your scopes. Add its org or repo with + scope.`;
  }
  const state = model.find((n) => n.kind === "qual" && !n.negated && n.key === "state" && n.value !== "open");
  if (state) return `Nothing ${state.value} matches this filter in these scopes.`;
  // "Nothing open" only for a query that is exactly open: no filter, or state:open with is:issue/is:pr.
  const kinds = new Set(["issue", "pr"]);
  const openOnly = model.every((n) => n.kind === "qual" && !n.negated
    && ((n.key === "state" && n.value === "open") || (n.key === "is" && kinds.has(n.value))));
  const open = model.length === 0 || (openOnly && model.some((n) => n.key === "state"));
  return open ? "Nothing open in these scopes." : `Nothing matches ${args.join(" ")} in these scopes.`;
}

// The view's event logic, kept pure. `input` is InputState-like (content, replace_range_with_token,
// set_selected_range, replace); save(content) persists the committed content; enqueue({query,scopes})
// hands the request to the loader. Every token insert or removal is synced explicitly (model, save,
// enqueue) and never relies on the host firing 'change' after a programmatic edit; a change event
// that shows a different token set (Backspace removal) syncs the same way.
//   onChange()          every complete (followed-by-more-text) key:value word -> token; token set changed -> apply.
//   onSubmit()          Enter: every key:value word, the last one too -> tokens; always apply.
//                       Leftover plain text stays in the query as search words.
//   onTokenClick(range) remove that token; apply.
//   pick(insert)        a menu pick: {reset:true} -> onReset() (scopes back to Config), defaults() tokens (the configured default; is:issue state:open when not given) + apply; text -> replace the range; token -> insert it + a space, then apply.
//   adopt()             take the input as it is now as the committed query and enqueue it, saving nothing (the configured
//                       default arrived after init).
//   refresh()           enqueue the current model with the current scopes (also for no scopes,
//                       which supersedes any in-flight request).
//   model()             the committed query model.
export function createController({ input, scopes, save, enqueue, defaults = defaultContent, onReset = () => {} }) {
  const key = (c) => c.tokens.map((s) => s.token.id).join("\n");
  let last = key(input.content());
  let model = tokenize(input.content());
  const refresh = () => enqueue({ query: model, scopes: [...scopes()] });
  function apply() {
    const content = input.content();
    last = key(content);
    model = tokenize(content);
    save(content);
    refresh();
  }
  // Right to left, so earlier ranges stay valid while later words become tokens.
  function convert(final) {
    for (const w of wordTokens(input.content(), { final }).reverse()) input.replace_range_with_token(w.range, w.token);
  }
  return {
    onChange() {
      convert(false);
      if (key(input.content()) !== last) apply();
    },
    // A host error from a token edit propagates before anything is saved or searched.
    onSubmit() {
      convert(true);
      apply();
    },
    onTokenClick(range) {
      input.set_selected_range(range);
      input.replace("");
      apply();
    },
    // A menu pick ({range,text} | {range,token}, see menu.js). A text pick only edits the input. A token
    // pick inserts the structured token, a space after it unless one follows, then syncs like Enter does.
    pick(insert) {
      if (insert.reset) {
        onReset(); // the view forgets the saved scopes and the old snapshot before the request reads scopes()
        input.set_value(defaults());
        apply();
        return;
      }
      if (!insert.token) {
        input.set_selected_range(insert.range);
        input.replace(insert.text);
        return;
      }
      input.replace_range_with_token(insert.range, insert.token);
      const end = insert.range.start + insert.token.text.length;
      if (!/\s/.test(input.content().text[end] ?? "")) {
        input.set_selected_range({ start: end, end });
        input.replace(" ");
      }
      apply();
    },
    adopt() {
      last = key(input.content());
      model = tokenize(input.content());
      refresh();
    },
    refresh,
    model: () => model,
  };
}
