// Drover's two Herdr key bindings in the owner's keys.json. Pure (text in, text out), plus apply() which takes the file io.
// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// Safety: the file is only touched when it parses to an object AND is exactly JSON.stringify(parsed, null, 2) + "\n"
// (so rewriting it changes nothing but our one binding); a key bound to something else is never overridden.

export const SHORTCUTS = [
  { id: "sidebar", title: "Toggle the Drover sidebar", description: "Show or hide the Drover sidebar.", section: "layout:drover", key: "cmd-alt-b", binding: { command: "layout.toggle", args: { id: "drover" } } },
  { id: "newtask", title: "Create task", description: "Open the Create task dialog from anywhere.", section: "global", key: "cmd-shift-c", binding: "mod.open:drover-newtask" },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const canonical = (o) => JSON.stringify(o, null, 2) + "\n";
const invalid = (error) => ({ ok: false, state: "invalid", error });

// text -> { ok: true, keys } | { ok: false, state: "invalid", error }
function parse(text) {
  if (text == null) return invalid("keys.json was not found");
  let keys;
  try { keys = JSON.parse(text); } catch { return invalid("keys.json is not valid JSON; left untouched"); }
  if (!isObj(keys)) return invalid("keys.json is not a JSON object; left untouched");
  if (canonical(keys) !== text) return invalid("keys.json is not in the standard 2-space format; left untouched so nothing else is reformatted");
  return { ok: true, keys };
}

const sectionOf = (keys, sc) => (isObj(keys[sc.section]) ? keys[sc.section] : null);

// Where else the same combo can mask Drover's binding. The sidebar (layout:drover) is masked by global, terminal, its own layout section and every mod:* section;
// the global shortcut ("from anywhere") by every other section: terminal, each layout:* and each mod:*.
const SCOPES = ["global", "terminal", "layout:drover"];
const scopesOf = (keys, sc) => (sc.section === "global" ? Object.keys(keys) : [...SCOPES, ...Object.keys(keys).filter((x) => x.startsWith("mod:"))]);

// The first place (any scope) that binds this combo to something other than Drover's binding, or null.
function clash(keys, sc) {
  for (const section of [sc.section, ...scopesOf(keys, sc).filter((x) => x !== sc.section)]) {
    const cur = isObj(keys[section]) ? keys[section][sc.key] : undefined;
    if (cur !== undefined && !same(cur, sc.binding)) return { section, cur };
  }
  return null;
}
const clashMessage = (sc, c) => `${sc.key} is already bound in keys.json (section ${c.section}) to ${show(c.cur)}; free that key first`;
const maskMessage = (sc, c) => `${sc.key} is also bound in section ${c.section} to ${show(c.cur)}, which takes over there`;

// -> { state: "on" | "off" | "conflict" | "invalid", installed, warning, message }
// installed: Drover's exact binding is in keys.json. warning: another section binds the combo to something else.
// on = installed (even if masked), conflict = not installed and the combo is taken, message = the text to show.
export function status(text, sc) {
  const p = parse(text);
  if (!p.ok) return { state: "invalid", installed: false, warning: "", message: p.error };
  const c = clash(p.keys, sc);
  const installed = same(sectionOf(p.keys, sc)?.[sc.key], sc.binding);
  if (installed) { const warning = c ? maskMessage(sc, c) : ""; return { state: "on", installed, warning, message: warning }; }
  if (c) return { state: "conflict", installed, warning: clashMessage(sc, c), message: clashMessage(sc, c) };
  return { state: "off", installed, warning: "", message: "" };
}

// -> { ok: true, text, changed } | { ok: false, error }
export function enable(text, sc) {
  const p = parse(text);
  if (!p.ok) return { ok: false, error: p.error };
  const sec = p.keys[sc.section];
  if (sec !== undefined && !isObj(sec)) return { ok: false, error: `keys.json section "${sc.section}" is not an object; left untouched` };
  if (same(sec?.[sc.key], sc.binding)) return { ok: true, text, changed: false };
  const c = clash(p.keys, sc);
  if (c) return { ok: false, error: clashMessage(sc, c) };
  p.keys[sc.section] = { ...(sec ?? {}), [sc.key]: sc.binding };
  return { ok: true, text: canonical(p.keys), changed: true };
}

export function disable(text, sc) {
  const p = parse(text);
  if (!p.ok) return { ok: false, error: p.error };
  const sec = sectionOf(p.keys, sc);
  const cur = sec?.[sc.key];
  if (cur === undefined) return { ok: true, text, changed: false };
  if (!same(cur, sc.binding)) return { ok: false, error: `${sc.key} is bound to ${show(cur)}, not Drover's binding; left alone` };
  delete sec[sc.key];
  return { ok: true, text: canonical(p.keys), changed: true };
}

// io: { read(): Promise<string|null>, write(path, text, expected), path, now(): string }.
// Backs the file up (<path>.bak-<now>) before the write; the write only lands if the file is still what was read.
export async function apply(io, sc, on) {
  let before;
  try { before = await io.read(); } catch (e) { return { ok: false, error: `Cannot read keys.json (${e?.message ?? e})` }; }
  const r = (on ? enable : disable)(before, sc);
  if (!r.ok || !r.changed) return r;
  try {
    await io.write(`${io.path}.bak-${io.now()}`, before, null);
    await io.write(io.path, r.text, before);
  } catch (e) {
    return { ok: false, error: `keys.json was not changed (${e?.message ?? e})` };
  }
  return r;
}
