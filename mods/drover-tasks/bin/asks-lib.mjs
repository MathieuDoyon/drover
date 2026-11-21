// The asks signal: WHY an agent waits (T-MWO2HGDSXX1, B4a). One small file per terminal: <home>/data/drover-asks/<terminal>.json
//   { v: 1, id, kind: permission|question|plan, tool: <fixed label>, at: <wall ms> }
// Signal only. Nothing here answers a dialog, prints, or waits long; every failure is swallowed (the caller exits 0).
// It stores NO title, command, file name or question text: kind and tool come from fixed lists, id is a counter, `at` is the hook's clock.
// Ordering (one logical domain, no wall clock after the seed): each invocation takes a ticket under a per-terminal lock
// (counter + 1, written before anything is published). `set` publishes id = ticket unless a newer ask is there; `clear` removes the ask
// only if ask.id < its ticket. Limit, stated: this is the order in which the hooks took the lock, not the order the agent emitted
// them (the CLIs give no correlation id). The reader (B4b) heals the rest: it shows a reason only while Herdr reports the agent
// blocked, and ignores an ask older than ASK_TTL_MS.
import { openSync, closeSync, fstatSync, readSync, writeSync, renameSync, unlinkSync, mkdirSync, lstatSync, statSync, rmdirSync, rmSync, fchmodSync, constants as C } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export const ASK_TTL_MS = 30 * 60 * 1000;
// Fresh while 0 <= now - at < ASK_TTL_MS: exactly 30 min old is NOT fresh; a future, missing or non-number `at` is not fresh.
export function askFresh(ask, nowMs) {
  const at = ask && typeof ask === "object" ? ask.at : undefined;
  if (typeof at !== "number" || !Number.isFinite(at) || typeof nowMs !== "number" || !Number.isFinite(nowMs)) return false;
  return at <= nowMs && nowMs - at < ASK_TTL_MS;
}

// The events the install registers, per CLI: generated from the verified spike table (spike-T-MWO2HGDSXX1.md). The doctor flags any other name.
export const KNOWN_EVENTS = {
  claude: ["PermissionRequest", "Notification", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionEnd"],
  codex: ["PermissionRequest", "PostToolUse", "UserPromptSubmit", "Stop"],
};
// Which of them record (`set`) and which remove (`clear`): the registered command is `<launcher> set|clear`.
export const EVENT_ACTION = {
  claude: { PermissionRequest: "set", Notification: "set", PreToolUse: "set", PostToolUse: "clear", UserPromptSubmit: "clear", Stop: "clear", SessionEnd: "clear" },
  codex: { PermissionRequest: "set", PostToolUse: "clear", UserPromptSubmit: "clear", Stop: "clear" },
};

const TOOLS = new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit", "PowerShell", "apply_patch", "AskUserQuestion", "ExitPlanMode"]);
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const terminalIdOk = (id) => typeof id === "string" && ID_RE.test(id) && !id.includes("..");

// kind + tool label from the payload: only two fields are looked at, only to pick from fixed lists.
function classify(text) {
  let nt, tn;
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object") { nt = o.notification_type; tn = o.tool_name; }
  } catch {
    const head = String(text).slice(0, 16384); // truncated or damaged JSON: look for the two fields in the head
    nt = /"notification_type"\s*:\s*"([A-Za-z_]{1,40})"/.exec(head)?.[1];
    tn = /"tool_name"\s*:\s*"([A-Za-z0-9_]{1,80})"/.exec(head)?.[1];
  }
  const fromNotification = typeof nt === "string" && nt !== "";
  let kind = "permission";
  if (nt === "elicitation_dialog") kind = "question";
  else if (!fromNotification && tn === "AskUserQuestion") kind = "question";
  else if (!fromNotification && tn === "ExitPlanMode") kind = "plan";
  const tool = typeof tn === "string" && TOOLS.has(tn) ? tn : typeof tn === "string" && tn.startsWith("mcp__") ? "mcp" : "tool";
  return { kind, tool, fromNotification };
}

