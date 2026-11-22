// The asks reader's pure core (T-MWO3FDT7NKL, B4b): WHY a blocked agent waits. No I/O, no globals, no clock of its own: `now` is passed in.
// The hook (B4a, drover-tasks/bin/asks-lib.mjs) writes <home>/data/drover-asks/<terminal>.json = { v: 1, id, kind, tool, at }; a read-only helper
// (drover-tasks/bin/drover-asks-read) scans that folder; the needs cache feeds the scan here, once per refresh. Nothing here answers anything.
import { capReason } from "./store.js";

export const ASK_KINDS = ["permission", "question", "plan"];
// The fixed tool labels the hook may write (kept equal to asks-lib.mjs by a test) and the two generic ones.
export const ASK_TOOLS = ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit", "PowerShell", "apply_patch", "AskUserQuestion", "ExitPlanMode", "tool", "mcp"];
export const ASK_TTL_MS = 30 * 60 * 1000; // a stale ask of a GONE terminal is dropped after this (kept equal to asks-lib.mjs by a test)
export const asksFresh = (ask, now) => Number.isFinite(ask?.at) && Number.isFinite(now) && ask.at <= now && now - ask.at < ASK_TTL_MS;

const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const terminalIdOk = (id) => typeof id === "string" && ID_RE.test(id) && !id.includes("..");

// Allowlist copy: only id, kind, tool and at survive; anything else (a title, a command, a secret-looking string) is dropped. Bad shape: null.
export function cleanAsk(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (!Number.isSafeInteger(o.id) || o.id < 0 || !ASK_KINDS.includes(o.kind) || !ASK_TOOLS.includes(o.tool) || !Number.isFinite(o.at) || o.at < 0) return null;
  return { id: o.id, kind: o.kind, tool: o.tool, at: o.at };
}
// The hook's file text ({ v: 1, id, kind, tool, at }) -> a clean ask, or null.
export function parseAskFile(text) {
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  return o && typeof o === "object" && o.v === 1 ? cleanAsk(o) : null;
}

// The row reason of a blocked agent with an ask. Only a permission names its tool (a question or plan names itself).
export function askReason(ask) {
  if (!ask) return null;
  if (ask.kind === "question") return "Question for you";
  if (ask.kind === "plan") return "Plan to approve";
  const label = ask.tool === "mcp" ? "MCP tool" : ask.tool && ask.tool !== "tool" ? ask.tool : "";
  return capReason(label ? `Asks permission · ${label}` : "Asks permission");
}

// Per terminal memory: the ask now shown, the highest id ever seen, the dropped id (an id <= it never comes back) and the id seen while blocked.
// A scan is { ok: true, files: Map terminal -> parsed ask } (every file the helper accepted) or anything else (unknown: nothing is learned from it).
// update() -> Map terminal -> { id, kind, tool }; the same Map content for the same inputs (it is called once per cache refresh).
export function createAsksState() {
  const mem = new Map(); // terminal -> { ask, high, dropped, seen }
  const entry = (t) => { let e = mem.get(t); if (!e) { e = { ask: null, high: -1, dropped: -1, seen: -1 }; mem.set(t, e); } return e; };
  const drop = (e) => { if (e.ask) { e.dropped = Math.max(e.dropped, e.ask.id); e.ask = null; } };
  return {
    update({ scan = null, statuses = new Map(), alive = new Set(), now = Date.now() } = {}) {
      if (scan?.ok === true && scan.files instanceof Map) {
        for (const [t, e] of mem) if (e.ask && !scan.files.has(t)) drop(e); // a confirmed scan without its file = the hook cleared it
        for (const [t, f] of scan.files) {
          if (!terminalIdOk(t) || !f) continue;
          const e = entry(t);
          if (f.id <= e.dropped || f.id < e.high) continue; // an old read never revives or replaces a newer ask
          if (e.ask?.id === f.id) continue;
          e.ask = { id: f.id, kind: f.kind, tool: f.tool, at: f.at };
          e.high = f.id;
        }
      }
      const out = new Map();
      for (const [t, e] of [...mem]) {
        if (e.ask) {
          if (statuses.get(t) === "blocked") e.seen = e.ask.id;
          else if (e.seen === e.ask.id) drop(e); // it was blocked on this ask and is not now: answered
          else if (!alive.has(t) && !asksFresh(e.ask, now)) drop(e); // TTL: only a terminal that is gone
        }
        if (e.ask) out.set(t, { id: e.ask.id, kind: e.ask.kind, tool: e.ask.tool });
        else if (!alive.has(t) && !scan?.files?.has(t)) mem.delete(t); // nothing to remember for a gone terminal (a gone terminal id is not reused)
      }
      return out;
    },
  };
}
