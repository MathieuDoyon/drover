// Live run line (T-MWO2HFSB34T): what a working run says it is doing. Pure and memory-only: no I/O, no globals, `now` is passed in.
// validate() is authoritative in the inbox consumer and also runs in the CLI before anything is written; lineOf() is the display view;
// activeFor() answers "may this terminal post a line for this card". Secret and home-path checks are best effort, like scanSecrets itself.
import { scanSecrets, homePath } from "./herd-export.js";
import { memberStatus, runStatus } from "./runs.js";

export const LINE_MAX = 40;
export const LINE_STALE_MS = 10 * 60000;

// C0 and C1 controls (newline and tab included) and DEL.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const fail = (error) => ({ ok: false, error });

// text: the line. progress: undefined/null (none), an integer 0..100, or a whole-number string (the CLI passes argv text).
// Returns { ok: true, text, progress: number|null } or { ok: false, error }. Errors name a rule, never the value.
export function validate(text, progress) {
  if (typeof text !== "string") return fail("text is required");
  if (CONTROL.test(text)) return fail("text has a newline or control character");
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return fail("text is empty");
  const length = [...clean].length;
  if (length > LINE_MAX) return fail(`text is ${length} characters, the limit is ${LINE_MAX}: rewrite it shorter`);
  const rules = scanSecrets(clean);
  if (rules.length) return fail(`text looks like a secret (${rules.join(", ")}): never put a value in a line`);
  if (homePath(clean)) return fail("text has a home folder path (home-path)");
  let pct = null;
  if (progress !== undefined && progress !== null) {
    const n = typeof progress === "string" && /^\d{1,3}$/.test(progress) ? Number(progress) : progress;
    if (!Number.isInteger(n) || n < 0 || n > 100) return fail("progress must be a whole number from 0 to 100");
    pct = n;
  }
  return { ok: true, text: clean, progress: pct };
}

// The display view of a run's line, or null. status: runStatus(run, live, alive) computed by the caller from the live state, so a run whose
// terminals are gone shows no line even when its record was never stamped (legacy runs, the gap before observeEnded).
// ageMin: whole minutes (0 = under one minute, shown "<1m"); stale: the line is LINE_STALE_MS old or more.
export function lineOf(run, status, now) {
  const l = run?.line;
  if (!l || run.ended != null || status === "ended") return null;
  if (typeof l.text !== "string" || !l.text || !Number.isFinite(l.at)) return null;
  const age = Math.max(0, now - l.at);
  return { text: l.text, progress: Number.isInteger(l.progress) ? l.progress : null, ageMin: Math.floor(age / 60000), stale: age >= LINE_STALE_MS };
}

// The active run of `task` that has a terminal with address `by`: { run, terminal }, else null. Active = not stamped ended AND not ended
// by the live state. Runs are newest first, so the first match wins.
export function activeFor(runs, task, by, live, alive) {
  if (!Array.isArray(runs) || !task || !by) return null;
  for (const run of runs) {
    if (run?.task !== task || run.ended != null || !Array.isArray(run.terminals) || !run.terminals.length) continue;
    const terminal = run.terminals.find((t) => t?.address === by);
    if (terminal && runStatus(run, live, alive) !== "ended") return { run, terminal };
  }
  return null;
}

// What a screen shows for a view from lineOf: "reading the code · 40% · 3m" (no percent without progress, "<1m" under a minute). "" for no view.
export const lineLabel = (v) => (v ? [v.text, Number.isInteger(v.progress) ? `${v.progress}%` : null, v.ageMin < 1 ? "<1m" : `${v.ageMin}m`].filter(Boolean).join(" · ") : "");
