// Drover's two Herdr key bindings in the owner's keys.json. Pure (text in, text out), plus apply() which takes the file io.
// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// Safety: the file is only touched when it parses to an object AND is exactly JSON.stringify(parsed, null, 2) + "\n"
// (so rewriting it changes nothing but our one binding); a key bound to something else is never overridden.

export const SHORTCUTS = [
  { id: "sidebar", title: "Toggle the Drover sidebar", description: "Show or hide the Drover sidebar.", section: "layout:drover", key: "cmd-alt-b", binding: { command: "layout.toggle", args: { id: "drover" } } },
  { id: "newtask", title: "Create task", description: "Open the Create task dialog from anywhere.", section: "global", key: "cmd-shift-c", binding: "mod.open:drover-newtask" },
  // Opt-in only (the installer never writes keys.json). cmd-k, never ctrl-k: a global ctrl-k would steal readline's kill-line from every terminal pane.
  { id: "jump", title: "Jump to a card, run or project", description: "Open the Jump dialog from anywhere: type to filter, Enter goes there. Cmd+K (rebind to Ctrl+K by hand in keys.json if you accept it taking over kill-line in terminals).", section: "global", key: "cmd-k", binding: "mod.open:drover-jump" },
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
// Herdr's own bindings (keys(): [{ section, keys, action }], the effective list incl. defaults and the terminal section), injected so this file stays pure.
// undefined = the caller supplied none (pure use). null or a malformed list = the lookup failed: enabling is refused (the answer is unknown, not "free").
// A same-combo binding to another action in any section that would mask (or be masked by) Drover's is a clash. Its own binding is not.
const validBuiltin = (b) => Array.isArray(b) && b.every((x) => isObj(x) && typeof x.section === "string" && typeof x.keys === "string" && typeof x.action === "string");
const unavailable = (b) => b !== undefined && !validBuiltin(b);
const UNAVAILABLE = "Herdr's key bindings could not be read, so a clash cannot be ruled out; nothing was changed. Try again";
const masks = (sc, section) => section === sc.section || sc.section === "global" || SCOPES.includes(section) || String(section).startsWith("mod:");
// The ways the host may spell Drover's binding as an action string; an action matching none of them is NOT proven to be Drover's.
const spellings = (b) => {
  if (typeof b === "string") return [b];
  const out = [JSON.stringify(b)];
  if (isObj(b) && typeof b.command === "string") {
    const vals = isObj(b.args) ? Object.values(b.args) : [];
    out.push(vals.length === 0 ? b.command : vals.length === 1 ? `${b.command}:${vals[0]}` : b.command);
  }
  return out;
};
function builtinClash(sc, builtin, installed) {
  if (!validBuiltin(builtin)) return null;
  for (const b of builtin) {
    if (b.keys !== sc.key || !masks(sc, b.section)) continue;
    if (spellings(sc.binding).includes(b.action)) continue;
    if (installed && b.section === sc.section) continue; // Drover's own entry, spelled by the host in a way we cannot compare
    return { section: b.section, cur: b.action };
  }
  return null;
}
const clashMessage = (sc, c) => `${sc.key} is already bound in keys.json (section ${c.section}) to ${show(c.cur)}; free that key first`;
const builtinMessage = (sc, c) => `${sc.key} is already bound in Herdr (section ${c.section}) to ${show(c.cur)}; free that key first`;
const maskMessage = (sc, c) => `${sc.key} is also bound in section ${c.section} to ${show(c.cur)}, which takes over there`;

// -> { state: "on" | "off" | "conflict" | "invalid", installed, warning, message }
// installed: Drover's exact binding is in keys.json. warning: another section binds the combo to something else.
// on = installed (even if masked), conflict = not installed and the combo is taken, message = the text to show.
export function status(text, sc, builtin) {
  const p = parse(text);
  if (!p.ok) return { state: "invalid", installed: false, warning: "", message: p.error };
  const c = clash(p.keys, sc);
  const installed = same(sectionOf(p.keys, sc)?.[sc.key], sc.binding);
  const b = c ? null : builtinClash(sc, builtin, installed);
  if (installed) { const warning = c ? maskMessage(sc, c) : b ? maskMessage(sc, b) : ""; return { state: "on", installed, warning, message: warning }; }
  if (c) return { state: "conflict", installed, warning: clashMessage(sc, c), message: clashMessage(sc, c) };
  if (b) return { state: "conflict", installed, warning: builtinMessage(sc, b), message: builtinMessage(sc, b) };
  if (unavailable(builtin)) return { state: "unavailable", installed, warning: UNAVAILABLE, message: UNAVAILABLE };
  return { state: "off", installed, warning: "", message: "" };
}

// -> { ok: true, text, changed } | { ok: false, error }
export function enable(text, sc, builtin) {
  const p = parse(text);
  if (!p.ok) return { ok: false, error: p.error };
  const sec = p.keys[sc.section];
  if (sec !== undefined && !isObj(sec)) return { ok: false, error: `keys.json section "${sc.section}" is not an object; left untouched` };
  if (same(sec?.[sc.key], sc.binding)) return { ok: true, text, changed: false };
  const c = clash(p.keys, sc);
  if (c) return { ok: false, error: clashMessage(sc, c) };
  const b = builtinClash(sc, builtin, false);
  if (b) return { ok: false, error: builtinMessage(sc, b) };
  if (unavailable(builtin)) return { ok: false, error: UNAVAILABLE };
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

// builtin: the same keys() snapshot as status/enable; a clash refuses before the backup and the write.
// io: { read(): Promise<string|null>, write(path, text, expected), path, now(): string }.
// Backs the file up (<path>.bak-<now>) before the write; the write only lands if the file is still what was read.
export async function apply(io, sc, on, builtin) {
  let before;
  try { before = await io.read(); } catch (e) { return { ok: false, error: `Cannot read keys.json (${e?.message ?? e})` }; }
  const r = on ? enable(before, sc, builtin) : disable(before, sc);
  if (!r.ok || !r.changed) return r;
  try {
    await io.write(`${io.path}.bak-${io.now()}`, before, null);
    await io.write(io.path, r.text, before);
  } catch (e) {
    return { ok: false, error: `keys.json was not changed (${e?.message ?? e})` };
  }
  return r;
}
