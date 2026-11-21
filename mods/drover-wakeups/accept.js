// The Accept chain (B3b). Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// Pure + async over INJECTED deps: this file imports only the pure evidence helpers, has no exec, no fs of its own and no gh. Every write (merge, issue close, card move,
// note, record, lock) is a function of `deps`, built by io.js `acceptDeps()` and replaced by a fake in the tests.
//
// The owner's click is permission for this repo, this PR number and head A, once. The chain: lock, bind A, re-read, merge pinned to A, read the PR
// back (only MERGED at A counts), source sync, move to Done. A step that cannot prove its result stops the chain and moves nothing.
// The lock is a directory made by one atomic mkdir. It is never replaced or removed by anything that did not create it (the token file must still be
// ours), however old it is: a stale lock is cleared by the owner, outside the app.

import { reviewOf } from "./evidence.js";

export const STEPS = ["lock", "bind", "re-read", "merge", "read-back", "source sync", "done"];
export const HELD = "Another Accept may be running, or one stopped without finishing";
const WORDS = ["conflict", "not-mergeable", "checks-required", "review-required", "queue-rejected", "head-moved", "auth", "offline", "unexpected", "head-mismatch", "closed", "blocked", "refreshed", "move"];
const REST_CAP = 250; // the REST commit list of a PR holds at most 250
const short = (sha) => (sha ? String(sha).slice(0, 7) : "?");

// ---- the review gate ----

export const overrideError = (text) => {
  if (typeof text !== "string") return "Type a reason of 10 to 300 characters";
  const t = text.trim();
  if (/[\r\n]/.test(t)) return "Write the reason on one line";
  return t.length >= 10 && t.length <= 300 ? null : "Type a reason of 10 to 300 characters";
};

// The coordinator writes `drover note <T> --kind decision "plan approved"` at every GO. The exact text only: the newest `decision` note that is
// `plan approved` (or `plan approved: <text>`) approves, `plan withdrawn[: text]` revokes. Anything else (GO withheld, a prefix match) is not a marker.
export function planApproval(notes) {
  for (const n of [...(Array.isArray(notes) ? notes : [])].reverse()) {
    if (n?.kind !== "decision") continue;
    const t = String(n.text ?? "").trim().toLowerCase();
    if (/^plan approved(: .+)?$/.test(t)) return "approved";
    if (/^plan withdrawn(: .+)?$/.test(t)) return "missing";
  }
  return "missing";
}

// ---- closing keywords ----
// GitHub's list (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved), any case, an optional colon, then `#N`, `owner/repo#N` or an issue URL.
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)?#(\d+))/gi;
export function closingKeywords(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(CLOSING)) out.push({ verb: m[1].toLowerCase(), repo: m[2] ?? m[4] ?? null, number: Number(m[3] ?? m[5]) });
  return out;
}

const issueRef = (source) => {
  const m = source?.kind === "github" ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(String(source.url ?? "")) : null;
  return m ? { repo: m[1], number: Number(m[2]) } : null;
};
// The identity of a source: a GitHub issue is its case-folded repo plus its number (the URL spelling does not matter); anything else is its raw URL.
const sourceKey = (source) => { const r = issueRef(source); return r ? `${r.repo.toLowerCase()}#${r.number}` : source?.url ?? null; };
const sameCard = (a, b) => a?.id === b?.id && (a?.project ?? null) === (b?.project ?? null);

// What the chain does with the card's linked issue after a merge. The safety set is EVERY other card on the same source, any project, archived too.
// A sibling counts as resolved only when its column is Done (an owner-Done legacy card is the owner's word). Anything else keeps the issue open.
export function sourceDecision(task, cards) {
  const src = task?.source;
  if (!src) return { close: false, action: "none", why: "no linked issue" };
  if (src.kind === "jira") return { close: false, action: "skip", why: "Jira source: the app has no Jira tool, an agent or you sync it" };
  if (src.kind !== "github") return { close: false, action: "skip", why: "source is not a GitHub issue" };
  const ref = issueRef(src);
  if (!ref) return { close: false, action: "skip", why: "source is not an issue (a pull request or another link)" };
  const open = (Array.isArray(cards) ? cards : []).filter((c) => !sameCard(c, task) && sourceKey(c?.source) === sourceKey(src) && c.column !== "done");
  if (open.length) return { close: false, action: "keep-open", ref, why: `${open.length} other card${open.length === 1 ? "" : "s"} on this source not Done` };
  return { close: true, action: "close", ref, why: "every card on this source is Done" };
}

