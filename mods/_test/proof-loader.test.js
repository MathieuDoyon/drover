// loadEvidence(task, run, current) with a stubbed exec: identity (head A, base OID), checks, discovery, read-only commands, gh environment.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const H = globalThis.__host = { props: {}, state: {}, notified: [], agents: [], terminals: [], calls: [], writes: 0 };
let world;
H.exec = async (cmd, args, opts) => { H.calls.push({ cmd, args: [...args], opts }); return world(cmd, args, opts); };
const { loadEvidence, CONTEXT_STALE } = await import("../_lib/io.js");
const { GH_UNSET, formatReview } = await import("../_lib/evidence.js");

const A = "a".repeat(40), B = "b".repeat(40), L = "c".repeat(40);
const URL5 = "https://github.com/o/r/pull/5";
const ok = (v) => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "" });
const fail = (stderr, code = 1) => ({ code, stdout: "", stderr });
const run = (c) => ({ id: "R1", worktree: { path: "/w", repo: "/repo", branch: "feat/x", ...c } });
const task = (over = {}) => ({ id: "T-1", title: "Add thing", desc: "why it matters", source: null, notes: [], ...over });
const success = (name) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" });
const prJson = (over = {}) => ({ number: 5, url: URL5, state: "OPEN", baseRefName: "main", baseRefOid: B, headRefName: "feat/x", headRefOid: A, statusCheckRollup: [success("build")], ...over });

// The gh args of a call made through /usr/bin/env, or null.
const ghArgs = (c) => (c.cmd === "/usr/bin/env" ? c.args.slice(GH_UNSET.length * 2 + 1) : null);
const ghCalls = () => H.calls.filter((c) => ghArgs(c)).map(ghArgs);
const gitCalls = () => H.calls.filter((c) => c.cmd === "git").map((c) => c.args);

// A fake machine. Fields can be overridden per test.
function machine(o = {}) {
  const s = { envOk: true, dirs: new Set(["/w", "/repo"]), repo: "o/r", list: [{ number: 5, url: URL5, state: "OPEN" }], view: prJson(), viewNoBaseOid: false, api: B, user: "reader", head: L, has: new Set([A, B]), log: "a1 first commit\na2 second", diff: " f.js | 2 +-\n 1 file changed", ...o };
  return (cmd, args, opts) => {
    if (opts?.cwd && !s.dirs.has(opts.cwd)) throw new Error("spawn failed: cwd missing");
    if (cmd === "test") return { code: args[0] === "-x" ? (s.envOk ? 0 : 1) : s.dirs.has(args[1]) ? 0 : 1, stdout: "", stderr: "" };
    if (cmd === "git") {
      if (args[0] === "rev-parse") return ok(typeof s.head === "function" ? s.head() : s.head);
      if (args[0] === "cat-file") return { code: s.has.has(args[2].replace("^{commit}", "")) ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "log") return ok(s.log);
      if (args[0] === "diff") return ok(s.diff);
    }
    const g = ghArgs({ cmd, args });
    if (!g) return fail("unexpected command");
    const key = g.slice(0, 2).join(" ");
    if (key === "repo view") return s.repoView ?? ok({ nameWithOwner: s.repo });
    if (key === "pr list") return s.listResult ?? ok(s.list);
    if (key === "pr view") {
      if (s.viewResult) return s.viewResult;
      if (s.viewNoBaseOid && g.join(" ").includes("baseRefOid")) return fail("Unknown JSON field: \"baseRefOid\"");
      const v = { ...(typeof s.view === "function" ? s.view(g) : s.view) };
      if (s.viewNoBaseOid) delete v.baseRefOid;
      return ok(v);
    }
    if (g[0] === "api" && g[1] === "user") return s.userResult ?? ok(s.user + "\n");
    if (g[0] === "api" && g[1].startsWith("repos/")) return s.apiResult ?? (s.api ? ok(s.api + "\n") : fail("HTTP 404: Not Found"));
    return fail("unexpected gh call");
  };
}
beforeEach(() => { H.calls = []; world = machine(); });

