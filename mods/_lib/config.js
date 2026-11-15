// Drover Config: sync cfg(mod, key) over three layers. No herdr import: the I/O is injected through bind(), so node --test runs this file.
// Canonical copy lives in mods/_lib; install.sh copies it (with config-schema.js) into each drover-* mod.
//
// Layers, first valid wins; an invalid or out-of-range value at a layer falls through to the next:
//   1. shared key "drover.config" { "<mod>": { "<key>": value } }  (the person's override, read live on each call)
//   2. the mod's mod.json `settings` block                          (only after ready(mod); modSettings() is async)
//   3. the schema default
// BEFORE READY (the mod.json cache not loaded yet, i.e. before setSettings/load(mod) resolved): cfg() skips layer 2 and
// returns the valid shared value, else the schema default. It never returns undefined for a known field.
// UNKNOWN mod/key: cfg() THROWS (a typo at a call site is a bug, not a silent default). The pure resolve() returns undefined.
// Wiring (each mod, in init): bind({ shared, modSettings }) once, then `cx.spawn(() => load("<mod>"))`.
import { field, validate } from "./config-schema.js";

export const KEY = "drover.config";

const own = (o, k) => o !== null && typeof o === "object" && Object.hasOwn(o, k);
const plain = (o) => (o !== null && typeof o === "object" && !Array.isArray(o) ? o : {});

// Pure core. resolve(shared, settings, mod, key) -> value, or undefined for an unknown field.
export function resolve(sharedObj, settingsObj, mod, key) {
  const f = field(mod, key);
  if (!f) return undefined;
  const layers = [own(plain(sharedObj)[mod], key) ? sharedObj[mod][key] : undefined, own(settingsObj, key) ? settingsObj[key] : undefined];
  for (const raw of layers) {
    if (raw === undefined) continue;
    const r = validate(f, typeof raw === "string" && own(f.alias, raw) ? f.alias[raw] : raw); // f.alias: a retired value that now reads as another
    if (r.ok) return r.value;
  }
  return f.default;
}

// ---- module cache + injected I/O ----
let reader = () => undefined;
let loader = async () => ({});
const cache = new Map(); // mod -> frozen-by-copy mod.json settings

export function setSharedReader(fn) { reader = typeof fn === "function" ? fn : () => undefined; }
export function setSettings(mod, obj) { cache.set(mod, { ...plain(obj) }); }
export const ready = (mod) => cache.has(mod);
export function resetCache() { cache.clear(); reader = () => undefined; loader = async () => ({}); }

// bind({ shared, modSettings }): shared(key) is herdr's sync shared(); modSettings(mod) is io.js's async one.
export function bind({ shared, modSettings }) {
  setSharedReader(typeof shared === "function" ? () => shared(KEY) : undefined);
  if (typeof modSettings === "function") loader = modSettings;
}

// Fill the mod.json layer. A failing read still marks the mod ready (empty layer).
export async function load(mod) {
  let obj = {};
  try { obj = await loader(mod); } catch { /* no mod.json settings: defaults apply */ }
  setSettings(mod, obj);
}

function sharedNow() {
  try { return reader(); } catch { return undefined; }
}

export function cfg(mod, key) {
  if (!field(mod, key)) throw new Error(`drover config: unknown setting ${mod}.${key}`);
  return resolve(sharedNow(), cache.get(mod), mod, key);
}

// The screen gate: is `mod` switched on in Drover Config? Sync and live (read from the shared key on each call, so a change in the
// dialog shows on the next render). A folder without an `enabled` field (drover-config, drover-tabs, drover-newtask) is always on.
// Off = SCREEN ONLY: the mod draws a stub and starts no work of its own; its data keys and the drover CLI are untouched.
// gate(mod): "on" | "off" | "loading". A valid shared override decides at once. Without one the answer waits for the mod's own mod.json
// layer (an inherited `enabled`): "loading" until ready(mod) (a missing or failing mod.json still becomes ready). While "loading" a screen
// renders a neutral view and starts nothing, so an inherited off never shows content or runs a request first.
export function gate(mod) {
  const f = field(mod, "enabled");
  if (!f) return "on";
  const s = sharedNow();
  if (own(plain(s)[mod], "enabled")) { const r = validate(f, s[mod].enabled); if (r.ok) return r.value ? "on" : "off"; }
  if (!ready(mod)) return "loading";
  return cfg(mod, "enabled") ? "on" : "off";
}
// Work gate: true only when the screen is decided ON (never while "loading").
export const isEnabled = (mod) => gate(mod) === "on";

// A screen's start-up: load its own mod.json settings (the layer under the shared override, which holds an inherited `enabled`),
// run `then` (the screen's ensureStarted), and repaint. Until it resolves isEnabled() answers from the shared key alone.
// `then(cx)` gets the spawned cx: an init cx is dead after an await, so a start-up must never keep one.
export function whenLoaded(mod, cx, then) {
  cx.spawn(async (cx) => { await load(mod); then?.(cx); cx.notify(); });
}

// ---- pure helpers for the dialog. Never mutate inputs. ----
export const isOverride = (sharedObj, mod, key) => own(plain(sharedObj)[mod], key);

// An override equal to the default is still stored (it then beats an inherited mod.json value). Throws on an unknown or invalid value.
export function setOverride(sharedObj, mod, key, value) {
  const f = field(mod, key);
  if (!f) throw new Error(`drover config: unknown setting ${mod}.${key}`);
  const r = validate(f, value);
  if (!r.ok) throw new Error(`drover config: ${mod}.${key}: ${r.error}`);
  const base = plain(sharedObj);
  return { ...base, [mod]: { ...plain(base[mod]), [key]: r.value } };
}

// Removes the override (back to inherited); never writes the default. Drops a mod object left empty.
export function resetOverride(sharedObj, mod, key) {
  const base = { ...plain(sharedObj) };
  if (!own(base[mod], key)) return base;
  const { [key]: _gone, ...rest } = base[mod];
  if (Object.keys(rest).length) base[mod] = rest;
  else delete base[mod];
  return base;
}
