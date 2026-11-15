// Pure helpers for the editor's note composer, sub-issues and activity folding. Host calls come in as deps.
import { childrenOf } from "./store.js";
import { linkedRun } from "./taskrun.js";

// The note as an agent receives it: tagged as from the person.
export const taggedText = (text) => `[Note from the person] ${String(text).trim()}`;

// The note a freshly started agent gets: the launcher frames it and appends it to the card's own prompt (leaderPrompt, ctx.note).
export const launchPrompt = (text) => String(text).trim();

// The live agent to deliver to: task.agent when alive, else the linked run's leader (role "leader", else the last terminal) when alive.
export function liveAgent(task, runs, alive) {
  if (task.agent && alive.has(task.agent)) return task.agent;
  const ts = linkedRun(task, runs)?.terminals ?? [];
  const leader = ts.find((m) => m.role === "leader") ?? ts[ts.length - 1];
  return leader && alive.has(leader.address) ? leader.address : null;
}

// Save the note first, always. Then: a live agent gets it (hc send); else a chosen agent/squad is started with it in its prompt;
// choice "none" only saves. Failures after the save keep the note and return {error}.
// deps: saveNote(text) · hcSend(address, text) · launch(choice, task, prompt) (may return {error}).
export async function routeSend({ task, runs, alive, choice, text, deps }) {
  const body = String(text ?? "").trim();
  if (!body) return { empty: true };
  try { await deps.saveNote(body); } catch (e) { return { error: String(e?.message ?? e) }; }
  if (!choice || choice === "none") return { saved: true };
  try {
    const to = liveAgent(task, runs, alive);
    if (to) { await deps.hcSend(to, taggedText(body)); return { sent: to }; }
    const run = await deps.launch(choice, task, launchPrompt(body));
    if (run?.error) return { error: run.error };
    return { started: true };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

// The Sub-issues section: children of the task (archived ones hidden) with progress "done/total". Null when there are none.
export function subIssues(task, tasks) {
  const rows = childrenOf(tasks, task.id).filter((t) => !t.archived);
  if (!rows.length) return null;
  const done = rows.filter((t) => t.column === "done").length;
  return { rows, done, total: rows.length, progress: `${done}/${rows.length}` };
}

// Notes as a list of items: 2+ consecutive system/log notes fold into one "› N activities" item; the rest stay notes.
// Every note keeps its index in the original list.
const quiet = (n) => n.kind === "log" || n.by === "system";
export function foldNotes(notes) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) out.push({ type: "note", note: run[0].n, index: run[0].i });
    else if (run.length) out.push({ type: "fold", count: run.length, label: `› ${run.length} activities`, notes: run.map(({ n, i }) => ({ ...n, index: i })) });
    run = [];
  };
  (notes ?? []).forEach((n, i) => {
    if (quiet(n)) run.push({ n, i });
    else { flush(); out.push({ type: "note", note: n, index: i }); }
  });
  flush();
  return out;
}

// "6d ago", "3h ago", "just now" ("" without a time).
export function ago(ms, now = Date.now()) {
  if (ms == null) return "";
  const m = Math.floor((now - ms) / 60000);
  return m < 1 ? "just now" : `${m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`} ago`;
}

// The letter in an avatar circle.
export const initialOf = (name) => (String(name ?? "").trim()[0] ?? "?").toUpperCase();

// Blend two #rrggbb colors: k = 0 gives a, 1 gives b. Anything else comes back as a.
export function mix(a, b, k) {
  const hex = /^#([0-9a-f]{6})$/i, x = hex.exec(a), y = hex.exec(b);
  if (!x || !y) return a;
  const ch = (i) => Math.round(parseInt(x[1].slice(i, i + 2), 16) * (1 - k) + parseInt(y[1].slice(i, i + 2), 16) * k).toString(16).padStart(2, "0");
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

// A reference a person can paste to an agent: "<task id>#<note id>". `drover task <T-…>` lists the note ids.
export const noteRef = (task, note) => `${task.id}#${note.id}`;

// The note text as a markdown quote.
export const noteQuote = (note) => String(note.text ?? "").split("\n").map((l) => `> ${l}`).join("\n");

// Create-task prefill for "Create sub-task from here": parent = the task, description = quoted note + its reference.
export const subtaskPrefill = (task, note) => ({ parent: task.id, desc: `${noteQuote(note)}\n\nFrom note ${noteRef(task, note)}` });