test("happy path: explicit PR, green checks on head A, changes from OIDs, frozen contract", async () => {
  const r = await loadEvidence(task({ source: { kind: "github", id: "o/r#5", url: URL5 }, notes: [{ id: "n1", at: 5, by: "inspector", kind: "review", text: formatReview({ head: A, verdict: "pass", report: "/w/review.md" }) }] }), run());
  const e = r.evidence;
  assert.equal(Object.isFrozen(e), true);
  assert.deepEqual([e.v, e.repo, e.pr.state, e.pr.number, e.pr.prState, e.base, e.baseSha, e.head, e.headSource], [1, "o/r", "found", 5, "OPEN", "main", B, A, "pr"]);
  assert.equal(e.checks.green, true);
  assert.equal(e.verdict.state, "pass");
  assert.equal(e.verdict.report, "/w/review.md");
  assert.deepEqual(r.changes, { state: "ok", commits: ["a1 first commit", "a2 second"], files: " f.js | 2 +-\n 1 file changed" });
  assert.equal(r.summary.title, "Add thing");
  assert.equal(r.actor, "reader");
});

test("an explicit PR URL is never replaced by a branch search", async () => {
  world = machine({ list: [] });
  const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.equal(r.evidence.pr.state, "found");
  assert.ok(!ghCalls().some((a) => a[0] === "pr" && a[1] === "list"), "no branch search when the card names the PR");
});

test("a pr note URL names the PR too; a source PR that disagrees with it is ambiguous (unknown)", async () => {
  const noteOnly = await loadEvidence(task({ notes: [{ id: "n1", at: 1, by: "x", kind: "pr", text: `PR opened ${URL5}` }] }), run());
  assert.equal(noteOnly.evidence.pr.number, 5);
  const clash = await loadEvidence(task({ source: { kind: "github", id: "x", url: "https://github.com/o/r/pull/9" }, notes: [{ id: "n1", at: 1, by: "x", kind: "pr", text: `PR ${URL5}` }] }), run());
  assert.deepEqual([clash.evidence.pr.state, clash.evidence.pr.reason, clash.evidence.checks.green], ["unknown", "ambiguous", false]);
});

test("every gh call runs through /usr/bin/env with every -u, no shell", async () => {
  await loadEvidence(task(), run());
  const gh = H.calls.filter((c) => ghArgs(c));
  assert.ok(gh.length >= 3);
  for (const c of gh) {
    assert.equal(c.cmd, "/usr/bin/env");
    for (const v of GH_UNSET) assert.ok(c.args.some((a, i) => a === v && c.args[i - 1] === "-u"), `-u ${v}`);
  }
  assert.ok(!H.calls.some((c) => c.cmd === "gh" || c.cmd === "sh" || c.cmd === "bash" || c.cmd === "zsh"), "no bare gh, no shell");
});

test("only read-only commands: no merge, edit, comment, review, fetch, pull, or write method", async () => {
  for (const m of [machine(), machine({ list: [], listResult: ok([]) }), machine({ viewNoBaseOid: true })]) {
    world = m; H.calls = [];
    await loadEvidence(task(), run());
    for (const g of ghCalls()) {
      const verb = g.slice(0, 2).join(" ");
      assert.ok(["repo view", "pr view", "pr list", "api user"].includes(verb) || (g[0] === "api" && /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/.test(g[1])), `allowed gh call: ${verb}`);
      assert.ok(!g.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input|--paginate)$/.test(a)), "no write flag on an api call");
      assert.ok(!/merge|edit|comment|review|close|reopen|create/.test(g[1] ?? ""), g.join(" "));
    }
    for (const g of gitCalls()) {
      const i = g[0] === "-C" ? 2 : 0;
      assert.ok(["rev-parse", "cat-file", "log", "diff"].includes(g[i]), `allowed git call: ${g.join(" ")}`);
    }
    assert.ok(H.calls.every((c) => ["/usr/bin/env", "git", "test"].includes(c.cmd)), "only env gh, git and test run");
    assert.equal(H.writes, 0);
  }
});

