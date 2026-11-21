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
  assert.match(soul("trail-boss"), /<work folder>\/lane-<T-id>\.md/);
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
  for (const s of ["drover config max-parallel <n>", "drover-runs.max_parallel", "only when the owner asks", "plain text in your own terminal", "Never raise it to unblock yourself", "`hc` message", "STATUS: HELP", "Runs on cards in Review or Blocked are waiting"]) assert.ok(m[0].includes(s), s);
  assert.ok(h.includes("| Parallel runs limit | `drover config max-parallel`"), "tools table row");
  assert.ok(h.indexOf("12. **The parallel-runs limit") < h.indexOf("## 5. Honesty"), "rule 12 is in the hard rules");
});

// --- #57 L6: the retro step (lessons only) ---
const retro = () => {
  const t = soul("drover");
  const i = t.indexOf("## Retro (lessons)");
  assert.ok(i >= 0, "retro heading present");
  const rest = t.slice(i + 3);
  const j = rest.search(/\n## /);
  return j < 0 ? t.slice(i) : t.slice(i, i + 3 + j);
};

test("drover soul: retro section names step 7b, the retro command and the three triggers", () => {
  const d = soul("drover");
  const r = retro();
  assert.match(d, /\*\*7b\. Retro\.\*\*/);
  assert.match(d.match(/\*\*7\. Bring the herd in\.\*\*[^\n]*/)[0], /7b/);
  assert.match(r, /bring(?:s|ing)? the herd in/i);
  assert.match(r, /`retro`/);
  assert.match(r, /on demand/i);
  assert.match(r, /all pass, close/);
  assert.match(d.match(/\n6\. At a drive close[^\n]*/)[0], /retro/);
});

test("drover soul: retro runs drover-lessons check on stdin before it shows any candidate", () => {
  const r = retro();
  const c = r.indexOf("drover-lessons check");
  assert.ok(c >= 0, "check named");
  assert.ok(c < r.search(/\bshow/i), "check comes before the display wording");
  assert.match(r, /stdin/);
  assert.match(r, /never argv/i);
});

test("drover soul: retro checks an edit/refine candidate with no scope flag and re-checks revised text", () => {
  const r = retro();
  assert.match(r, /edit or refine candidate[^\n.]*`check` with no scope flag/);
  assert.match(r, /run it again on any text the person revises/i);
});

// drover-lessons (FLAGS / build_scope in mods/drover-agents/bin/drover-lessons): every verb but check needs exactly one of --org/--project/--agent.
const scopeless = (text) => [...text.matchAll(/`drover-lessons ([a-z|]+)([^`]*)`/g)].filter((m) => m[1] !== "check" && !/<scope>|--org|--project|--agent/.test(m[2])).map((m) => m[0]);
test("drover soul: every drover-lessons call in the retro except check carries a scope", () => {
  const r = retro();
  const verbs = [...r.matchAll(/`drover-lessons ([a-z|]+)/g)].map((m) => m[1]);
  for (const v of ["list", "stale", "add", "edit|rm|confirm"]) assert.ok(verbs.includes(v), `${v} call present`);
  assert.deepEqual(scopeless(r), []);
  assert.deepEqual(scopeless(r.replace("stale --days 90 <scope>", "stale --days 90")), ["`drover-lessons stale --days 90`"], "a scope-less stale is caught");
});

test("drover soul: retro never reads or quotes agent transcripts", () => {
  assert.match(retro(), /never read or quote agent transcripts/i);
});

test("drover soul: retro offers the five choices, with --expect only on edit/rm/confirm, labels and advisory wording", () => {
  const r = retro();
  for (const s of ["add", "edit", "remove", "confirm", "skip", "--expect", "before/after", "new", "duplicate", "refines", "contradicts", "advisory", "org", "project", "agent"]) assert.ok(r.includes(s), s);
  assert.match(r, /`add`[^\n]*no `--expect`|`add` takes no `--expect`/);
  assert.doesNotMatch(r, /perm-propose|permission proposal/i);
});

test("drover soul: retro section is small and the soul stays under 115 lines", () => {
  assert.ok(retro().trimEnd().split("\n").length <= 30, "retro section <= 30 lines");
  assert.ok(soul("drover").split("\n").length <= 115, "soul <= 115 lines");
});

test("docs: lessons guide exists, is linked from the README and the agents anchor exists", () => {
  const g = readFileSync(new URL("../../docs/guides/lessons.md", import.meta.url), "utf8");
  for (const s of ["drover-lessons check", "advisory", "transcripts", "../agents.md#lessons-writer"]) assert.ok(g.includes(s), s);
  assert.ok(readFileSync(new URL("../../docs/README.md", import.meta.url), "utf8").includes("(guides/lessons.md)"));
  assert.ok(readFileSync(new URL("../../docs/agents.md", import.meta.url), "utf8").includes("\n## Lessons writer"));
});

const chain = () => {
  const s = soul("drover");
  const i = s.indexOf("\n## Whole chain (low-risk cards)");
  assert.ok(i > s.indexOf("\n## Queue mode"), "section after Queue mode");
  return s.slice(i, s.indexOf("\n## ", i + 1));
};

