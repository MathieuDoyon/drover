// Runs screen cache (T-MWO2HFSB34T). Pure and memory-only like needs.js: no I/O, no globals. refresh() derives EVERYTHING the Runs screen draws (live status,
// slot snapshot and lines, status/waiting per run, the squad member rows, the live run line, the resume state of ended runs) and runs OUTSIDE render
// (init, a 1 s timer, after the screen's own saves); get() only returns the stored value. Each refresh stores a NEW value; refresh() returns true when
// what the screen shows really changed (the minute and the stale flag of a line are part of that, so an idle screen repaints once a minute, not each second).
import { liveStatuses, runStatus, runTitle, slotSnapshot, slotLine, lineageOf, squadRows } from "./runs.js";
import { lineOf, lineLabel } from "./runline.js";
import { age } from "./sources.js";

const EMPTY = Object.freeze({ all: [], active: [], slotLines: [], endedCount: 0, limit: 0, alive: new Set(), at: 0 });

// read() returns { runs, tasks, projects, agents, terminals, resumeOf? }. resumeOf(runId) -> { state, can } is asked for ENDED runs only, and only when given
// (the screen offers it while ended runs are shown: it reads a few shared keys per run).
export function createRunsCache({ read, now = () => Date.now() }) {
  let value = { ...EMPTY };
  let sig = "";
  return {
    get: () => value,
    signature: () => sig,
    refresh() {
      const { runs = [], tasks = [], projects = [], agents = [], terminals = [], resumeOf } = read();
      const t = now();
      const live = liveStatuses(agents, terminals);
      const alive = new Set(terminals.map((x) => x.address));
      const byTask = new Map(tasks.map((x) => [x.id, x]));
      const snap = slotSnapshot(runs, tasks, live, alive);
      const slotLines = projects.map((p) => slotLine(snap.byProject.get(p.id), snap.limit, p.name)).filter(Boolean);
      const all = runs.map((r) => {
        const status = runStatus(r, live, alive);
        const task = byTask.get(r.task);
        const line = lineOf(r, status, t);
        return { r, status, waiting: snap.waitingRunIds.has(r.id), task: task ? { column: task.column, title: task.title } : null, title: runTitle(r, task), startedText: age(r.started, t),
          rows: squadRows(lineageOf(r, runs, live, alive, t)), line, lineText: lineLabel(line), resume: status === "ended" && resumeOf ? resumeOf(r.id) : null };
      });
      // Both display lists are chosen here: the screen picks `all` (Show ended) or `active` (the default) and only formats it.
      const active = all.filter((x) => x.status !== "ended");
      const next = { all, active, slotLines, endedCount: all.length - active.length, limit: snap.limit, alive, at: t };
      // What the screen draws, as text. The rows' raw durationMs (it moves every second) is left out; their durationText is minute-granular, so a running duration changes the result once a minute.
      const nextSig = JSON.stringify([slotLines, all.map((e) => [e.r.id, e.r.name, e.r.space, e.r.worktree?.path, e.r.worktree?.branch, e.status, e.waiting, e.task, e.title, e.startedText, e.lineText, e.line?.stale ?? null, e.resume, e.rows.map(({ durationMs: _d, ...m }) => m)])]);
      const changed = nextSig !== sig;
      value = next;
      sig = nextSig;
      return changed;
    },
  };
}