test("without /usr/bin/env no gh request is made: unknown (identity), checks not green", async () => {
  world = machine({ envOk: false });
  const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.equal(ghCalls().length, 0);
  assert.deepEqual([r.evidence.pr.state, r.evidence.pr.reason, r.evidence.checks.green], ["unknown", "identity", false]);
});

test("gh not signed in: unknown (auth), checks NOT green, no raw stderr kept", async () => {
  const secret = "ghp" + "_" + "ZyXwVuTsRqPoNmLkJiHg";
  world = machine({ viewResult: fail(`To get started with GitHub CLI, please run: gh auth login (token ${secret})`) });
  const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.deepEqual([r.evidence.pr.state, r.evidence.pr.reason, r.evidence.checks.green], ["unknown", "auth", false]);
  assert.ok(!JSON.stringify(r).includes(secret), "secret-shaped stderr is never kept");
  assert.equal(r.evidence.head, null);
});

test("offline, not-found and odd failures are bounded categories", async () => {
  for (const [stderr, want] of [["error connecting to api.github.com", "offline"], ["Could not resolve to a PullRequest", "not-found"], ["something else entirely", "unexpected"]]) {
    world = machine({ viewResult: fail(stderr) });
    const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
    assert.equal(r.evidence.pr.reason, want);
    assert.equal(r.evidence.checks.green, false);
  }
  world = machine({ viewResult: ok("not json at all") });
  assert.equal((await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run())).evidence.pr.reason, "unexpected");
});

test("checks: pending, missing and empty rollups are not green", async () => {
  for (const roll of [[{ __typename: "CheckRun", name: "b", status: "IN_PROGRESS", conclusion: null }], undefined, [], [success("a"), { __typename: "StatusContext", context: "c", state: "PENDING" }]]) {
    world = machine({ view: prJson({ statusCheckRollup: roll }) });
    const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
    assert.equal(r.evidence.checks.green, false, JSON.stringify(roll));
    assert.equal(r.evidence.pr.state, "found");
  }
});

test("discovery: the recorded branch, all states, qualified by the recorded repo", async () => {
  world = machine({ list: [{ number: 5, url: URL5, state: "MERGED" }], view: prJson({ state: "MERGED" }) });
  const r = await loadEvidence(task(), run());
  const list = ghCalls().find((a) => a[0] === "pr" && a[1] === "list");
  assert.ok(list.includes("--state") && list[list.indexOf("--state") + 1] === "all");
  assert.ok(list.includes("--head") && list[list.indexOf("--head") + 1] === "feat/x");
  assert.ok(list.includes("-R") && list[list.indexOf("-R") + 1] === "o/r");
  assert.deepEqual([r.evidence.pr.state, r.evidence.pr.prState], ["found", "MERGED"], "a merged PR keeps its identity and its state");
  world = machine({ list: [{ number: 5, url: URL5, state: "CLOSED" }], view: prJson({ state: "CLOSED" }) });
  assert.equal((await loadEvidence(task(), run())).evidence.pr.prState, "CLOSED");
});

test("discovery: two matches are ambiguous (unknown); a failed list is unknown, never no PR", async () => {
  world = machine({ list: [{ number: 5, url: URL5, state: "OPEN" }, { number: 6, url: "https://github.com/o/r/pull/6", state: "OPEN" }] });
  const two = await loadEvidence(task(), run());
  assert.deepEqual([two.evidence.pr.state, two.evidence.pr.reason], ["unknown", "ambiguous"]);
  world = machine({ listResult: fail("HTTP 401: Bad credentials") });
  const bad = await loadEvidence(task(), run());
  assert.deepEqual([bad.evidence.pr.state, bad.evidence.pr.reason], ["unknown", "auth"]);
  world = machine({ repoView: fail("error connecting to api.github.com") });
  assert.deepEqual([(await loadEvidence(task(), run())).evidence.pr.state], ["unknown"]);
});

test("discovery: a PR of another repo than the recorded one is unknown", async () => {
  world = machine({ list: [{ number: 5, url: "https://github.com/evil/r/pull/5", state: "OPEN" }] });
  const r = await loadEvidence(task(), run());
  assert.equal(r.evidence.pr.state, "unknown");
  world = machine({ view: prJson({ url: "https://github.com/evil/r/pull/5" }) });
  assert.equal((await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run())).evidence.pr.state, "unknown", "the PR read must match the URL asked");
});

