// drover-asks-read <asks dir> (T-MWO3FDT7NKL, B4b): the Tasks mod's read-only scan of the asks folder. It reads ONLY the folder it is given.
// It never writes, deletes, creates or follows a link, and prints ONE JSON line: {"ok":true,"asks":[{terminal,id,kind,tool,at}]} (an absent folder = no asks).
// Anything it cannot establish (the data parent or the folder is a link or not ours, a listing or leaf read error, more than 1000 candidate files) prints nothing and exits 1: UNKNOWN, never "no asks".
// A file is accepted only when it is a regular file we own with one link, <= 4 KB, named <terminal>.json; it is lstat'ed BEFORE it is opened and opened
// O_NONBLOCK|O_NOFOLLOW, so a FIFO is never waited on. The content goes through the allowlist parser: no other field ever leaves this process.
import { lstatSync, openSync, fstatSync, readSync, closeSync, readdirSync, constants as C } from "node:fs";
import { join, dirname } from "node:path";
import { parseAskFile, terminalIdOk } from "../asks.js";

const MAX_CANDIDATES = 1000, MAX_BYTES = 4096;
const uid = typeof process.getuid === "function" ? process.getuid() : -1;
const NAME = /^(.+)\.json$/;

// A folder we trust, from ONE lstat: { state: "ok" | "absent" | "unknown", id }. "ok" = a real directory (never a link) owned by us; ENOENT is a fact (absent);
// any other failure is unknown. id = type, device, inode and owner of THAT lstat: the validation and the baseline are the same call, so a folder put in
// place after it can never become the trusted baseline.
const idOf = (l) => `${l.isDirectory() ? "d" : "x"}:${l.dev}:${l.ino}:${l.uid}`;
function folder(p) {
  let l;
  try { l = lstatSync(p); } catch (e) { return { state: e && e.code === "ENOENT" ? "absent" : "unknown" }; }
  return l.isDirectory() && l.uid === uid ? { state: "ok", id: idOf(l) } : { state: "unknown" };
}
const identity = (p) => { const f = folder(p); return f.state === "ok" ? f.id : null; }; // a re-check: null (changed type, owner, link, gone) never equals a baseline

// -> { ok: true, asks } only when the whole folder was read: every candidate file was either read or is gone (ENOENT) or is not a plain file of ours.
// Any other error (a leaf that cannot be opened or read, a listing that fails, too many candidates, an untrusted parent) -> null: UNKNOWN, never "no asks".
// Folder identity (round 2): data and drover-asks are lstat'ed before the listing, and again after the listing and after the last leaf read; any change of type, dev,
// ino or owner (a link or another folder put in their place) makes the scan unknown. Residual, stated plainly (final): the baseline is the one validating lstat; a same-user process can still replace a folder
// between the last check and the moment the line is printed (or swap it back in between two checks); that needs the user's own write access to the home,
// and the worst case is one stale or missing reason for a second. `hooks` is for tests only (they act at the points between the checks).
export function scan(dir, hooks = {}) {
  const parent = folder(dirname(dir)); // like the producer's prepareDir: <home>/data and <home>/data/drover-asks, no link, our uid
  if (parent.state === "unknown") return null;
  if (parent.state === "absent") return { ok: true, asks: [] };
  const own = folder(dir);
  if (own.state === "unknown") return null;
  if (own.state === "absent") return { ok: true, asks: [] };
  hooks.afterValidate?.(); // test points: right after the validation, which is also the baseline
  hooks.afterCheck?.();
  const same = () => identity(dirname(dir)) === parent.id && identity(dir) === own.id;
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  hooks.afterList?.();
  if (!same()) return null;
  const candidates = [];
  for (const n of names) {
    const m = NAME.exec(n);
    if (m && terminalIdOk(m[1])) candidates.push([m[1], n]); // .seq, locks and strangers never count against the budget
  }
  if (candidates.length > MAX_CANDIDATES) return null;
  const asks = [];
  for (const [terminal, n] of candidates) {
    const p = join(dir, n);
    let fd;
    try {
      const s0 = lstatSync(p);
      if (!s0.isFile()) continue; // FIFO, socket, device, link, folder: never opened, not an ask
      fd = openSync(p, C.O_RDONLY | C.O_NONBLOCK | (C.O_NOFOLLOW ?? 0));
      const s = fstatSync(fd);
      if (!s.isFile() || s.uid !== uid || s.nlink !== 1 || s.size > MAX_BYTES) continue; // not a file of ours: not an ask
      const b = Buffer.alloc(s.size);
      const got = readSync(fd, b, 0, s.size, 0);
      if (got !== s.size) return null; // changed while reading: unknown
      const ask = parseAskFile(b.toString("utf8", 0, got));
      if (ask) asks.push({ terminal, ...ask });
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ELOOP")) continue; // gone (the hook cleared it) or swapped for a link: not an ask
      return null; // EACCES, EIO, EMFILE...: we could not look, so we do not know
    } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  }
  hooks.afterReads?.();
  return same() ? { ok: true, asks } : null;
}

if (process.argv[1]?.endsWith("drover-asks-read.mjs")) { // run as the helper, not when a test imports scan()
  const dir = process.argv[2];
  const r = typeof dir === "string" && dir !== "" ? scan(dir) : null;
  if (!r) process.exit(1);
  process.stdout.write(JSON.stringify(r) + "\n");
}
