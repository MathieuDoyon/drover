// GitHub filter token input: pure helpers. ESM, imports ./query.js and ./tokenfilter.js (the generic part, shared with Jira), no I/O.
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
import { createTokenFilter, qualToken, createLoader } from "./tokenfilter.js";

export const QUERY_KEY = "drover.github.query";

export { qualToken, createLoader };
const tf = createTokenFilter({ parseQuery, defaultModel: DEFAULT_QUERY });
export const { defaultContent, contentFromModel, restoreContent, tokenize, wordToken, wordTokens, createController } = tf;

// The configured default (Drover Config / mod.json) as a model; text that parses to nothing falls back to DEFAULT_QUERY.
export function usableModel(text) {
  const m = parseQuery(text);
  return m.length ? m : DEFAULT_QUERY;
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