// The commit list is whole only when it equals the REST count and the count is within the REST cap.
export const commitsComplete = (p) => Array.isArray(p?.commits) && Number.isInteger(p?.commitCount) && p.commitCount >= 1 && p.commitCount <= REST_CAP && p.commits.length === p.commitCount;

// ---- identity ----
const IDENTITY = ["repo", "kind", "number", "url", "base", "baseSha"];
const kindOf = (e) => (e?.pr?.state === "none" ? "no-pr" : "pr");
const factsOf = (e) => ({ repo: e?.repo ?? null, kind: kindOf(e), number: e?.pr?.number ?? null, url: e?.pr?.url ?? null, base: e?.base ?? null, baseSha: e?.baseSha ?? null });
// The fields of the bound record that the fresh evidence no longer agrees with (the head is judged apart).
export const identityDiff = (rec, e) => { const f = factsOf(e); return IDENTITY.filter((k) => (rec?.[k] ?? null) !== (f[k] ?? null)); };

const LABELS = { merge: "Accept (merge and move to Done)", "done-only": "Accept (move to Done)", finish: "Finish (sync and move to Done)", blocked: "Accept" };
// The truth table. Hard stops never take an override; soft ones (plan approval, the Inspector's verdict at A) take a typed reason that covers them.
// `bound` is the record the click bound (null while the dialog only looks). `prx` is the extra read of the PR (state, draft, mergeable, title, body, commits).
export function gate({ evidence: e, prx, task, cards = [], override = null, bound = null, remote = false } = {}) {
  const reasons = [];
  const hard = (code, text) => reasons.push({ code, text, soft: false });
  const soft = (code, text) => reasons.push({ code, text, soft: true });
  const kind = kindOf(e);
  let mode = kind === "no-pr" ? "done-only" : "merge";
  if (remote) hard("remote", "A card of another machine: Accept reads this machine only");
  if (e.pr.state === "unknown") hard("pr-unknown", `PR unknown (${e.pr.reason ?? "unread"})`);
  if (e.head == null) hard("no-head", "The head commit cannot be proven");
  const st = e.pr.prState;
  if (bound) {
    if (st === "MERGED" && bound.head !== e.head) hard("merged-other-head", `Merged at ${short(e.head)}, not at the commit you looked at (${short(bound.head)})`);
    else if (bound.head !== e.head && e.head != null) hard("head-moved", `The head moved from ${short(bound.head)} to ${short(e.head)}`);
    if (identityDiff(bound, e).length) hard("identity", "The PR identity changed since you looked");
  }
  if (kind === "pr" && e.pr.state === "found") {
    if (st === "CLOSED") hard("pr-closed", "The PR is closed, not merged");
    else if (st === "MERGED") mode = "finish";
    else if (st === "OPEN") {
      if (!e.checks.green) hard("checks", `Checks are not green: ${e.checks.reason}`);
      if (!prx || prx.ok !== true) hard("text-unreadable", "Could not read the PR text");
      else {
        if (prx.isDraft) hard("draft", "The PR is a draft");
        if (prx.mergeable === "CONFLICTING") hard("conflict", "The PR has a merge conflict");
        if (!commitsComplete(prx)) hard("commits-incomplete", "Could not read every commit of the PR");
        else {
          const sd = sourceDecision(task, cards);
          const hits = [prx.title, prx.body, ...prx.commits].flatMap(closingKeywords);
          if (sd.action === "keep-open" && hits.some((h) => (h.repo ?? e.repo ?? "").toLowerCase() === sd.ref.repo.toLowerCase() && h.number === sd.ref.number)) {
            hard("closing-keyword", `A closing keyword in the PR would close ${sd.ref.repo}#${sd.ref.number}, which other cards still use`);
          }
        }
      }
    } else hard("pr-unknown", "The PR state is not known");
  }
  if (planApproval(task?.notes) !== "approved") soft("plan-missing", "No plan approval on the card");
  const v = e.verdict?.state;
  if (v === "missing") soft("review-missing", "No review of this head");
  else if (v === "stale") soft("review-stale", `The review was of ${short(e.verdict.head)}, not the head ${short(e.head)}`);
  else if (v === "adverse") soft("review-adverse", `The review of ${short(e.head)} is adverse`);
  const hardCodes = reasons.filter((r) => !r.soft).map((r) => r.code);
  const softCodes = reasons.filter((r) => r.soft).map((r) => r.code);
  const valid = Boolean(override) && overrideError(override.reason) === null && Array.isArray(override.covers);
  const covered = softCodes.length > 0 && valid && softCodes.every((c) => override.covers.includes(c));
  const enabled = hardCodes.length === 0 && (softCodes.length === 0 || covered);
  if (hardCodes.length) mode = "blocked";
  return { mode, label: LABELS[mode], enabled, reasons, hard: hardCodes, soft: softCodes, overridden: enabled && covered, needsOverride: hardCodes.length === 0 && softCodes.length > 0 && !covered };
}