test("no PR (empty list for every state): head A is the worktree HEAD, read once; checks not green; Done-only for B3b", async () => {
  world = machine({ list: [] });
  const r = await loadEvidence(task(), run());
  const e = r.evidence;
  assert.deepEqual([e.pr.state, e.head, e.headSource, e.checks.green, e.baseSha], ["none", L, "worktree", false, null]);
  assert.match(e.checks.reason, /No PR/);
  assert.equal(gitCalls().filter((a) => a[0] === "rev-parse").length, 1);
  assert.equal(r.changes.state, "unavailable");
});

test("no PR and the worktree folder is gone: gh asks from the repo, HEAD is never read from the repo: unknown", async () => {
  world = machine({ list: [], dirs: new Set(["/repo"]) });
  const r = await loadEvidence(task(), run());
  assert.ok(ghCalls().some((a) => a[1] === "list"), "the branch lookup still runs");
  assert.ok(H.calls.filter((c) => ghArgs(c)).every((c) => c.opts?.cwd !== "/w"), "never a spawn in the missing folder");
  assert.ok(!H.calls.some((c) => c.cmd === "git" && c.args[0] === "rev-parse"), "no git rev-parse anywhere");
  assert.deepEqual([r.evidence.pr.state, r.evidence.pr.reason, r.evidence.head, r.evidence.checks.green], ["unknown", "worktree-gone", null, false]);
  assert.equal(r.evidence.repo, "o/r");
});

test("no run and no PR on the card: unknown, nothing asked", async () => {
  const r = await loadEvidence(task(), null);
  assert.deepEqual([r.evidence.pr.state, r.evidence.pr.reason], ["unknown", "no-branch"]);
  assert.equal(ghCalls().length, 0);
});

test("identity A comes from the PR read: local ahead or behind only shows a note; log and diff use OIDs", async () => {
  world = machine({ head: L });
  const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.equal(r.evidence.head, A);
  assert.equal(r.localDiffers, true);
  const log = gitCalls().find((a) => a.includes("log")), diff = gitCalls().find((a) => a.includes("diff"));
  assert.ok(log.some((x) => x === `${B}..${A}`), log.join(" "));
  assert.ok(diff.some((x) => x === `${B}...${A}`), diff.join(" "));
  world = machine({ head: A });
  H.calls = [];
  assert.equal((await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run())).localDiffers, false);
});

test("HEAD moving between calls: identity is taken once, never re-read", async () => {
  let n = 0;
  world = machine({ list: [], head: () => (n++ === 0 ? A : B) });
  const r = await loadEvidence(task(), run());
  assert.equal(r.evidence.head, A);
  assert.equal(n, 1, "one rev-parse HEAD");
});

test("an object of A or of the base missing locally: Changes unavailable, no fetch, no substitution", async () => {
  for (const has of [new Set([B]), new Set([A])]) {
    world = machine({ has }); H.calls = [];
    const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
    assert.equal(r.changes.state, "unavailable");
    assert.match(r.changes.reason, /not fetched/);
    assert.ok(!gitCalls().some((a) => ["log", "diff", "fetch", "pull"].includes(a[0] === "-C" ? a[2] : a[0])));
    assert.equal(r.evidence.checks.green, true, "checks and verdict are still shown");
  }
});

test("base: a stale local origin/<base> is never used; baseRefOid unsupported falls back to a GET of the PR", async () => {
  world = machine({ viewNoBaseOid: true, api: B });
  const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.equal(r.evidence.baseSha, B);
  assert.ok(ghCalls().some((a) => a[0] === "api" && a[1] === "repos/o/r/pulls/5"));
  assert.ok(!H.calls.some((c) => c.args.join(" ").includes("origin/")), "no origin/<base> anywhere");
});

test("base unknown from every source: baseSha null, Changes unavailable (PR base not known), B3b must refuse", async () => {
  world = machine({ viewNoBaseOid: true, api: null });
  const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.equal(r.evidence.baseSha, null);
  assert.deepEqual([r.changes.state, r.changes.reason], ["unavailable", "PR base not known"]);
  assert.equal(r.evidence.checks.green, true);
});

