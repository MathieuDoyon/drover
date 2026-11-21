// The evidence contract of the Accept proof panel (B3a). Pure: no I/O, no host import. B3b (the Accept action) consumes `buildEvidence`'s
// shape, so a change to the key lists below is a deliberate, visible break (evidence.test.js snapshots them).
//
//   { v:1, repo, pr, base, baseSha, head, headSource, checks, verdict }
//   pr       = { state:"found", number, url, prState } | { state:"none" } | { state:"unknown", reason }
//   head     = the commit A the checks and the verdict are about: the PR head OID ("pr"), or the worktree HEAD when there is no PR ("worktree");
//              null when it cannot be proven (the PR lookup failed, or the worktree is gone)
//   checks   = { green, reason, items:[{name,state}] }: green ONLY when at least one check ran and every one succeeded on A
//   verdict  = the Inspector's `review` note about A: { state:"pass"|"adverse"|"missing"|"stale", head, by, at, report, was }
// "unknown" and "none" are never a PR that is fine: B3b treats unknown as blocking and none as Done-only. The panel shows which login gh
// read as, but cannot prove who owns it: B3b decides who may accept.

export const EVIDENCE_KEYS = ["v", "repo", "pr", "base", "baseSha", "head", "headSource", "checks", "verdict"];
export const PR_KEYS = ["state", "number", "url", "prState", "reason"];
export const CHECKS_KEYS = ["green", "reason", "items"];
export const VERDICT_KEYS = ["state", "head", "by", "at", "report", "was"];

const SHA = /^[0-9a-f]{40}$/;
const isSha = (s) => typeof s === "string" && SHA.test(s);

// ---- checks ----

// One rollup entry (gh `statusCheckRollup`: a CheckRun or a StatusContext) -> { name, state }. Only an exact success is "pass".
function classifyOne(e) {
  if (!e || typeof e !== "object") return { name: "(unnamed)", state: "unknown" };
  const name = String(e.name ?? e.context ?? "").trim() || "(unnamed)";
  if (e.__typename === "CheckRun") {
    if (e.status !== "COMPLETED") return { name, state: ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(e.status) ? "pending" : "unknown" };
    const c = e.conclusion;
    if (c === "SUCCESS") return { name, state: "pass" };
    if (["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(c)) return { name, state: "red" };
    if (c === "CANCELLED") return { name, state: "cancelled" };
    if (c === "SKIPPED") return { name, state: "skipped" };
    if (c === "NEUTRAL") return { name, state: "neutral" };
    return { name, state: "unknown" };
  }
  if (e.__typename === "StatusContext") {
    if (e.state === "SUCCESS") return { name, state: "pass" };
    if (e.state === "PENDING" || e.state === "EXPECTED") return { name, state: "pending" };
    if (e.state === "ERROR" || e.state === "FAILURE") return { name, state: "red" };
  }
  return { name, state: "unknown" };
}

// Pending, missing, empty or unknown is NOT green (rule 5). `noPr`: there is no PR to read checks from.
export function classifyChecks(rollup, { noPr = false } = {}) {
  if (noPr) return { green: false, reason: "No PR: no checks", items: [] };
  if (!Array.isArray(rollup)) return { green: false, reason: "Checks missing: not reported", items: [] };
  if (!rollup.length) return { green: false, reason: "Checks empty: none ran on this commit", items: [] };
  const items = rollup.map(classifyOne);
  const bad = items.filter((i) => i.state !== "pass");
  if (!bad.length) return { green: true, reason: `All ${items.length} checks passed`, items };
  const by = {};
  for (const i of bad) by[i.state] = (by[i.state] ?? 0) + 1;
  return { green: false, reason: `${bad.length} of ${items.length} checks not passing (${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(", ")})`, items };
}

// ---- the review note ----
// `head=<40-hex> verdict=pass|adverse report=<abs path>`; a path with spaces is quoted: report="/a b/review.md". One line, nothing else.

const REVIEW = /^head=([0-9a-f]{40}) verdict=(pass|adverse) report=(?:"([^"\n]+)"|([^\s"]+))$/;
const absolute = (p) => typeof p === "string" && p.startsWith("/");

export function parseReview(text) {
  const m = typeof text === "string" ? REVIEW.exec(text) : null;
  const report = m ? m[3] ?? m[4] : null;
  return m && absolute(report) ? { head: m[1], verdict: m[2], report } : null;
}

