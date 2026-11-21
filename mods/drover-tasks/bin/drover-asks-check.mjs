// drover doctor helper (T-MWO2HGDSXX1): reads ONE hook config file read-only and prints ONE fixed code, never a path, a value or any content.
//   node drover-asks-check.mjs <claude|codex> <config file>   ->  ok:<n> | absent | none | unreadable | unknown | missing | noscript | noexec | action | command
//   node drover-asks-check.mjs locks <asks dir>               ->  nodir | ok | stale | unreadable   (stale: a <t>.lock directory older than LOCK_STALE_MS; read-only, no follow)
// Exit status is always 0. The doctor maps each code to its fixed phrase.
import { openSync, fstatSync, readSync, closeSync, statSync, accessSync, readdirSync, lstatSync, constants as C } from "node:fs";
import { KNOWN_EVENTS, EVENT_ACTION, LOCK_STALE_MS } from "./asks-lib.mjs";

const out = (code) => { process.stdout.write(code + "\n"); process.exit(0); };
const [cli, file] = process.argv.slice(2);
function locks() {
  let names;
  try { names = readdirSync(file); } catch (e) { return e && e.code === "ENOENT" ? "nodir" : "unreadable"; }
  for (const n of names) {
    if (!n.endsWith(".lock")) continue;
    let st; try { st = lstatSync(`${file}/${n}`); } catch { continue; }
    if (st.isDirectory() && Date.now() - st.mtimeMs > LOCK_STALE_MS) return "stale";
  }
  return "ok";
}
function check() {
  if (!KNOWN_EVENTS[cli] || !file) return "unreadable";
  let text;
  try {
    const fd = openSync(file, C.O_RDONLY | C.O_NONBLOCK); // a symlinked dotfile is followed on purpose: read-only. NONBLOCK: a FIFO with no writer must not hang the open; fstat then rejects it
    try { const s = fstatSync(fd); if (!s.isFile()) return "unreadable"; if (s.size > 2 * 1024 * 1024) return "unreadable"; const b = Buffer.alloc(s.size); readSync(fd, b, 0, s.size, 0); text = b.toString("utf8"); } finally { closeSync(fd); }
  } catch (e) { return e && e.code === "ENOENT" ? "absent" : "unreadable"; }
  let root;
  try { root = JSON.parse(text); } catch { return "unreadable"; }
  if (!root || typeof root !== "object" || Array.isArray(root)) return "unreadable";
  const entries = []; // our handlers: a command naming drover-asks-hook
  const hooks = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? root.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (h && h.type === "command" && typeof h.command === "string" && h.command.includes("drover-asks-hook")) entries.push({ event, command: h.command });
    }
  }
  if (!entries.length) return "none";
  const problems = new Set(), seen = new Set();
  for (const { event, command } of entries) {
    const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+(set|clear)\s*$/.exec(command);
    if (!m) { problems.add("command"); continue; }
    const script = m[1] ?? m[2] ?? m[3], action = m[4];
    if (!KNOWN_EVENTS[cli].includes(event)) { problems.add("unknown"); continue; }
    if (EVENT_ACTION[cli][event] !== action) problems.add("action"); else seen.add(event);
    try { if (!statSync(script).isFile()) problems.add("noscript"); else accessSync(script, C.X_OK); } catch (e) { problems.add(e && e.code === "ENOENT" ? "noscript" : "noexec"); }
  }
  for (const p of ["unknown", "noscript", "noexec", "command", "action"]) if (problems.has(p)) return p;
  if (KNOWN_EVENTS[cli].some((e) => !seen.has(e))) return "missing";
  return `ok:${entries.length}`;
}
let code = "unreadable";
try { code = cli === "locks" ? locks() : check(); } catch {}
out(code);
