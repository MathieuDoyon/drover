// Pure view models for the task editor's Run and Wakeups sections. No host calls.
import { runStatus, lineageOf, squadRows, durationText } from "./runs.js";
import { isOpen, wakeOrder } from "./wake.js";
import { age, prLabel } from "./sources.js";

// The runs of one task, newest started first.
export const taskRuns = (task, runs) => runs.filter((r) => r.task === task.id).sort((a, b) => (b.started ?? 0) - (a.started ?? 0));

// Who wrote a note. A person ("you") stays; an agent address resolves to "Name (role)" from the task's runs, newest first;
// an address that no run knows stays as is.
export function noteAuthor(by, task, runs) {
  const who = String(by ?? "").trim() || "you";
  const m = taskRuns(task, runs).flatMap((r) => r.terminals ?? []).find((x) => x.address === who);
  if (!m?.name) return who;
  return m.role && m.role.toLowerCase() !== m.name.toLowerCase() ? `${m.name} (${m.role})` : m.name;
}

// What the Run section shows for one run. live: Map address -> status; alive: Set of addresses.
export function runSummary(run, live, alive, now, allRuns) {
  const started = typeof run.started === "number" ? run.started : null;
  return {
    id: run.id,
    status: runStatus({ ...run, terminals: run.terminals ?? [] }, live, alive),
    runner: run.name ?? run.id,
    branch: run.worktree?.branch ?? null,
    durationText: durationText(started == null ? null : (run.ended ?? now) - started),
    rows: squadRows(lineageOf(run, allRuns, live, alive, now)),
  };
}

// The run the task is linked to (stored task.run), not the newest. Null when the link is cleared or the run is gone.
export const linkedRun = (task, runs) => (task.run ? runs.find((r) => r.id === task.run && r.task === task.id) ?? null : null);

// The task's other runs, newest first (all of them when the link is cleared).
export const pastRuns = (task, runs) => taskRuns(task, runs).filter((r) => r.id !== task.run);

// Wakeups aimed at the task id, or at a terminal of the LINKED run, each once. Open first (by due), then ended (newest).
export function taskWakes(task, runs, wakes) {
  const targets = new Set([task.id, ...(linkedRun(task, runs)?.terminals ?? []).map((m) => m.address)]);
  const seen = new Set();
  return wakes.filter((w) => targets.has(w.target) && !seen.has(w.id) && seen.add(w.id)).sort((a, b) => (isOpen(a) === isOpen(b) ? wakeOrder(a, b) : isOpen(a) ? -1 : 1));
}

// "Wake task" or "Wake <member name>" (the address when the member is unknown).
export function wakeLabel(w, task, runs) {
  if (w.target === task.id) return "Wake task";
  const m = (linkedRun(task, runs)?.terminals ?? []).find((x) => x.address === w.target);
  return `Wake ${m?.name ?? w.target}`;
}

// The Source mini card: null without a loaded issue, else what the card shows (a click opens url).
export const sourceCard = (issue) => (issue ? { kind: issue.kind, key: issue.key, title: issue.title, status: issue.status, category: issue.category, url: issue.url, assignee: issue.assignee ?? null, parent: issue.parent ?? null } : null);

// Pull request rows: open (and draft) first, then the rest; newest first within each group.
export function prRows(prs, now) {
  const live = (p) => p.state === "Open" || p.state === "Draft";
  const own = (p) => (p.from === "linked" ? 1 : 0); // the run's own branch PRs first
  return [...(prs ?? [])].sort((a, b) => own(a) - own(b) || (live(a) === live(b) ? (b.created ?? 0) - (a.created ?? 0) : live(a) ? -1 : 1))
    .map((p) => ({ number: p.number, label: prLabel(p), title: p.title, state: p.state, age: age(p.created, now), url: p.url }));
}

// What the editor's Source and Pull requests sections show. stale: a refresh failed and the earlier data is still on screen.
export function contextRows(ctx, now = Date.now()) {
  const errors = ctx?.errors ?? [];
  const issue = sourceCard(ctx?.issue), prs = prRows(ctx?.prs, now);
  return { issue, prs, errors, stale: errors.length > 0 && (issue != null || prs.length > 0) };
}

// The previous context to merge a refresh into: PRs belong to a run, so a different linked run drops them (the task-scoped issue stays).
export const carryContext = (prev, runId) => (!prev || prev.run === runId ? prev : { ...prev, prs: null, run: runId });
