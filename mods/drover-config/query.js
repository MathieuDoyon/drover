// GitHub filter query model and `gh search issues` argv. Pure ESM, no imports.
//
// Model: an array of nodes
//   {kind:"qual", key, value, negated}  a qualifier, e.g. label:bug or -author:@me
//   {kind:"op"}                         the OR operator
//   {kind:"text", text}                 one free search word
//
// API
//   parseQuery(text)  -> model. Split on whitespace; `-key:value` is negated; `key:"two words"`
//                        keeps the spaces (quotes stripped); an exact upper-case `OR` is the
//                        operator; anything else is a text word; a qualifier with an empty
//                        value is dropped.
//                        parseQuery text has no escape syntax (no backslashes): a value with an
//                        embedded quote must be built as a model node; toArgs keeps it verbatim.
//   toArgs(model)     -> string[]. One argv element per node. A qualifier is
//                        `(negated?"-":"")+key+":"+value` verbatim (spaces, quotes, Unicode,
//                        @me untouched, no quote characters added). `OR` and text words are
//                        their own elements. Accepts a model or a string.
//   DEFAULT_QUERY     -> parseQuery("is:issue state:open"); toArgs gives ["is:issue","state:open"].
//   outsideScope(query, scope) -> boolean. True when a NON-negated repo:/org:/user: qualifier
//                        lies outside the scope (org scope "o" allows repo:o/x, org:o, user:o;
//                        repo scope "o/r" allows only repo:o/r). Case-insensitive.
//   githubSearchArgs(scope, limit, fields, query) -> string[] | null.
//                        Empty query (undefined, null, "", []) gives exactly the legacy args
//                        with --state=open. With a query: the same prefix without --state, then
//                        "--", then toArgs(query) (state is a token). null when outsideScope.
//
// The model carries no I/O and no gh calls; callers run the returned argv.

const QUAL = /^(-?)([A-Za-z][A-Za-z0-9_-]*):([\s\S]*)$/;
const SCOPED = new Set(["repo", "org", "user"]);

function tokens(text) {
  const out = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = ""; has = false;
    } else if (c === ":" && text[i + 1] === '"') {
      cur += c; has = true;
      const end = text.indexOf('"', i + 2);
      const stop = end === -1 ? text.length : end;
      cur += text.slice(i + 2, stop);
      i = stop;
    } else {
      cur += c; has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function parseQuery(text) {
  const model = [];
  for (const tok of tokens(String(text ?? ""))) {
    if (tok === "OR") { model.push({ kind: "op" }); continue; }
    const m = QUAL.exec(tok);
    if (!m) { model.push({ kind: "text", text: tok }); continue; }
    if (m[3] === "") continue;
    model.push({ kind: "qual", key: m[2], value: m[3], negated: m[1] === "-" });
  }
  return model;
}

const asModel = (q) => (Array.isArray(q) ? q : parseQuery(q));

export const DEFAULT_QUERY = parseQuery("is:issue state:open");

export function toArgs(query) {
  return asModel(query).map((n) =>
    n.kind === "op" ? "OR" : n.kind === "text" ? n.text : `${n.negated ? "-" : ""}${n.key}:${n.value}`);
}

export function outsideScope(query, scope) {
  const s = String(scope).toLowerCase();
  return asModel(query).some((n) => {
    if (n.kind !== "qual" || n.negated || !SCOPED.has(n.key.toLowerCase())) return false;
    const v = n.value.toLowerCase();
    if (s.includes("/")) return !(n.key.toLowerCase() === "repo" && v === s);
    return n.key.toLowerCase() === "repo" ? !v.startsWith(`${s}/`) : v !== s;
  });
}

export function githubSearchArgs(scope, limit, fields, query) {
  const model = query == null ? [] : asModel(query);
  const scopeFlag = scope.includes("/") ? `--repo=${scope}` : `--owner=${scope}`;
  if (model.length === 0) {
    return ["search", "issues", "--include-prs", "--state=open", scopeFlag, `--limit=${limit}`, `--json=${fields}`];
  }
  if (outsideScope(model, scope)) return null;
  return ["search", "issues", "--include-prs", scopeFlag, `--limit=${limit}`, `--json=${fields}`, "--", ...toArgs(model)];
}