const NOFOLLOW = C.O_NOFOLLOW ?? 0;
const uid = typeof process.getuid === "function" ? process.getuid() : -1;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// a no-follow read of a leaf: a regular file we own with one link and a small size, else null (corrupt: the caller replaces it)
function readLeaf(path) {
  let fd;
  try {
    fd = openSync(path, C.O_RDONLY | NOFOLLOW);
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== uid || s.nlink !== 1 || s.size > 4096) return null;
    const b = Buffer.alloc(s.size); readSync(fd, b, 0, s.size, 0);
    return b.toString("utf8");
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
// a private file written to a fresh O_EXCL|O_NOFOLLOW tmp in the same checked dir, then renamed over the leaf (rename replaces a planted link, never writes through it)
function writeLeaf(dir, leaf, text) {
  const tmp = join(dir, `${leaf}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, text); closeSync(fd); renameSync(tmp, join(dir, leaf)); }
  catch (e) { try { closeSync(fd); } catch {} try { unlinkSync(tmp); } catch {} throw e; }
}
const parseAsk = (text) => {
  if (text === null) return null;
  try { const a = JSON.parse(text); return a && typeof a === "object" && Number.isSafeInteger(a.id) && a.id >= 0 ? a : null; } catch { return null; }
};
const parseCounter = (text) => (text !== null && /^\d{1,16}$/.test(text.trim()) && Number.isSafeInteger(Number(text)) ? Number(text) : null);

// <home>/data/drover-asks, every level checked with lstat/no-follow: a symlink, a non-directory or a directory owned by another uid refuses (null)
function prepareDir(home, create) {
  try { if (!statSync(home).isDirectory()) return null; } catch { return null; }
  const data = join(home, "data");
  for (const [p, ours] of [[data, false], [join(data, "drover-asks"), true]]) {
    let l = null;
    try { l = lstatSync(p); } catch (e) { if (e.code !== "ENOENT") return null; }
    if (!l) { if (!create) return null; try { mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") return null; } }
    let fd;
    try {
      fd = openSync(p, C.O_RDONLY | NOFOLLOW | (C.O_DIRECTORY ?? 0)); // ELOOP on a symlink
      const s = fstatSync(fd);
      if (!s.isDirectory() || s.uid !== uid) return null;
      if (ours && (s.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700); // tightened through the checked fd, never by path
    } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  }
  return join(data, "drover-asks");
}

// The hook is killed by the launcher's own watcher at HOOK_KILL_MS (mods/drover-tasks/bin/drover-asks-hook: `sleep 3`; a test ties the two numbers).
// A lock older than LOCK_STALE_MS is reclaimed BY AGE ALONE: no pid, no guard. Because a hook cannot outlive HOOK_KILL_MS, a lock that old
// was left by a hook that died. Residual, stated plainly: a system suspend or a clock jump in the middle of a critical section can make a live
// holder look stale, so two holders may overlap; the worst case is one wrong or lost reason, covered by the reader (B4b: a reason is shown only while Herdr
// reports the agent blocked, and an ask older than ASK_TTL_MS is ignored). The lock is a directory <t>.lock (0700) holding `owner` = "<pid> <token>";
// a live holder is waited for up to lockWaitMs, then the invoker skips (fail open). The holder re-checks its token before each publish or delete.
export const HOOK_KILL_MS = 3000;
export const LOCK_STALE_MS = 10000;
function acquire(dir, t, deps) {
  const path = join(dir, `${t}.lock`), token = randomBytes(8).toString("hex");
  const t0 = performance.now();
  for (;;) {
    try { mkdirSync(path, { mode: 0o700 }); break; } catch (e) { if (e.code !== "EEXIST") return null; }
    let st = null; try { st = lstatSync(path); } catch { continue; }
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS /* mtime is real wall time, not the injected clock */) {
      deps.hooks?.beforeReclaim?.();
      const gone = `${path}.stale-${randomBytes(4).toString("hex")}`;
      try {
        renameSync(path, gone);
        let again = null; try { again = lstatSync(gone); } catch {}
        if (again && Date.now() - again.mtimeMs <= LOCK_STALE_MS) { try { renameSync(gone, path); } catch { rmSync(gone, { recursive: true, force: true }); } } // a faster reclaimer's live lock: put it back, best effort
        else rmSync(gone, { recursive: true, force: true });
      } catch {}
      continue;
    }
    if (performance.now() - t0 > deps.lockWaitMs) return null;
    sleepMs(5);
  }
  const ownerPath = join(path, "owner");
  try { const fd = openSync(ownerPath, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o600); writeSync(fd, `${process.pid} ${token}\n`); closeSync(fd); }
  catch { try { rmSync(path, { recursive: true, force: true }); } catch {} return null; }
  const owned = () => { const o = readLeaf(ownerPath); return o !== null && o.trim() === `${process.pid} ${token}`; };
  return { owned, release() { if (!owned()) return; try { unlinkSync(ownerPath); rmdirSync(path); } catch {} } };
}

// run one hook invocation. Never throws; returns a short status for tests: set | kept | dropped | cleared | noop | skip:id | skip:dir | skip:lock | lost | error
export function runAsk({ action, env = {}, input = "", deps = {} }) {
  const d = { now: deps.now ?? Date.now, lockWaitMs: deps.lockWaitMs ?? 150, hooks: deps.hooks ?? {} };
  try {
    if (action !== "set" && action !== "clear") return "noop";
    const t = env.HC_TERMINAL_ID;
    if (!terminalIdOk(t)) return "skip:id";
    const home = env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config", "herdr-app");
    const dir = prepareDir(home, action === "set");
    if (!dir) return action === "clear" ? "noop" : "skip:dir";
    const cls = action === "set" ? classify(input) : null;
    const askLeaf = `${t}.json`, seqLeaf = `${t}.seq`;
    // phase 1, under the lock: the ticket. The counter is written first (reserve before publish): a kill after it never reissues an id.
    let ticket;
    const l1 = acquire(dir, t, d);
    if (!l1) return "skip:lock";
    try {
      const ask = parseAsk(readLeaf(join(dir, askLeaf)));
      const last = parseCounter(readLeaf(join(dir, seqLeaf)));
      ticket = Math.max(last ?? Math.max(d.now(), 0), ask?.id ?? 0) + 1; // the wall clock only seeds a missing or corrupt counter
      writeLeaf(dir, seqLeaf, String(ticket));
      d.hooks.inLock1?.(ticket);
    } finally { l1.release(); }
    d.hooks.gap?.(ticket);
    // phase 2, under the lock: publish or delete by ticket
    const l2 = acquire(dir, t, d);
    if (!l2) return "skip:lock";
    try {
      d.hooks.inLock2?.(ticket);
      if (!l2.owned()) return "lost";
      const raw = readLeaf(join(dir, askLeaf)), cur = parseAsk(raw);
      if (action === "clear") {
        if (cur && cur.id >= ticket) return "dropped"; // an ask published after this clear took its ticket survives
        if (!l2.owned()) return "lost";
        try { unlinkSync(join(dir, askLeaf)); } catch (e) { if (e.code === "ENOENT") return "noop"; throw e; } // unlink never follows a link
        return "cleared";
      }
      if (cur && cur.id >= ticket) return "dropped"; // a newer ask is already there
      if (cls.fromNotification && cur && cur.kind === cls.kind && askFresh(cur, d.now())) return "kept"; // keep the richer PermissionRequest label
      if (!l2.owned()) return "lost";
      writeLeaf(dir, askLeaf, JSON.stringify({ v: 1, id: ticket, kind: cls.kind, tool: cls.tool, at: d.now() }));
      return "set";
    } finally { l2.release(); }
  } catch { return "error"; }
}
