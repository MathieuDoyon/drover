// The souls carry the external-issue sync rules (no code syncs): keep the mapping and the hooks in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COLUMNS, columnName } from "../_lib/store.js";

const soul = (n) => readFileSync(new URL(`../drover-agents/souls/${n}.md`, import.meta.url), "utf8");

test("_herd.md: mapping table covers every column, rule 6 carve-out points to it", () => {
  const h = soul("_herd");
  for (const [id, label] of COLUMNS) assert.ok(h.includes(`| ${label} | ${"`" + columnName(id) + "`"} |`), label); // the Board's label and the CLI name, never a third name
  assert.ok(!h.includes("| Doing |"));
  for (const s of ["status: ready", "status: in progress", "status: review", "status: blocked", "In Review", "gh issue close", "gh issue reopen", "gh label create", "--add-assignee @me", "`source:`"]) assert.ok(h.includes(s), s);
  assert.match(h, /Keep 0 for Backlog and Done/);
  assert.match(h, /table's Jira column/);
  assert.match(h, /6\. \*\*No outward action[^\n]*carve-out[^\n]*section 7/);
});

test("drover, trail-boss and wrangler sync the linked issue where they move a card", () => {
  for (const n of ["drover", "trail-boss", "wrangler"]) assert.match(soul(n), /External issues/, n);
});

test("_herd.md: secret hygiene rule forbids printing, env dumps, gh auth token and writing a value", () => {
  const h = soul("_herd");
  const m = h.match(/\n11\. \*\*Secret hygiene[^\n]*/);
  assert.ok(m, "rule 11 present");
  for (const s of ["Never print", "`env`", "`printenv`", "`gh auth token`", "file, note, message or commit"]) assert.ok(m[0].includes(s), s);
});

// --- C8: Inspector approve step (standing permission) ---

// Every gh command: github.com only, inherited host/tokens ignored, same GH_CONFIG_DIR (never unset).
const PFX = "env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN GH_HOST=github.com gh";

// Models the documented decision. `gh` is a fake transport: gh(cmd, env) -> { ok, out } (out = stdout text).
// Returns { status, calls, note }. One POST at most, never retried, never another login.
function approveStep({ env, expectedBot, reviewedSha, pr, repo, confirmed, gh }) {
  const calls = [];
  const run = (cmd) => { calls.push(cmd); return gh(cmd, env); };
  const stop = (reason) => ({ status: "HELP", reason, calls, note: null });
  if (!env.GH_CONFIG_DIR) return { status: "SKIP", calls, note: null };
  const who = run(`${PFX} api user --jq .login`);
  if (!who.ok || who.out.trim() !== expectedBot) return stop("actor");
  const head = run(`${PFX} pr view ${pr} -R ${repo} --json headRefOid --jq .headRefOid`);
  if (!head.ok || head.out.trim() !== reviewedSha) return stop("sha");
  if (!confirmed) return { status: "DRY", calls, note: `dry: would approve ${repo}#${pr} @${reviewedSha} as ${expectedBot}` };
  const post = run(`${PFX} api -X POST repos/${repo}/pulls/${pr}/reviews -f event=APPROVE -f commit_id=${reviewedSha} --jq .id`);
  if (!post.ok) return stop("denied");
  const id = post.out.trim();
  if (!/^\d+$/.test(id)) return stop("no-id");
  const v = run(`${PFX} api repos/${repo}/pulls/${pr}/reviews/${id}`);
  let j; try { j = JSON.parse(v.out); } catch { return stop("verify"); }
  if (!v.ok || j.user?.login !== expectedBot || j.commit_id !== reviewedSha || j.state !== "APPROVED") return stop("verify");
  const after = run(`${PFX} pr view ${pr} -R ${repo} --json headRefOid --jq .headRefOid`);
  const now = after.ok ? after.out.trim() : "";
  const note = (result) => `grant=standing actor=${expectedBot} ${repo}#${pr} sha=${reviewedSha} result=${result} review=${id}`;
  if (now !== reviewedSha) return { status: "HELP", reason: "moved", calls, note: note(`APPROVED (head moved to ${now || "unknown"} after submit)`) };
  return { status: "APPROVED", calls, note: note("approved") };
}
const BOT = "drover-bot", SHA = "a".repeat(40), SECRET = "FAKE-TEST-VALUE-NOT-A-SECRET";
const POST = `${PFX} api -X POST repos/o/r/pulls/7/reviews -f event=APPROVE -f commit_id=${SHA} --jq .id`;
const review = (o = {}) => JSON.stringify({ id: 99, user: { login: BOT }, commit_id: SHA, state: "APPROVED", ...o });
const base = (o = {}) => ({
  env: { GH_CONFIG_DIR: "/x/cfg", GH_HOST: "github.com", GH_TOKEN: SECRET }, expectedBot: BOT, reviewedSha: SHA, pr: 7, repo: "o/r", confirmed: true,
  gh: (c) => c.includes("api user") ? { ok: true, out: BOT + "\n" } : c.includes("pr view") ? { ok: true, out: SHA + "\n" }
    : c.includes("-X POST") ? { ok: true, out: "99\n" } : { ok: true, out: review() }, ...o,
});
const posts = (r) => r.calls.filter((c) => c.includes("-X POST"));

test("inspector.md: approve step is optional, standing, bot-only, SHA-bound, verified, no fallback", () => {
  const i = soul("inspector");
  assert.match(i, /## Approve step \(optional, standing permission\)/);
  for (const s of ["GH_CONFIG_DIR", "GH_HOST=github.com", "env -u GH_TOKEN", "-u GH_ENTERPRISE_TOKEN", "api user --jq .login", "headRefOid", "-X POST repos/<o>/<r>/pulls/<n>/reviews", "-f event=APPROVE", "-f commit_id=<reviewed SHA>", "--jq .id", "never re-POST", "NOT an atomic", "head moved to <sha> after submit", "never dismiss", "STANDING", "STATUS: HELP", "never retry with the person's login", "never unset `GH_CONFIG_DIR`", "review ID", "first real approval", "dry"]) assert.ok(i.includes(s), s);
  for (const s of ["no comment", "no merge", "no request-changes", "no body"]) assert.match(i, new RegExp(s, "i"), s);
  assert.ok(!i.includes("gh pr review"), "no gh pr review (not SHA-bound)");
  assert.ok(!/rejects it/i.test(i), "no stale-head rejection claim");
});

test("_herd.md rule 6: carve-out is the one API review POST with event APPROVE, tied to rule 11", () => {
  const m = soul("_herd").match(/\n6\. \*\*No outward action[^\n]*/);
  assert.ok(m);
  for (const re of [/Inspector/, /standing/i, /rule 11/, /event=APPROVE/, /commit_id/, /no body/i]) assert.match(m[0], re);
  assert.ok(!m[0].includes("gh pr review"));
});

test("approve sim: happy path asserts exact commands, one POST bound to the SHA, id from the response, verified", () => {
  const r = approveStep(base());
  assert.equal(r.status, "APPROVED");
  assert.deepEqual(posts(r), [POST]);
  assert.equal(r.calls.length, 5);
  assert.ok(r.calls.every((c) => c.startsWith(PFX)));
  assert.ok(!r.calls.some((c) => /--comment|request-changes|-f body|merge|pr review/.test(c)));
  assert.ok(r.note.includes(BOT) && r.note.includes(SHA) && r.note.includes("review=99") && r.note.includes("standing"));
  assert.ok(!r.note.includes(SECRET) && !r.note.includes("/x/cfg"));
});

test("approve sim: hostile inherited host/tokens do not change any command (always github.com, tokens unset)", () => {
  const env = { GH_CONFIG_DIR: "/x/cfg", GH_HOST: "enterprise.example", GH_ENTERPRISE_TOKEN: SECRET, GH_TOKEN: SECRET };
  const r = approveStep(base({ env }));
  assert.equal(r.status, "APPROVED");
  for (const c of r.calls) {
    assert.ok(c.startsWith(PFX), c);
    assert.ok(!c.includes("enterprise.example") && !c.includes(SECRET) && !c.includes("unset GH_CONFIG_DIR") && !/-u GH_CONFIG_DIR/.test(c), c);
  }
});

test("approve sim: no identity -> skip, no gh call", () => {
  const r = approveStep(base({ env: {} }));
  assert.equal(r.status, "SKIP");
  assert.equal(r.calls.length, 0);
});

test("approve sim: wrong or unresolvable actor -> stop, no POST", () => {
  let r = approveStep(base({ gh: (c) => c.includes("api user") ? { ok: true, out: "reviewer-bot" } : { ok: true, out: SHA } }));
  assert.equal(r.status, "HELP"); assert.equal(posts(r).length, 0);
  r = approveStep(base({ gh: () => ({ ok: false, out: "" }) }));
  assert.equal(r.status, "HELP"); assert.equal(r.calls.length, 1);
});

test("approve sim: head already changed before the check -> stop, no POST", () => {
  const r = approveStep(base({ gh: (c) => c.includes("api user") ? { ok: true, out: BOT } : { ok: true, out: "b".repeat(40) } }));
  assert.equal(r.status, "HELP"); assert.equal(r.reason, "sha"); assert.equal(posts(r).length, 0);
});

test("approve sim: GitHub accepts the old commit but the head moved to B -> reported as moved + HELP, real review ID, no second write", () => {
  const B = "b".repeat(40);
  let views = 0;
  const b = base();
  const r = approveStep({ ...b, gh: (c, e) => c.includes("pr view") ? { ok: true, out: (++views === 1 ? SHA : B) + "\n" } : b.gh(c, e) });
  assert.equal(r.status, "HELP"); assert.equal(r.reason, "moved");
  assert.equal(posts(r).length, 1);
  assert.ok(r.calls.every((c) => !/DELETE|dismiss/i.test(c)));
  assert.ok(r.note.includes("review=99") && r.note.includes(`APPROVED (head moved to ${B} after submit)`));
  assert.ok(!r.note.includes(SECRET));
});

test("approve sim: denied request -> stop, one POST, no retry", () => {
  const b = base();
  const r = approveStep({ ...b, gh: (c, e) => c.includes("-X POST") ? { ok: false, out: "403" } : b.gh(c, e) });
  assert.equal(r.status, "HELP"); assert.equal(r.reason, "denied"); assert.equal(posts(r).length, 1);
});

test("approve sim: missing or non-numeric id -> stop, no verify, no re-POST", () => {
  for (const out of ["", "null\n", "PRR_x"]) {
    const b = base();
    const r = approveStep({ ...b, gh: (c, e) => c.includes("-X POST") ? { ok: true, out } : b.gh(c, e) });
    assert.equal(r.status, "HELP"); assert.equal(r.reason, "no-id"); assert.equal(posts(r).length, 1); assert.equal(r.note, null);
  }
});

test("approve sim: verify mismatch (actor, commit, state, bad JSON, failure) -> stop, no re-POST, no note", () => {
  for (const out of [review({ user: { login: "reviewer-bot" } }), review({ commit_id: "b".repeat(40) }), review({ state: "COMMENTED" }), "not json"]) {
    const b = base();
    const r = approveStep({ ...b, gh: (c, e) => c.includes("reviews/99") ? { ok: true, out } : b.gh(c, e) });
    assert.equal(r.status, "HELP"); assert.equal(r.reason, "verify"); assert.equal(posts(r).length, 1); assert.equal(r.note, null);
  }
  const b = base();
  const r = approveStep({ ...b, gh: (c, e) => c.includes("reviews/99") ? { ok: false, out: review() } : b.gh(c, e) });
  assert.equal(r.status, "HELP"); assert.equal(posts(r).length, 1);
});

test("approve sim: before the owner's go it runs dry and POSTs nothing", () => {
  const r = approveStep(base({ confirmed: false }));
  assert.equal(r.status, "DRY"); assert.equal(posts(r).length, 0);
});

test("identity gh calls run in the agent's own shell, never via hc run (inspector approve step, rule 6, rule 11)", () => {
  const i = soul("inspector"), h = soul("_herd");
  const re = /gh. call that relies on an identity[^.]*? runs in (your|the agent's) own shell, never through `hc run` or another helper terminal/;
  assert.match(i.slice(i.indexOf("## Approve step")), re);
  assert.match(h.match(/\n6\. \*\*No outward action[^\n]*/)[0], re);
  assert.match(h.match(/\n11\. \*\*Secret hygiene[^\n]*/)[0], re);
});

// --- work folder: souls name the folder given at launch, never a hard-coded .drover/ ---
test("souls: every .drover/ mention is tied to the work folder given at launch", () => {
  const roles = ["drover", "scout", "pm", "writer", "trail-boss", "wrangler", "inspector"];
  for (const n of roles) {
    const t = soul(n);
    assert.match(t, /work folder/, `${n} names the work folder`);
    for (const line of t.split("\n").filter((l) => l.includes(".drover"))) assert.match(line, /work folder/, `${n}: ${line.trim().slice(0, 80)}`);
  }
  assert.match(soul("_herd"), /## 8\. Work folder/);
  assert.match(soul("_herd"), /Work folder \(plans, scouts, reviews, lane logs\)/);
});

test("souls: paths that agents write point at <work folder>, not <repo>/.drover or <worktree>/.drover", () => {
  for (const n of ["scout", "pm", "writer", "trail-boss", "wrangler"]) assert.doesNotMatch(soul(n), /`<(?:repo|worktree|folder)>\/\.drover\/(?!`)/, n);
  assert.match(soul("trail-boss"), /<work folder>\/lane\.md/);
  assert.match(soul("trail-boss"), /<work folder>\/review-1\.md/);
  assert.match(soul("wrangler"), /<work folder>\/review\.md/);
  assert.match(soul("scout"), /<work folder>\/scout\/<task>\.md/);
  assert.match(soul("pm"), /<work folder>\/<task>\/scope\.md/);
  assert.match(soul("writer"), /<work folder>\/<task>\/scope\.md/);
  assert.match(soul("drover"), /<work folder>\/<epic>\/plan\.md/);
});

test("drover soul: in repo mode the plan stays at <repo>/.drover/<epic>/plan.md", () => {
  assert.match(soul("drover"), /repo mode[^\n]*`<repo>\/\.drover\/<epic>\/plan\.md`[^\n]*existing plan logs keep working/);
});

// --- #70: the parallel-runs limit is the owner's ---
test("_herd.md: rule 12 lets an agent change the limit only on the owner's plain-text request, never to unblock itself", () => {
  const h = soul("_herd");
  const m = h.match(/\n12\. \*\*The parallel-runs limit is the owner's[^\n]*/);
  assert.ok(m, "rule 12 present");
  for (const s of ["drover config max-parallel <n>", "drover-runs.max_parallel", "only when the owner asks", "plain text in your own terminal", "Never raise it to unblock yourself", "`hc` message", "STATUS: HELP", "Review or Blocked keep their slot"]) assert.ok(m[0].includes(s), s);
  assert.ok(h.includes("| Parallel runs limit | `drover config max-parallel`"), "tools table row");
  assert.ok(h.indexOf("12. **The parallel-runs limit") < h.indexOf("## 5. Honesty"), "rule 12 is in the hard rules");
});