test("drover soul: whole chain section has the 5-line checklist, the grant words and the written chain", () => {
  const c = chain();
  for (const n of ["(1)", "(2)", "(3)", "(4)", "(5)"]) assert.ok(c.includes(n), `checklist ${n}`);
  for (const s of ["GO + whole chain", "Silence, a plain \"GO\" or an `hc` message grants nothing", "that card and that plan only", "whole chain granted: checklist 1-5 true", "One false or unsure: normal flow"]) assert.ok(c.includes(s), s);
  for (const n of ["(1)", "(2)", "(3)", "(4)", "(5)", "(6)", "(7)", "(8)", "(9)", "(10)"]) assert.ok(c.split("**The chain**")[1].includes(n), `chain step ${n}`);
  for (const s of ["--match-head-commit", "mods/install.sh", "public-sync dry run", "`--push`", "Nothing outside this list"]) assert.ok(c.includes(s), s);
});

test("drover soul: the Low-risk paragraph carries the five restrictions", () => {
  const c = chain();
  const i = c.indexOf("**Low-risk**");
  assert.ok(i >= 0, "Low-risk paragraph exists");
  const para = c.slice(i).split("\n\n")[0];
  for (const s of ["no UI change that needs the person's native check", "no linked or remote machine, no live service touched", "no credential, login or connector created, changed or newly needed", "changes no install, service, or Herdr app or core", "no public-identity or legal file"]) assert.ok(para.includes(s), s);
  assert.ok(para.includes("One false or unsure: normal flow"));
});

test("drover soul: whole chain stops on red, pending or unknown, lists revocations and excludes queue mode", () => {
  const c = chain();
  for (const s of ["red, pending, missing, cancelled, skipped or unknown", "leak hit", "send `HOLD`", "report `HELP`", "A red PR check stops the chain before the merge; the squad may push fixes to the same branch, and the chain goes on only when every check is green on the new head. Any other failure (leak hit, red main or public CI, a refused command), and red PR checks the squad cannot fix, end the grant.", "A later green check never restores it", "whole chain revoked: <reason>", "new High or Critical finding after the GO", "scope change", "Not in queue mode"]) assert.ok(c.includes(s), s);
});

test("drover soul: the chain proves the tree and runs install, main CI and public sync once per run (T-MWQM5QQGMOJ)", () => {
  const c = chain().split("**The chain**")[1].split("**Stops and revocation.**")[0];
  const at = (s) => { const i = c.indexOf(s); assert.ok(i >= 0, s); return i; };
  // each card merges on its own; the tail comes after the last merge
  assert.ok(at("(3) merge only when every check is green") < at("once per run"), "merge before tail");
  assert.ok(at("once per run") < at("(4)"), "tail announced before step 4");
  // fresh fetch, proof against the FETCHED tip of the last card's head
  for (const s of ["`git fetch origin main`", "fast-forward local `main`", "`git diff --quiet <last card's PR head SHA> origin/main`", "FETCHED", "never local `main`"]) assert.ok(c.includes(s), s);
  // exit 0 + one card = tree equal: skip tests; exit 1 or several cards = plain install; anything else = HOLD and HELP
  for (const s of ["exit 0", "one-card run", "`DROVER_SKIP_TESTS=1 mods/install.sh`", "exit 1", "plain `mods/install.sh`", "any other exit (diff error, unknown SHA) = HOLD and HELP", "fetch failure, invalid ref or failed fast-forward = refused command: HOLD and HELP, no install"]) assert.ok(c.includes(s), s);
  // equal tree: no main CI wait, logged n/a; otherwise wait on the exact tip
  for (const s of ["skip the `main` CI wait", "`n/a tree-proof <sha>`", "green on the exact tip commit"]) assert.ok(c.includes(s), s);
  // one public sync and one public CI wait on the final tip
  for (const s of ["`--push`, once per run, on the final tip", "public CI to be green on the pushed commit, once"]) assert.ok(c.includes(s), s);
  // install and sync are not in the per-card steps: exactly one install clause group in the tail, after (3)
  assert.ok(at("(4)") > at("(3)"));
  assert.equal(c.split("`DROVER_SKIP_TESTS=1 mods/install.sh`").length - 1, 1, "one skip-tests install");
  // neither install form (plain or skip-tests) before the tail step (4); both only inside step (4), before (5)
  assert.ok(!/install/.test(c.slice(0, at("(4)"))), "no install before the tail step (4)");
  const installs = [...c.matchAll(/mods\/install\.sh/g)].map((m) => m.index);
  assert.equal(installs.length, 2, "exactly two install forms: skip-tests and plain");
  for (const i of installs) assert.ok(i > at("(4)") && i < at("(5)"), "install only inside step (4)");
  assert.equal(c.split("plain `mods/install.sh`").length - 1, 1, "one plain install");
  // the error case is stated before the multi-card alternative
  assert.ok(at("any other exit (diff error, unknown SHA) = HOLD and HELP") < at("a several-card run"), "HOLD and HELP before the several-card alternative");
  // completion waits for the tail
  for (const s of ["only after (7) is green, for every card of the run", "A red tail CI holds every card of the run (none moves to done)"]) assert.ok(c.includes(s), s);
  assert.ok(at("(7)") < at("only after (7) is green"));
  assert.ok(at("(8)") > at("(7)") && at("(9)") > at("(8)") && at("(10)") > at("(9)"));
});