// ---- the record ----
// { v:1, id, project, repo, number, url, base, baseSha, head:A, kind:"pr"|"no-pr", mode, phase, token, at, override? }
// phase: bound -> merging -> merged -> synced -> done; or open (read back OPEN), unknown (unreadable), failed:<word>.
export const terminal = (r) => r?.phase === "done" || String(r?.phase ?? "").startsWith("failed:");
const FROM = { merging: ["bound"], merged: ["bound", "merging"], open: ["merging", "bound"], unreadable: ["merging", "bound"], synced: ["merged"], "sync-failed": ["merged"] };
export function step(rec, ev) {
  if (!rec || terminal(rec)) return null;
  const to = (phase) => ({ ...rec, phase });
  switch (ev?.type) {
    case "fail": return ["bound", "merging", "merged"].includes(rec.phase) ? to(`failed:${WORDS.includes(ev.word) ? ev.word : "unexpected"}`) : null;
    case "done": return (rec.kind === "no-pr" ? rec.phase === "bound" : rec.phase === "synced") ? to("done") : null;
    case "merging": case "merged": case "synced": return rec.kind === "no-pr" || !FROM[ev.type].includes(rec.phase) ? null : to(ev.type);
    case "open": return FROM.open.includes(rec.phase) ? to("open") : null;
    case "unreadable": return FROM.unreadable.includes(rec.phase) ? to("unknown") : null;
    case "sync-failed": return rec.phase === "merged" ? to("merged") : null;
    default: return null;
  }
}

