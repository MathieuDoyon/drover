// GitHub filter value sources: labels, people and milestones for the key/value menu. ESM, no host imports.
//
//   ghApiArgs(scope, key)        -> ['api', 'repos/<o>/<r>/<labels|assignees|milestones…>'] | null (org scope or other key)
//   parseValues(key, json)       -> [{value,color}] labels | [{login,avatar}] people | [{value}] milestones, at most 100.
//                                   Throws on anything that is not a list (a 403 answer is an object).
//   avatarUrl(login)             -> https://github.com/<login>.png?size=40
//   createValues({exec, now})    lazy cache over `exec("gh", args)` -> {code, stdout, stderr}.
//     fetch(key, scopes)         one gh api call per repo scope and endpoint; fresh 5 min, a failure is remembered 60 s.
//                                In-flight calls are shared. Never throws. Only this call touches the network.
//     stale(key, scopes)         true when some repo scope has nothing fresh cached (cache expiry makes it true again).
//     peek(scope, key)           -> {ok, values} | null (nothing cached or expired). No network.
//   valuesFor(key, scopes, items, cache) -> the menu rows for the key: the API list for repo scopes, values seen on
//                                the loaded items for org scopes and failed or not yet fetched repo lookups. Milestones
//                                come from the API only (no list otherwise: free text). Deduped, case-insensitive, bounded.
export const TTL = 5 * 60 * 1000;
export const FAIL_TTL = 60 * 1000;
export const CAP = 100;

const PEOPLE = new Set(["assignee", "author", "involves", "mentions", "review-requested"]);
const ENDPOINT = { label: "labels?per_page=100", milestone: "milestones?state=open&per_page=100" };
const kind = (key) => (PEOPLE.has(key) ? "assignee" : key);
const isRepo = (scope) => scope.includes("/");

export const avatarUrl = (login) => `https://github.com/${login}.png?size=40`;

export function ghApiArgs(scope, key) {
  if (!isRepo(scope)) return null;
  const path = PEOPLE.has(key) ? "assignees?per_page=100" : ENDPOINT[key];
  return path ? ["api", `repos/${scope}/${path}`] : null;
}

export function parseValues(key, json) {
  if (!Array.isArray(json)) throw new Error("gh answered in an unknown format.");
  const out = [];
  for (const x of json) {
    if (PEOPLE.has(key)) {
      if (typeof x?.login === "string" && x.login) out.push({ login: x.login, avatar: avatarUrl(x.login) });
    } else if (key === "label") {
      if (typeof x?.name === "string" && x.name) out.push({ value: x.name, color: typeof x.color === "string" ? x.color : "" });
    } else if (typeof x?.title === "string" && x.title) out.push({ value: x.title });
  }
  return out.slice(0, CAP);
}

export function createValues({ exec, now = Date.now }) {
  const cache = new Map(); // `${scope}|${kind}` -> {at, ttl, ok, values}
  const flying = new Map();
  const id = (scope, key) => `${scope}|${kind(key)}`;
  const peek = (scope, key) => {
    const e = cache.get(id(scope, key));
    if (!e) return null;
    if (now() - e.at >= e.ttl) { cache.delete(id(scope, key)); return null; }
    return { ok: e.ok, values: e.values };
  };
  const one = (scope, key) => {
    const k = id(scope, key);
    if (peek(scope, key)) return Promise.resolve();
    if (flying.has(k)) return flying.get(k);
    const run = (async () => {
      let entry;
      try {
        const r = await exec("gh", ghApiArgs(scope, key), { timeout: 30000 });
        if (r.code !== 0) throw new Error(String(r.stderr ?? "").trim() || `gh exited ${r.code}`);
        entry = { ok: true, ttl: TTL, values: parseValues(key, JSON.parse(r.stdout)) };
      } catch {
        entry = { ok: false, ttl: FAIL_TTL, values: [] };
      }
      cache.set(k, { ...entry, at: now() });
    })().finally(() => flying.delete(k));
    flying.set(k, run);
    return run;
  };
  const fetch = async (key, scopes) => {
    await Promise.all(scopes.filter((s) => ghApiArgs(s, key)).map((s) => one(s, key)));
  };
  // True when a repo scope has no fresh entry for the key: the caller may fetch. No network.
  const stale = (key, scopes) => scopes.some((s) => ghApiArgs(s, key) && !peek(s, key));
  return { fetch, peek, stale };
}

// Values seen on the loaded items of one scope (an org covers its repos).
function seen(key, scope, items) {
  const s = scope.toLowerCase();
  const mine = items.filter((i) => (isRepo(scope) ? String(i.repo).toLowerCase() === s : String(i.repo).toLowerCase().startsWith(`${s}/`)));
  if (key === "label") return mine.flatMap((i) => i.labels ?? []).map((value) => ({ value, color: "" }));
  if (key === "author") return mine.map((i) => i.author).filter(Boolean).map((login) => ({ login, avatar: avatarUrl(login) }));
  if (PEOPLE.has(key)) {
    return mine.flatMap((i) => (key === "assignee" ? i.assignees ?? [] : [i.author, ...(i.assignees ?? [])])).filter(Boolean).map((login) => ({ login, avatar: avatarUrl(login) }));
  }
  return [];
}

export function valuesFor(key, scopes, items, cache) {
  const rows = [];
  for (const scope of scopes) {
    const hit = isRepo(scope) ? cache.peek(scope, key) : null;
    rows.push(...(hit?.ok ? hit.values : seen(key, scope, items ?? [])));
  }
  const name = (r) => (r.login ?? r.value).toLowerCase();
  const seenNames = new Set();
  const out = [];
  for (const r of rows) {
    if (seenNames.has(name(r))) continue;
    seenNames.add(name(r));
    out.push(r);
    if (out.length >= CAP) break;
  }
  return out;
}
