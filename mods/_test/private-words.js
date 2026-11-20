// Private words for the "no machine or owner names" leak checks (machines-install.test.js, shipped-generic.test.js). Not a test file: both import it.
import { spawnSync } from "node:child_process";
import { userInfo, hostname } from "node:os";

// Private words are read at run time, so this public file never spells a person or a machine: this user and host, the linked machines
// (`hc machine ls --json`, skipped without hc) and an optional DROVER_PRIVATE_WORDS (comma-separated). Generic account and host names (a CI
// runner's) are skipped: they are not private and ordinary code uses such words. Words under 4 characters are ignored; matches are whole words.
export const GENERIC_LEAKS = /sddm|gdm\b|lightdm|autologin|greeter|hyprland|wayland|pacman|homelab|\/(Users|home)\/[A-Za-z]/i;
export const GENERIC_NAMES = new Set(["runner", "root", "admin", "user", "ubuntu", "ec2-user", "localhost", "github", "docker", "vagrant"]);
const clean = (w) => String(w || "").trim().toLowerCase();
export const privateWords = ({ username, host, extra = "", machines = [], ci = false } = {}) => {
  const w = new Set();
  if (!ci) for (const x of [username, host]) if (!GENERIC_NAMES.has(clean(x))) w.add(x);
  for (const x of extra.split(",")) w.add(x);
  for (const m of machines) { w.add(m.name); w.add(m.host); w.add(m.logout_linger_user); }
  return [...w].map(clean).filter((x) => x.length >= 4);
};
export const wholeWord = (text, word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(text);
// The lookup, with its completeness: `complete` is false when the machine list could not be read (hc missing, timed out, non-zero exit or
// malformed JSON), so a caller that must not pass on a half lookup (scripts/pre-pr-gate.sh) can tell "no machines" from "could not look".
// `notes` say what was not checked and never carry a word. `env` and `timeoutMs` exist for tests.
export const discoverPrivateWords = ({ env = process.env, timeoutMs = 10000 } = {}) => {
  let username, host, machines = [];
  const notes = [];
  try { username = userInfo().username; } catch { notes.push("local user: NOT CHECKED (unreadable)"); }
  try { host = hostname().split(".")[0]; } catch { notes.push("local host: NOT CHECKED (unreadable)"); }
  const r = spawnSync("hc", ["machine", "ls", "--json"], { encoding: "utf8", timeout: timeoutMs, env });
  if (r.error) notes.push(`machines: NOT CHECKED (${r.error.code === "ENOENT" ? "hc not found" : r.error.code === "ETIMEDOUT" ? "hc timed out" : "hc could not run"})`);
  else if (r.status !== 0) notes.push(`machines: NOT CHECKED (hc exited ${r.status})`);
  else {
    let list;
    try { list = JSON.parse(r.stdout).machines; } catch {}
    if (Array.isArray(list)) machines = list;
    else notes.push("machines: NOT CHECKED (hc printed malformed JSON)");
  }
  const words = privateWords({ username, host, extra: env.DROVER_PRIVATE_WORDS || "", machines, ci: !!env.CI });
  return { words, complete: notes.length === 0, notes };
};
export const runtimePrivateWords = () => discoverPrivateWords().words;