test("review: a review of another head is stale; the file is a path only", async () => {
  const n = [{ id: "n1", at: 5, by: "inspector", kind: "review", text: formatReview({ head: B, verdict: "pass", report: "/w/old review.md" }) }];
  const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 }, notes: n }), run());
  assert.equal(r.evidence.verdict.state, "stale");
  assert.equal(r.evidence.verdict.report, "/w/old review.md");
});

test("summary, last handoff note and the proof artifact path", async () => {
  const n = [{ id: "a", at: 1, by: "w", kind: "handoff", text: "first\nproof=/p/one.md" }, { id: "b", at: 2, by: "w", kind: "log", text: "x" }, { id: "c", at: 3, by: "w", kind: "handoff", text: 'second handoff\nproof="/p dir/two.png"' }];
  const r = await loadEvidence(task({ notes: n, source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.equal(r.handoff.text.startsWith("second handoff"), true);
  assert.equal(r.proof, "/p dir/two.png");
  assert.equal((await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run())).proof, null);
});

test("actor: shown as read, never part of the contract; a failed actor read is just unknown", async () => {
  world = machine({ user: "someone-else" });
  const r = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.equal(r.actor, "someone-else");
  assert.ok(!("actor" in r.evidence));
  world = machine({ userResult: fail("HTTP 401") });
  const none = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run());
  assert.equal(none.actor, null);
  assert.equal(none.evidence.pr.state, "found", "the PR read stands on its own");
});

test("a stale load is dropped via current(): CONTEXT_STALE and no further calls", async () => {
  let live = true;
  world = machine();
  const p = loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 } }), run(), () => live);
  live = false;
  await assert.rejects(p, (e) => e === CONTEXT_STALE);
  const seen = H.calls.length;
  await new Promise((r) => setImmediate(r));
  assert.equal(H.calls.length, seen, "nothing more is asked once dropped");
  live = false;
  H.calls = [];
  await assert.rejects(loadEvidence(task(), run(), () => false), (e) => e === CONTEXT_STALE);
  assert.equal(H.calls.length, 0, "a load that is not wanted from the start asks nothing");
});

// ---- review round 1, finding 2: a number-only explicit PR reference ----
const pn = (text, at = 1) => ({ id: "n" + at, at, by: "w", kind: "pr", text });

test("a number-only pr note (PR #5) names the PR in the recorded repo, even when the branch was renamed (empty branch search)", async () => {
  world = machine({ list: [] });
  const r = await loadEvidence(task({ notes: [pn("PR #5 opened")] }), run());
  assert.deepEqual([r.evidence.pr.state, r.evidence.pr.number, r.evidence.repo], ["found", 5, "o/r"]);
  assert.ok(ghCalls().some((a) => a[0] === "pr" && a[1] === "view" && a[2] === URL5), "viewed by the URL built from the recorded repo");
  assert.ok(!ghCalls().some((a) => a[0] === "pr" && a[1] === "list"), "never a branch search for a card that names its PR");
});

test("a number-only reference whose repo cannot be established is unknown, never none", async () => {
  world = machine({ repoView: fail("HTTP 401: Bad credentials"), list: [] });
  const bad = await loadEvidence(task({ notes: [pn("PR #5")] }), run());
  assert.deepEqual([bad.evidence.pr.state, bad.evidence.pr.reason], ["unknown", "auth"]);
  world = machine({ list: [] });
  H.calls = [];
  const noRun = await loadEvidence(task({ notes: [pn("PR #5")] }), null);
  assert.equal(noRun.evidence.pr.state, "unknown");
  assert.notEqual(noRun.evidence.pr.state, "none");
  assert.equal(ghCalls().length, 0);
});