export function formatReview({ head, verdict, report }) {
  if (!isSha(head)) throw new Error("review: head must be a full 40-hex commit id");
  if (verdict !== "pass" && verdict !== "adverse") throw new Error("review: verdict must be pass or adverse");
  if (!absolute(report) || /["\n]/.test(report)) throw new Error("review: report must be an absolute path without quotes or newlines");
  return `head=${head} verdict=${verdict} report=${/\s/.test(report) ? `"${report}"` : report}`;
}

const NO_VERDICT = { state: "missing", head: null, by: null, at: null, report: null, was: null };

// The newest `review` note decides (an older one never rescues a malformed newer one). A review of another head is stale.
export function reviewOf(notes, head) {
  const n = [...(Array.isArray(notes) ? notes : [])].reverse().find((x) => x?.kind === "review");
  const p = n ? parseReview(String(n.text ?? "")) : null;
  if (!p) return { ...NO_VERDICT };
  const fresh = head != null && p.head === head;
  return { state: fresh ? p.verdict : "stale", head: p.head, by: n.by ?? null, at: n.at ?? null, report: p.report, was: fresh ? null : p.verdict };
}

// The proof artifact: the path on a `proof=<abs path>` line of the newest `pr` or `handoff` note that has one. Optional.
const PROOF = /^proof=(?:"([^"\n]+)"|(\S+))$/;
export function proofPathOf(notes) {
  for (const n of [...(Array.isArray(notes) ? notes : [])].reverse()) {
    if (n?.kind !== "pr" && n?.kind !== "handoff") continue;
    for (const line of String(n.text ?? "").split("\n").reverse()) {
      const m = PROOF.exec(line.trim());
      const p = m ? m[1] ?? m[2] : null;
      if (absolute(p)) return p;
    }
  }
  return null;
}

// ---- the contract ----

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v); return Object.freeze(o); };
const VERDICT_STATES = ["pass", "adverse", "missing", "stale"];

export function buildEvidence(p) {
  const pr = p.pr ?? { state: "unknown", reason: "unread" };
  if (!["found", "none", "unknown"].includes(pr.state)) throw new Error(`evidence: unknown pr state ${pr.state}`);
  if (p.head != null && !isSha(p.head)) throw new Error("evidence: head must be a full 40-hex commit id or null");
  if (p.baseSha != null && !isSha(p.baseSha)) throw new Error("evidence: baseSha must be a full 40-hex commit id or null");
  if (p.headSource != null && p.headSource !== "pr" && p.headSource !== "worktree") throw new Error("evidence: headSource must be pr, worktree or null");
  const v = { ...NO_VERDICT, ...(p.verdict ?? {}) };
  if (!VERDICT_STATES.includes(v.state)) throw new Error(`evidence: unknown verdict state ${v.state}`);
  const c = p.checks ?? classifyChecks(undefined);
  return deepFreeze({
    v: 1,
    repo: p.repo ?? null,
    pr: { state: pr.state, number: pr.number ?? null, url: pr.url ?? null, prState: pr.prState ?? null, reason: pr.reason ?? null },
    base: p.base ?? null,
    baseSha: p.baseSha ?? null,
    head: p.head ?? null,
    headSource: p.headSource ?? null,
    checks: { green: c.green === true, reason: String(c.reason ?? ""), items: (c.items ?? []).map((i) => ({ name: String(i.name), state: String(i.state) })) },
    verdict: Object.fromEntries(VERDICT_KEYS.map((k) => [k, v[k] ?? null])),
  });
}

// ---- gh (read-only GETs only) ----

// gh must use the app's own stored login: never a token, config dir, host or repo inherited from whoever started the app. The caller
// runs this argv with no shell; `/usr/bin/env -u` removes each selector for the call.
export const GH_UNSET = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "GH_HOST", "GH_REPO"];
export const ENV_BIN = "/usr/bin/env";
export const ghCall = (args) => ({ cmd: ENV_BIN, args: [...GH_UNSET.flatMap((v) => ["-u", v]), "gh", ...args] });

// A gh failure as one bounded word: the raw text could carry a value, so it is never kept.
export function ghProblem(stderr) {
  const s = String(stderr ?? "").toLowerCase();
  if (/auth login|bad credentials|http 401|not logged in|authentication/.test(s)) return "auth";
  if (/could not resolve host|error connecting|network is unreachable|timed? ?out|dial tcp|no such host/.test(s)) return "offline";
  if (/could not resolve to|http 404|not found/.test(s)) return "not-found";
  return "unexpected";
}

// owner/repo of a GitHub PR URL; null for anything else (another host, an issue, junk).
export function repoOfUrl(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+(?:[/?#].*)?$/.exec(String(url ?? ""));
  return m ? `${m[1]}/${m[2]}` : null;
}
