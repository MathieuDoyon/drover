// Canonical copy lives in mods/_lib. Pure parsing for the Jira and GitHub mods (read-only).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function base64(text) {
  // The mod runtime has no TextEncoder: UTF-8 by hand.
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

// HTTP failure → a message the person can act on. Never includes the response body.
export function httpProblem(status) {
  if (status === 401) return "Jira rejected the token (expired or wrong). Replace ~/.config/drover-herdr/atlassian.json.";
  if (status === 403) return "Jira refused access (permission denied).";
  if (status === 404) return "Jira endpoint not found: check the site.";
  if (status === 429) return "Jira rate limit: try again in a minute.";
  if (status === 400) return "Jira refused the JQL: check the query.";
  return `Jira answered HTTP ${status}.`;
}

// One page of POST /rest/api/3/search/jql → rows. Throws on a shape we don't understand,
// so a login page or a changed API never looks like "no work".
export function jiraPage(json, site) {
  if (!json || !Array.isArray(json.issues)) throw new Error("Jira answered in an unknown format.");
  const items = json.issues.map((i) => {
    if (typeof i?.id !== "string" || typeof i?.key !== "string") throw new Error("Jira issue without id/key.");
    const f = i.fields ?? {};
    return {
      id: `${site}/${i.id}`,
      key: i.key,
      title: String(f.summary ?? ""),
      status: f.status?.name ?? "?",
      done: f.status?.statusCategory?.key === "done",
      priority: f.priority?.name ?? null,
      type: f.issuetype?.name ?? null,
      updated: f.updated ? Date.parse(f.updated) : null,
      url: `https://${site}/browse/${i.key}`,
    };
  });
  return { items, next: typeof json.nextPageToken === "string" && !json.isLast ? json.nextPageToken : null };
}

// Scopes: "org" or "owner/repo". Anything else is refused, so typos never widen the search.
export function parseScope(text) {
  const s = String(text ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  return /^[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/.test(s) ? s : null;
}

export const inScope = (repo, scopes) =>
  scopes.some((s) => (s.includes("/") ? repo.toLowerCase() === s.toLowerCase() : repo.toLowerCase().startsWith(`${s.toLowerCase()}/`)));

// gh search issues --json number,title,repository,url,isPullRequest,updatedAt,state
// The non-empty strings of a gh JSON list, at most `max` of them.
const names = (list, pick, max) => (Array.isArray(list) ? list.map(pick).filter((s) => typeof s === "string" && s) : []).slice(0, max);

export function githubItems(json, scopes) {
  if (!Array.isArray(json)) throw new Error("gh answered in an unknown format.");
  return json
    .map((i) => ({
      id: i.url,
      key: `${i.repository?.nameWithOwner}#${i.number}`,
      repo: i.repository?.nameWithOwner ?? "",
      title: String(i.title ?? ""),
      pr: Boolean(i.isPullRequest),
      state: i.state ?? "?",
      updated: i.updatedAt ? Date.parse(i.updatedAt) : null,
      url: i.url,
      labels: names(i.labels, (l) => l?.name, 20),
      author: typeof i.author?.login === "string" ? i.author.login : "",
      assignees: names(i.assignees, (a) => a?.login, 10),
    }))
    .filter((i) => inScope(i.repo, scopes));
}

export function age(ms, now = Date.now()) {
  if (ms == null) return "";
  const m = Math.floor((now - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

// GET /rest/api/3/issue/KEY?fields=summary,status,assignee,project,issuetype,parent
export function jiraIssue(json, site) {
  if (typeof json?.key !== "string") throw new Error("Jira answered in an unknown format.");
  const f = json.fields ?? {};
  const p = f.parent;
  return {
    kind: "jira", key: json.key, title: String(f.summary ?? ""), url: `https://${site}/browse/${json.key}`,
    status: f.status?.name ?? "?", category: f.status?.statusCategory?.key ?? null,
    assignee: f.assignee?.displayName ?? null, project: f.project?.name ?? null, type: f.issuetype?.name ?? null,
    parent: p?.key ? { key: p.key, title: String(p.fields?.summary ?? ""), status: p.fields?.status?.name ?? null,
      category: p.fields?.status?.statusCategory?.key ?? null, url: `https://${site}/browse/${p.key}` } : null,
  };
}

// The Jira key in a source url (https://site/browse/KEY), or null.
export const jiraKey = (url) => String(url ?? "").match(/\/browse\/([A-Z][A-Z0-9]*-\d+)$/)?.[1] ?? null;

// A pasted issue link as a task source ({kind, id, url}, the shape an import writes), or null: GitHub issue/PR or Jira browse URL only.
// GitHub id = url, as the importer. Jira id = host/KEY (the importer's numeric id is not in the url).
export function parseSourceUrl(text) {
  const u = String(text ?? "").trim().replace(/\/+$/, "");
  const gh = u.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)$/);
  if (gh) { const url = `https://github.com/${gh[1]}/${gh[2]}/${gh[3]}`; return { kind: "github", id: url, url }; }
  const jira = u.match(/^https:\/\/([a-z0-9.-]+\.[a-z]{2,})\/browse\/([A-Z][A-Z0-9]*-\d+)$/);
  return jira ? { kind: "jira", id: `${jira[1]}/${jira[2]}`, url: u } : null;
}

// Label for the issue's project row: a GitHub issue's "project" is its repo.
export const projectLabel = (issue) => (issue?.kind === "github" ? "GitHub repo" : "Jira project");

// gh issue view|pr view <url> --json number,title,state,assignees,url[,closedByPullRequestsReferences]
export function githubIssue(json, url) {
  if (typeof json?.number !== "number") throw new Error("gh answered in an unknown format.");
  const repo = String(url).match(/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? null;
  return {
    kind: "github", key: `${repo}#${json.number}`, title: String(json.title ?? ""), url: json.url ?? url,
    status: json.state ?? "?", category: /CLOSED|MERGED/.test(json.state ?? "") ? "done" : "indeterminate",
    assignee: (json.assignees ?? []).map((a) => a.login).join(", ") || null, project: repo, type: /\/pull\//.test(url) ? "Pull request" : "Issue",
    parent: null, // ponytail: gh has no parent field; add with the GraphQL API if needed
    linked: (json.closedByPullRequestsReferences ?? []).map((p) => p.url).filter(Boolean),
  };
}

// gh pr list --head B --state all --json number,title,state,isDraft,url,createdAt (+ extra rows, deduped by url)
export function prItems(json) {
  if (!Array.isArray(json)) throw new Error("gh answered in an unknown format.");
  const seen = new Set();
  return json.filter((p) => p?.url && !seen.has(p.url) && seen.add(p.url)).map((p) => ({
    number: p.number, title: String(p.title ?? ""), url: p.url, created: p.createdAt ? Date.parse(p.createdAt) : null, via: p.via ?? null, from: p.from ?? null,
    state: p.isDraft && p.state === "OPEN" ? "Draft" : ({ OPEN: "Open", MERGED: "Merged", CLOSED: "Closed" })[p.state] ?? "?",
  }));
}

// "#12 · branch" / "#12 · linked"; a PR carried by another branch reads "#12 · via <branch>".
export const prLabel = (p) => `#${p.number}${p.via ? ` · via ${p.via}` : p.from ? ` · ${p.from}` : ""}`;

// A whole number from a mod setting, or the fallback when it's missing, not whole or out of range.
export const intSetting = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);
