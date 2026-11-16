// Jira filter value sources: projects, statuses, people, types, priorities and labels for the key/value menu.
// ESM, no host imports: the caller injects the request function (main.js passes io.js jiraFetch, which checks the site
// and reads the credential), so this file never touches the network or the credential file itself.
//
//   pathFor(key)             -> REST path | null (sprint, created, updated, order and jql have no list).
//   parseValues(key, json)   -> [{value, hint?}] at most 100, deduped; people: active atlassian users by display name.
//                               Throws on anything that is not the expected shape.
//   createValues({fetch, site, enabled, now}) lazy cache over fetch(site, path, init, current).
//     fetch(key)             one request per site and endpoint; fresh 5 min, a failure is remembered 60 s; in-flight calls are
//                            shared; never throws. Starts NO request when enabled() is false or site() is empty.
//     stale(key)             true when the key has an endpoint, Jira is on with a site, and nothing fresh is cached.
//     peek(key)              -> {ok, values} | null. No network.
//   valuesFor(key, cache)    -> the menu rows for the key ([] when nothing is cached or the call failed).
export const TTL = 5 * 60 * 1000;
export const FAIL_TTL = 60 * 1000;
export const CAP = 100;

const PATH = {
  project: "/rest/api/3/project/search?maxResults=100&orderBy=name",
  status: "/rest/api/3/status",
  assignee: "/rest/api/3/users/search?maxResults=100",
  type: "/rest/api/3/issuetype",
  priority: "/rest/api/3/priority",
  label: "/rest/api/3/label?maxResults=100",
};
const kind = (key) => (key === "reporter" ? "assignee" : key);
export const pathFor = (key) => PATH[kind(key)] ?? null;

const list = (json, pick) => {
  const a = pick(json);
  if (!Array.isArray(a)) throw new Error("Jira answered in an unknown format.");
  return a;
};

export function parseValues(key, json) {
  const k = kind(key);
  const out = [];
  const seen = new Set();
  const add = (value, hint) => {
    if (typeof value !== "string" || !value || seen.has(value.toLowerCase())) return;
    seen.add(value.toLowerCase());
    out.push(hint ? { value, hint } : { value });
  };
  if (k === "project") for (const x of list(json, (j) => j?.values)) add(x?.key, typeof x?.name === "string" ? x.name : "");
  else if (k === "assignee") for (const x of list(json, (j) => j)) { if (x?.accountType === "atlassian" && x.active !== false) add(x.displayName); }
  else if (k === "label") for (const x of list(json, (j) => j?.values)) add(x);
  else for (const x of list(json, (j) => j)) add(x?.name);
  return out.slice(0, CAP);
}

export function createValues({ fetch, site, enabled, now = Date.now }) {
  const cache = new Map(); // `${site}|${kind}` -> {at, ttl, ok, values}: the site is part of the key, a switch never shows the old site's rows
  const flying = new Map();
  const on = () => Boolean(enabled() && site());
  const idOf = (key, s = site()) => `${s}|${kind(key)}`;
  const peek = (key) => {
    const id = idOf(key);
    const e = cache.get(id);
    if (!e) return null;
    if (now() - e.at >= e.ttl) { cache.delete(id); return null; }
    return { ok: e.ok, values: e.values };
  };
  const get = async (key) => {
    if (!pathFor(key) || !on() || peek(key)) return;
    const s = site();
    const k = idOf(key, s);
    if (flying.has(k)) return flying.get(k);
    const run = (async () => {
      let entry;
      try {
        const json = await fetch(s, pathFor(key), undefined, () => enabled() && site() === s);
        entry = { ok: true, ttl: TTL, values: parseValues(key, json) };
      } catch {
        entry = { ok: false, ttl: FAIL_TTL, values: [] };
      }
      if (enabled() && site() === s) cache.set(k, { ...entry, at: now() }); // a late answer of an old site (or a screen switched off) is dropped
    })().finally(() => flying.delete(k));
    flying.set(k, run);
    return run;
  };
  return { fetch: get, peek, stale: (key) => Boolean(pathFor(key)) && on() && !peek(key) };
}

export const valuesFor = (key, cache) => { const hit = cache.peek(key); return hit?.ok ? hit.values : []; };
