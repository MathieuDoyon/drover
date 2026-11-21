// Shared by the B3b dialog tests (accept-guard, accept-render, accept-dialog): a fake host around the real Todos dialog and Tasks panel.
// `gh` answers every env-wrapped gh call as READ-ONLY JSON; `trap` records every exec so a test can prove no write verb ever reached the host.
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReview } from "../_lib/evidence.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
export const { default: Todos } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
export const { default: Tasks } = await import(new URL("../drover-tasks/main.js", import.meta.url).href);
export const C = await import(new URL("../_lib/config.js", import.meta.url).href);
export const IO = await import(new URL("../_lib/io.js", import.meta.url).href);
export const { until, drain } = await import("./stubs/until.js");

export const A = "a".repeat(40), B = "b".repeat(40), OLD = "9".repeat(40);
export const URL5 = "https://github.com/o/r/pull/5";
export const ISSUE = "https://github.com/o/r/issues/7";
export const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
export const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
export const card = (i, o = {}) => ({ id: `T-${i}`, title: `card ${i}`, column: COLS[i % 6], priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: null, run: null, notes: [], desc: "", assignee: null, source: null, ...o });
export const ok = (v) => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "" });
export const success = (name) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" });
export const prJson = (o = {}) => ({ number: 5, url: URL5, state: "OPEN", baseRefName: "main", baseRefOid: B, headRefName: "feat/x", headRefOid: A, statusCheckRollup: [success("build")], isDraft: false, mergeable: "MERGEABLE", title: "feat: x", body: "Part of the work", ...o });

export const SIDE = ["exec", "hc", "read", "write", "watch", "every", "spawn", "set", "agents", "terminals"];
export const none = Object.fromEntries(SIDE.map((k) => [k, 0]));
export const delta = (calls, fn) => { const b = { ...calls }; const out = fn(); return { out, d: Object.fromEntries(SIDE.map((k) => [k, (calls[k] ?? 0) - (b[k] ?? 0)])) }; };
export const render = (v, cx) => { globalThis.__rec = { ids: [], texts: [], inputs: [] }; try { v.render(cx); return { ...globalThis.__rec }; } finally { globalThis.__rec = undefined; } };

// A gh/git/system call that could change something. The trap fails the test that lets one reach the host.
export const WRITE_GH = [["pr", "merge"], ["pr", "close"], ["pr", "edit"], ["pr", "comment"], ["pr", "ready"], ["pr", "create"], ["issue", "edit"], ["issue", "close"], ["issue", "reopen"], ["issue", "comment"], ["label"], ["release"]];
export function isWrite(cmd, args) {
  if (cmd === "git") return ["push", "commit", "merge", "reset", "checkout", "rebase", "tag", "branch", "fetch", "pull"].includes(args[0]);
  const g = cmd === "/usr/bin/env" ? args.slice(args.indexOf("gh") + 1) : cmd === "gh" ? args : null;
  if (!g) return false;
  if (WRITE_GH.some((w) => w.every((x, i) => g[i] === x))) return true;
  if (g[0] === "api" && g.some((a, i) => /^(-X|--method)(=.*)?$/.test(a) && (a.includes("=") ? !/=GET$/i.test(a) : !/^GET$/i.test(g[i + 1] ?? "")))) return true;
  return g.some((a) => /^(--admin|--auto|--delete-branch)$/.test(a));
}

export const router = (o = {}) => (g) => {
  if (g[0] === "api" && g[1] === "user") return ok("reader\n");
  if (g[0] === "api" && /\/commits$/.test(g[1])) return ok((o.commits ?? ["feat: x"]).map((m) => JSON.stringify(m)).join("\n") + "\n");
  if (g[0] === "api" && g.includes("--jq=.commits")) return ok(String(o.commitCount ?? (o.commits ?? ["feat: x"]).length));
  if (g[0] === "api") return ok(B + "\n");
  if (g[0] === "repo") return ok({ nameWithOwner: "o/r" });
  if (g[0] === "pr" && g[1] === "list") return ok(o.list ?? [{ number: 5, url: URL5, state: "OPEN" }]);
  return o.view ?? ok(prJson());
};
export const reviewNote = (head, verdict = "pass") => ({ id: "n9", at: 9, by: "inspector", kind: "review", text: formatReview({ head, verdict, report: "/w/review one.md" }) });
export const approvedNote = { id: "n8", at: 8, by: "coordinator", kind: "decision", text: "plan approved" };
export const WT = { id: "R-1", task: "T-3", worktree: { path: "/w", repo: "/repo", branch: "feat/x" } };
export const rev = (o = {}) => card(3, { column: "review", run: "R-1", source: { kind: "github", id: "o/r#7", url: ISSUE }, ...o });