test("drover soul: stops stay and a superseded cancel is told from an awaited one (T-MWQM5QQGMOJ)", () => {
  const s = chain().split("**Stops and revocation.**")[1];
  for (const x of ["a refused command", "red, pending, missing, cancelled, skipped or unknown", "A later green check never restores it", "whole chain revoked: <reason>", "cancel-in-progress", "superseded", "a cancelled or missing check on the exact commit awaited is still a stop"]) assert.ok(s.includes(x), x);
});

test("drover soul: merge order line carries the one-tail rule (T-MWQM5QQGMOJ)", () => {
  const l = soul("drover").split("\n").find((x) => x.startsWith("**6. Merge order.**"));
  assert.ok(l.includes("merge one at a time") && l.includes("tail"), l);
});

test("test.yml cancels superseded runs of the same workflow and ref (T-MWQM5QQGMOJ)", () => {
  const y = readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8");
  const top = y.split(/^jobs:/m)[0];
  assert.match(top, /^concurrency:\s*\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*\n\s+cancel-in-progress: true\s*$/m);
});

test("drover soul: READY_FOR_PR row, step 3 and queue item 6 point to the whole chain; conv links the soul", () => {
  const s = soul("drover");
  const row = s.split("\n").find((l) => l.startsWith("| `READY_FOR_PR`"));
  assert.ok(row.includes("live whole-chain grant") && row.includes("(\"Whole chain\")") && row.includes("`CREATE_PR` or `HOLD <reason>`"));
  assert.ok(s.includes("the person may add \"whole chain\" to the GO (\"Whole chain (low-risk cards)\")"));
  assert.ok(s.includes("(a card in Ready is never a whole-chain grant)"));
  const conv = readFileSync(new URL("../../conv/02-agents.md", import.meta.url), "utf8");
  assert.ok(conv.includes("- Chain grant:") && conv.includes("(../mods/drover-agents/souls/drover.md)"));
  assert.ok(s.split("\n").length <= 115, "soul <= 115 lines");
});

test("drover soul: the Drover logs the owner and chain events in the card's lane file through drover-lane", () => {
  const d = soul("drover");
  assert.match(d, /drover-lane log/);
  assert.match(d, /--who owner/);
  for (const e of ["OWNER_WORD", "PR_OPEN", "PR_CLOSED", "CI_START", "CI_END", "MERGE", "INSTALLED", "PUBLIC_GREEN", "DONE"]) assert.ok(d.includes(e), e);
  assert.match(d, /Lane log timing/);
  assert.match(d, /lane-<T-id>\.md/);
});

test("_herd.md: a leader posts a run line at each STATUS (drover line, 40 characters, no secrets or paths), and the Tasks row lists the command", () => {
  const h = soul("_herd");
  assert.match(h, /\| Tasks \|[^\n]*`drover line <T-…> "<[^"]*>" \[--progress n\]`/);
  const s = h.match(/\n- [^\n]*`drover line <T-…>[^\n]*\n/)?.[0] ?? "";
  assert.match(s, /leader/i);
  assert.match(s, /STATUS/);
  assert.match(s, /40/);
  assert.match(s, /no secret/i);
  assert.match(s, /no path/i);
});

// --- S3b: review rounds: class sweep, targeted fix-round tests, repeated-class escalation ---

test("inspector: round 2+ reviews fix commits and open findings first, with a same-class sweep (soft scope)", () => {
  const s = soul("inspector");
  assert.match(s, /Round 2 and later[^\n]*fix commits[^\n]*open findings first/);
  assert.match(s, /callers/);
  assert.match(s, /same (function|class)[^\n]*same defect/);
  assert.match(s, /Soft scope, not diff-only/);
});

test("wrangler: after each fix enumerate the defect class and add one sweep test", () => {
  const s = soul("wrangler");
  const m = s.match(/\n4\. \*\*Prove[^\n]*/);
  assert.ok(m, "step 4 present");
  assert.match(m[0], /after each fix[^\n]*enumerate the (defect )?class[^\n]*one sweep test/i);
});

test("trail-boss: fix rounds run targeted tests, full suite once in Phase 4, a repeated High class stops single fixes", () => {
  const s = soul("trail-boss");
  assert.match(s, /fix round[^\n]*targeted tests[^\n]*touched files/i);
  assert.match(s, /After each round run the repo's checks yourself \(lint, types, build, the touched files' tests\); in a fix round run only the targeted tests plus the touched files' tests, and run the full suite once, in Phase 4/);
  assert.doesNotMatch(s, /\(lint, types, unit tests, build\)/);
  assert.match(s, /High[^\n]*same class as the previous round[^\n]*stop[^\n]*ask the Drover for a class sweep or the Judge/i);
});
