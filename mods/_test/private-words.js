// Private words for the "no machine or owner names" leak checks (machines-install.test.js, shipped-generic.test.js). Not a test file: both import it.
import { spawnSync } from "node:child_process";
import { userInfo, hostname } from "node:os";

// Private words are read at run time, so this public file never spells a person or a machine: this user and host, the linked machines
// (`hc machine ls --json`, skipped without hc) and an optional DROVER_PRIVATE_WORDS (comma-separated). Generic account and host names (a CI
// runner's) are skipped: they are not private and ordinary code uses such words. Words under 4 characters are ignored; matches are whole words.
export const GENERIC_LEAKS = /sddm|gdm\b|lightdm|autologin|greeter|hyprland|wayland|pacman|homelab|\/(Users|home)\/[A-Za-z]/i;
const GENERIC_NAMES = new Set(["runner", "root", "admin", "user", "ubuntu", "ec2-user", "localhost", "github", "docker", "vagrant"]);
const clean = (w) => String(w || "").trim().toLowerCase();
export const privateWords = ({ username, host, extra = "", machines = [], ci = false } = {}) => {
  const w = new Set();
  if (!ci) for (const x of [username, host]) if (!GENERIC_NAMES.has(clean(x))) w.add(x);
  for (const x of extra.split(",")) w.add(x);
  for (const m of machines) { w.add(m.name); w.add(m.host); w.add(m.logout_linger_user); }
  return [...w].map(clean).filter((x) => x.length >= 4);
};
export const wholeWord = (text, word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(text);
export const runtimePrivateWords = () => {
  let username, host, machines = [];
  try { username = userInfo().username; } catch {}
  try { host = hostname().split(".")[0]; } catch {}
  try {
    const r = spawnSync("hc", ["machine", "ls", "--json"], { encoding: "utf8", timeout: 10000 });
    if (r.status === 0) machines = JSON.parse(r.stdout).machines || [];
  } catch {}
  return privateWords({ username, host, extra: process.env.DROVER_PRIVATE_WORDS || "", machines, ci: !!process.env.CI });
};