export function host(tasks, { gh = (...a) => router()(...a), props = {}, remote = false, runSpawn = true, trap = false } = {}) {
  C.resetCache(); C.setSettings("drover-tasks", {}); C.setSettings("drover-runs", {}); C.setSettings("drover-wakeups", {}); C.setSettings("drover-todos", {});
  IO.resetRemoteWriter();
  const home = mkdtempSync(join(tmpdir(), "accept-home-"));
  const calls = { exec: 0, hc: 0, read: 0, write: 0, watch: 0, every: 0, spawn: 0, set: 0, agents: 0, terminals: 0, opened: [], log: [], writes: [] };
  const reads = {};
  const raw = { "drover.tasks": tasks, "drover.projects": [P], "drover.runs": [] };
  const state = new Proxy(raw, { get(o, k) { if (typeof k === "string") reads[k] = (reads[k] ?? 0) + 1; return o[k]; }, set(o, k, v) { calls.set++; o[k] = v; return true; } });
  const h = {
    props, notified: [], home: "/h", appHome: home, state, focused: { terminal: "t1", cwd: "/x", space: null }, spaces: [], panes: [], overlays: [],
    exec: async (cmd, args, opts) => {
      calls.exec++; calls.log.push([cmd, ...args]);
      if (trap && isWrite(cmd, args)) calls.writes.push([cmd, ...args]);
      if (cmd === "test") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "open") { calls.opened.push(args); return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "git") return args[0] === "log" ? ok("a1 one") : args[0] === "diff" ? ok(" f.js | 1 +") : args[0] === "rev-parse" ? ok(A) : { code: 0, stdout: "", stderr: "" };
      return gh(args.slice(args.indexOf("gh") + 1), opts);
    },
    hc: async () => { calls.hc++; return { code: 1, stdout: "", stderr: "" }; },
    readTextFile: async () => { calls.read++; return null; },
    writeTextFile: async () => { calls.write++; },
    watchFolder: async () => { calls.watch++; },
    openOverlay: (o) => { h.overlays.push(o); return "ov1"; }, closeOverlay: (id) => { calls.closed = id; },
    run: () => {},
  };
  Object.defineProperty(h, "agents", { get() { calls.agents++; return []; } });
  Object.defineProperty(h, "terminals", { get() { calls.terminals++; return []; } });
  globalThis.__host = h;
  const timers = [];
  const cx = { notify() { calls.notified = (calls.notified ?? 0) + 1; }, stop_propagation() {}, spawn(f) { calls.spawn++; return runSpawn ? f(cx) : undefined; }, focus_handle: () => ({ focus() {} }), timer: { every(ms, f) { calls.every++; timers.push({ ms, f }); }, after() { calls.every++; } } };
  return { h, cx, raw, calls, reads, timers, home };
}

// Opens the dialog through the real host class: props { overlay, proof }.
export async function open(tasks, o = {}) {
  const m = host(tasks, { ...o, props: { overlay: "ov1", proof: { id: "T-3", project: P.id } } });
  m.raw["drover.runs"] = [WT];
  const v = new Todos();
  v.init({}, m.cx);
  if (!o.noWait) await until(() => v.proof.state !== "reading", "proof loaded");
  return { ...m, v };
}
export const has = (r, s) => r.texts.some((x) => x.includes(s));
export const good = (o = {}) => rev({ notes: [approvedNote, reviewNote(A)], ...o });

// The native click context expires across an await; only the AsyncContext handed to the spawn callback is durable (gpui-kit.d.ts). This wraps a
// host cx: the click cx works until its spawn callback first awaits, then notify throws; the callback gets a DISTINCT durable cx that counts its notifies.
export function expiringCx(cx) {
  const durable = { notified: 0, notify() { this.notified++; }, spawn: cx.spawn };
  const click = {
    ...cx, expired: false, durable,
    notify() { if (click.expired) throw new Error("event context expired across an await"); cx.notify(); },
    spawn(f) { const p = f(durable); click.expired = true; return p; },
  };
  return click;
}