test("number-only references that disagree (two numbers, or a source PR of another number) are ambiguous", async () => {
  world = machine({ list: [] });
  assert.equal((await loadEvidence(task({ notes: [pn("PR #5 and PR #6")] }), run())).evidence.pr.reason, "ambiguous");
  assert.equal((await loadEvidence(task({ source: { kind: "github", id: "x", url: "https://github.com/o/r/pull/9" }, notes: [pn("PR #5")] }), run())).evidence.pr.reason, "ambiguous");
  const same = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 }, notes: [pn("PR #5")] }), run());
  assert.equal(same.evidence.pr.state, "found", "the same PR named twice is fine");
});

test("a pr note without any PR reference does not count as explicit", async () => {
  world = machine({ list: [] });
  const r = await loadEvidence(task({ notes: [pn("opened it, waiting for CI")] }), run());
  assert.equal(r.evidence.pr.state, "none");
});

// ---- review round 2: an issue reference is not a PR number ----
test("a PR note that also mentions an issue (#42) does not become ambiguous: URL stays authoritative, number-only still resolves", async () => {
  world = machine({ list: [] });
  const withUrl = await loadEvidence(task({ source: { kind: "github", id: "x", url: URL5 }, notes: [pn("PR #5 opened; fixes issue #42")] }), run());
  assert.deepEqual([withUrl.evidence.pr.state, withUrl.evidence.pr.number], ["found", 5]);
  const numOnly = await loadEvidence(task({ notes: [pn("PR #5 opened; fixes issue #42")] }), run());
  assert.deepEqual([numOnly.evidence.pr.state, numOnly.evidence.pr.number], ["found", 5]);
  const issueFirst = await loadEvidence(task({ notes: [pn("closes #42 and fixes #43 in pull request #5")] }), run());
  assert.equal(issueFirst.evidence.pr.number, 5);
  const bare = await loadEvidence(task({ notes: [pn("#5 opened")] }), run());
  assert.equal(bare.evidence.pr.state, "none", "a bare #N is never a PR reference: not explicit, branch discovery says none");
  const urlNote = await loadEvidence(task({ notes: [pn(`${URL5} resolves #42`)] }), run());
  assert.equal(urlNote.evidence.pr.number, 5);
});

test("only issue references in a pr note: not an explicit PR (branch discovery); two distinct PR numbers and a differing number stay ambiguous", async () => {
  world = machine({ list: [] });
  assert.equal((await loadEvidence(task({ notes: [pn("fixes issue #42")] }), run())).evidence.pr.state, "none");
  assert.equal((await loadEvidence(task({ notes: [pn("PR #5 superseded by PR #6; fixes #42")] }), run())).evidence.pr.reason, "ambiguous");
  assert.equal((await loadEvidence(task({ source: { kind: "github", id: "x", url: "https://github.com/o/r/pull/9" }, notes: [pn("PR #5, fixes #42")] }), run())).evidence.pr.reason, "ambiguous");
});

// ---- review round 3: only PR-qualified references count (full PR URL, "PR #N", "pull request #N", "pull/N"); a bare #N is ignored ----
test("only qualified references count: bare #N never names a PR and never causes ambiguity", async () => {
  world = machine({ list: [] });
  const num = async (text, source) => (await loadEvidence(task({ source, notes: [pn(text)] }), run())).evidence.pr;
  assert.equal((await num("PR #5 + fixes #42 and #43")).number, 5);
  assert.equal((await num("PR #5 and #6")).number, 5, "a bare #6 is ignored");
  assert.equal((await num("pull request #5, see #6 and #7")).number, 5);
  assert.equal((await num("opened pull/5 today")).number, 5);
  assert.equal((await num("PR #5 and PR #6")).reason, "ambiguous");
  assert.equal((await num("PR #5 and pull request #6")).reason, "ambiguous");
  assert.equal((await num("PR #5", { kind: "github", id: "x", url: URL5 })).number, 5, "the same PR named twice is fine");
  assert.equal((await num("PR #5 and #6", { kind: "github", id: "x", url: URL5 })).number, 5);
  assert.equal((await num("PR #6", { kind: "github", id: "x", url: URL5 })).reason, "ambiguous");
  assert.equal((await num("#5 #6 #7")).state, "none", "bare-only: not explicit");
  assert.equal((await num("fixes issue #42")).state, "none");
});