// ---- the lock ----
const safe = (s) => String(s ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
export const lockKey = ({ id, project }) => `${project == null ? "-" : safe(project)}__${safe(id)}`;
export const lockPath = (dir, key) => `${dir}/${key}.lock`;
// The ONE command shown to the owner (text only, the app never runs it): the whole path is single-quoted for a shell, an apostrophe in it included.
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const clearCommand = (dir, key) => `rm -r ${shellQuote(lockPath(dir, key))}`;
const firstLine = (s) => String(s ?? "").split("\n")[0];

// `fsx` is an injected fs (mkdir, writeFile, readFile, readdir, unlink, rmdir). mkdir of the lock is the atomic claim: exactly one caller wins.
// The token file holds `<token>\n<start seconds>` (what `drover doctor` reads). Anything that cannot be proven is "uncertain": never a win.
export function createLock(fsx, dir, { now = () => Date.now() } = {}) {
  const tokenFile = (key) => `${lockPath(dir, key)}/token`;
  const state = async (key) => {
    try { await fsx.readdir(lockPath(dir, key)); return "present"; } catch (e) { return e?.code === "ENOENT" ? "none" : "unknown"; }
  };
  const read = async (key) => { try { return firstLine(await fsx.readFile(tokenFile(key), "utf8")); } catch { return null; } };
  // Removes the files a caller proved are its own: the token file, then the (now empty) directory. Never recursive.
  const drop = async (key) => {
    await fsx.unlink(tokenFile(key)).catch(() => {});
    await fsx.rmdir(lockPath(dir, key));
  };
  return {
    state, read,
    async acquire(key, token) {
      try { await fsx.mkdir(dir, { recursive: true }); } catch { return "uncertain"; }
      try { await fsx.mkdir(lockPath(dir, key)); } catch (e) { return e?.code === "EEXIST" || (await state(key)) === "present" ? "held" : "uncertain"; }
      try {
        await fsx.writeFile(tokenFile(key), `${token}\n${Math.floor(now() / 1000)}`);
        if ((await read(key)) !== token) throw new Error("token not read back");
      } catch {
        // Only an EMPTY directory is removed: rmdir cannot remove a token file, and no token is unlinked here (an unproven token may be someone else's).
        await fsx.rmdir(lockPath(dir, key)).catch(() => {});
        return "uncertain";
      }
      return "won";
    },
    async release(key, token) {
      if ((await read(key)) !== token) return "kept"; // not ours (a late cleanup of an old run): leave it
      try { await drop(key); return "released"; } catch { return "kept"; }
    },
  };
}

// ---- the chain ----
const running = new Set(); // this process: a double click is one run

export async function runAccept(ref, deps) {
  const key = lockKey(ref);
  if (running.has(key)) return { outcome: "busy", text: "Accept is already running here", steps: [] };
  running.add(key);
  try { return await chain(ref, deps, key); } finally { running.delete(key); }
}

async function chain(ref, deps, key) {
  const steps = [];
  const say = (line) => { steps.push(line); deps.onStep?.(line); };
  const log = async (text, kind = "log") => { say(text); await deps.note(ref.id, ref.project, text, kind); };
  const out = (o) => ({ steps, ...o });
  const E = ref.bound;
  if (!E || E.pr?.state === "unknown" || !E.head) return out({ outcome: "blocked", reasons: [], soft: [], text: "Nothing to accept: the evidence is not readable" });
  const card0 = deps.task(ref.id, ref.project);
  if (!card0 || card0.column !== "review") return out({ outcome: "blocked", reasons: [], soft: [], text: "The card is not in Review here" });

  const token = deps.token();
  const got = await deps.lock.acquire(key, token);
  if (got !== "won") return out({ outcome: "held", text: HELD });
  // From here on, every handled end goes through finish(): it releases only the lock this run made. An exception leaves the lock for the owner.
  const finish = async (o) => { await deps.lock.release(key, token); return out(o); };

  // 1. bind the identity the owner looked at
  const kind = kindOf(E);
  const ov = ref.override && overrideError(ref.override.reason) === null ? { reason: ref.override.reason.trim(), covers: [...(ref.override.covers ?? [])] } : null;
  let rec = { v: 1, id: ref.id, project: ref.project ?? null, repo: E.repo, number: E.pr.number, url: E.pr.url, base: E.base, baseSha: E.baseSha, head: E.head, kind, mode: ref.mode, phase: "bound", token, at: deps.now(), ...(ov ? { override: ov } : {}) };
  deps.records.set(key, rec);
  await log(kind === "pr" ? `accept: bound ${E.repo}#${E.pr.number} base ${E.base ?? "?"}@${short(E.baseSha)} head ${short(E.head)}` : `accept: bound worktree commit ${short(E.head)} (no PR)`);
  const stop = async (to, word, o) => { rec = step(rec, { type: "fail", word }) ?? rec; deps.records.set(key, rec); return finish({ outcome: to, word, ...o }); };

  // 2. re-read; a different head or identity is never merged: refresh and let the owner click again
  const task = deps.task(ref.id, ref.project);
  const F = (await deps.readEvidence(task ?? card0)).evidence;
  if (F.pr.state !== "unknown" && (F.head !== rec.head || identityDiff(rec, F).length)) {
    await log(F.head !== rec.head ? "accept: head moved, evidence refreshed, not merged" : "accept: PR identity changed, evidence refreshed, not merged");
    return stop("refreshed", "refreshed", { evidence: F, text: "The PR changed since you looked: evidence refreshed, nothing merged. Read it and click again" });
  }
  const prx = kind === "pr" && F.pr.prState === "OPEN" ? await deps.readPr(rec) : undefined;

  // final(): the ONE eligibility judgement. It reads the LATEST local card and ALL cards synchronously (nothing in it can wait), recomputes the whole
  // gate (identity, plan approval, the verdict for A from the latest notes, the override's coverage, the hard rules, the source decision and the
  // closing-keyword block against the latest card set; the PR text read earlier stays) and says whether the next irreversible call may go.
  // RULE: every wait (notes, the lock fence, reads) happens BEFORE a final(), and the irreversible call is issued in the same synchronous run right
  // after it. A change that lands during a wait is therefore seen; one that lands after the dispatch is too late for any code to stop.
  //   want "merge": the PR is open and may be merged.  "post": merged at A, the source sync and Done may go.  "nopr": no PR, Done only.
  const final = (want) => {
    const last = deps.task(ref.id, ref.project);
    const ev = want === "post" ? { ...F, pr: { ...F.pr, prState: "MERGED" } } : F;
    const g = gate({ evidence: { ...ev, verdict: { ...ev.verdict, ...reviewOf(last?.notes, ev.head) } }, prx, task: last, cards: deps.cards(), override: rec.override ?? null, bound: rec });
    const mode = { merge: "merge", post: "finish", nopr: "done-only" }[want];
    const ok = Boolean(last) && last.column === "review" && g.enabled && g.mode === mode;
    const why = !last || last.column !== "review" ? "the card is not in Review here" : g.reasons[0]?.text ?? "it is no longer ready";
    return { ok, g, last, why };
  };
  // Before the merge (or for no-PR work) nothing irreversible has happened: the record is failed and the owner reads and clicks again.
  const refuse = async (f) => {
    await log(`accept: not merged: ${f.why}`);
    return stop("blocked", "blocked", { evidence: F, reasons: f.g.reasons, soft: f.g.soft, text: `Not accepted: ${f.why}` });
  };
  // After the merge the merge stands; the record keeps its phase so Finish can complete it once the gate passes again.
  const keepMerged = async (f) => {
    await log(`accept: merged, not finished: ${f.why}`);
    return finish({ outcome: "blocked", evidence: F, reasons: f.g.reasons, soft: f.g.soft, text: `Merged, but not finished: ${f.why}` });
  };

  const want0 = kind === "no-pr" ? "nopr" : F.pr.prState === "MERGED" ? "post" : "merge";
  const f0 = final(want0);
  if (!f0.ok || (ref.mode === "finish" && want0 !== "post")) {
    await log(`accept: not merged: ${f0.ok ? "Finish only completes a merged PR" : f0.why}`);
    return stop("blocked", "blocked", { evidence: F, reasons: f0.g.reasons, soft: f0.g.soft, text: `Not accepted: ${f0.ok ? "Finish only completes a merged PR" : f0.why}` });
  }
  await log(kind === "pr" ? `accept: re-read ok: head ${short(rec.head)} unchanged, identity unchanged` : `accept: re-read ok: worktree commit ${short(rec.head)} unchanged`);
  if (f0.g.overridden) await log(`accept: override ${f0.g.soft.join(",")}: ${rec.override.reason}`, "decision");

  // 3. merge, pinned to A (skipped when it is already merged at A, and never run for Finish or for work with no PR)
  if (want0 === "merge") {
    await log(`accept: merging ${rec.repo}#${rec.number} at ${short(rec.head)} (squash, pinned to the head)`);
    if ((await deps.lock.read(key)) !== token) return finish({ outcome: "lost-lock", text: "Lost the Accept lock: nothing merged" });
    const f1 = final("merge");
    if (!f1.ok) return refuse(f1);
    rec = step(rec, { type: "merging" }); deps.records.set(key, rec);
    const sent = deps.merge(rec);
    const m = await sent;
    if (!m.ok && m.word !== "offline" && m.word !== "unexpected") {
      const word = WORDS.includes(m.word) ? m.word : "unexpected";
      await log(`accept: merge failed: ${word}`);
      return stop("failed", word, { text: `Failed: ${word}` });
    }
    if (!m.ok) await log("accept: the merge answer was lost, reading the PR to see");
  } else if (want0 === "post") await log(`accept: already merged at ${short(rec.head)}`);

  // 4. read the PR back: only MERGED with head A counts
  if (kind === "pr") {
    let rb;
    for (let i = 0; i < 3; i++) {
      rb = await deps.readBack(rec);
      if (!rb.ok || rb.state !== "OPEN") break;
      if (i < 2) await deps.sleep(2000);
    }
    if (!rb.ok) {
      rec = step(rec, { type: "unreadable" }) ?? rec; deps.records.set(key, rec);
      await log(`accept: could not read the PR back (${WORDS.includes(rb.word) ? rb.word : "unexpected"}), merge not proven`);
      return finish({ outcome: "unknown", text: "Unknown: could not read the PR after the merge. Nothing else was changed" });
    }
    if (rb.state === "OPEN") {
      rec = step(rec, { type: "open" }) ?? rec; deps.records.set(key, rec);
      await log("accept: PR still open after the merge call, not merged (queued or rejected, not proven)");
      return finish({ outcome: "not-merged", text: "Not merged: PR still open (queued or rejected, not proven)" });
    }
    if (rb.state !== "MERGED") return log("accept: PR closed without a merge").then(() => stop("failed", "closed", { text: "Failed: the PR is closed, not merged" }));
    if (rb.head !== rec.head) return log(`accept: merged at ${short(rb.head)}, not at ${short(rec.head)}`).then(() => stop("failed", "head-mismatch", { text: "Failed: merged at another commit than the one you looked at" }));
    rec = step(rec, { type: "merged" }) ?? rec; deps.records.set(key, rec);
    await log(`accept: merged at ${short(rec.head)}`);

    // 5. source sync (only after the read-back proved the merge). The order is fixed: the issue is read, then CLOSED (skipped when it is already
    // closed), then its status: labels are removed. Each mutating gh op is its own dep, dispatched right after its OWN final("post").
    const sd0 = sourceDecision(deps.task(ref.id, ref.project) ?? card0, deps.cards());
    const issue = sd0.action === "close" ? await deps.readIssue(sd0.ref) : null;
    const fs = final("post");
    if (!fs.ok) return keepMerged(fs);
    const sd = sourceDecision(fs.last, deps.cards()); // the latest cards decide: a sibling that appeared during the reads keeps the source open
    const sameIssue = sd.action === "close" && sd0.action === "close" && sd.ref.repo === sd0.ref.repo && sd.ref.number === sd0.ref.number;
    const left = sameIssue && issue?.ok ? issue.labels.filter((l) => /^status:/i.test(String(l).trim())) : [];
    const closing = sameIssue && issue?.ok && issue.state !== "CLOSED" ? deps.closeIssue({ ...sd.ref, comment: `Done: merged ${rec.url}` }) : null;
    let synced = true;
    if (sd.action === "close") {
      const where = `${sd.ref.repo}#${sd.ref.number}`;
      if (!sameIssue || !issue?.ok) synced = false;
      else if (closing) { if ((await closing).ok) await log(`accept: source closed ${where}`); else synced = false; }
      else await log(`accept: source already closed ${where}`);
      if (synced && left.length) {
        // The labels are cosmetic: if the gate no longer passes (or the source is no longer ours alone) they are skipped with a note. The close stands.
        const fl = final("post");
        const sdl = sourceDecision(fl.last, deps.cards());
        const still = fl.ok && sdl.action === "close" && sdl.ref.repo === sd.ref.repo && sdl.ref.number === sd.ref.number;
        const relabel = still ? deps.removeLabels({ ...sd.ref, labels: left }) : null;
        if (!still) await log(`accept: status labels not removed: ${fl.ok ? "another card now uses this source" : fl.why}`);
        else if ((await relabel).ok) await log(`accept: source ${where} status labels removed`);
        else synced = false;
      }
    } else if (sd.action === "keep-open") await log(`accept: source kept open: ${sd.why}`);
    else await log(`accept: source not synced: ${sd.why}`);
    if (!synced) {
      rec = step(rec, { type: "sync-failed" }) ?? rec; deps.records.set(key, rec);
      await log("accept: source sync failed, the merge stands; Finish retries it");
      return finish({ outcome: "synced-failed", text: "Merged, but the source sync failed. Finish retries it" });
    }
    rec = step(rec, { type: "synced" }) ?? rec; deps.records.set(key, rec);
  }

  // 6. Done (the owner's click is the owner's move), right after its own final()
  const fd = final(want0 === "nopr" ? "nopr" : "post");
  if (!fd.ok) return want0 === "nopr" ? refuse(fd) : keepMerged(fd);
  const moving = deps.moveDone(ref.id, ref.project);
  if (!(await moving)) {
    await log("accept: could not move the card to Done");
    return finish({ outcome: "failed", word: "move", text: kind === "pr" ? "Merged, but the card could not be moved to Done" : "The card could not be moved to Done" });
  }
  rec = step(rec, { type: "done" }) ?? rec; deps.records.set(key, rec);
  await log("accept: moved to Done");
  return finish({ outcome: "done", text: want0 === "post" ? "Finished: source synced and moved to Done" : kind === "pr" ? "Merged and moved to Done" : "Moved to Done" });
}

// Check again: read-only. Reads the card's evidence and the PR once more; writes nothing, never merges.
export async function checkAgain(ref, deps) {
  const key = lockKey(ref);
  const task = deps.task(ref.id, ref.project);
  if (!task) return { state: null, evidence: null, record: null };
  const evidence = (await deps.readEvidence(task)).evidence;
  const record = deps.records.get(key);
  const target = record ?? (evidence.pr.state === "found" ? { repo: evidence.repo, number: evidence.pr.number, url: evidence.pr.url, head: evidence.head } : null);
  const rb = target ? await deps.readBack(target) : null;
  return { state: rb?.ok ? rb.state : null, head: rb?.ok ? rb.head : null, evidence, record };
}
