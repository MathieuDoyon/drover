// Canonical copy lives in mods/_lib. Pure: the logic of the Export and Import dialogs (Squads screen).
// No fs, no exec. The dialogs hold state and call these; herd-export.js does the real work (format, scan, plan, apply).
import { exportHerd, plan, apply, shown } from "./herd-export.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SOUL = /^[a-z0-9-]{1,64}$/;
const WRITES = ["add", "copy", "overwrite"];
const CHOICES = ["add", "skip", "keep", "copy", "overwrite"];
const COPY_TRIES = 8; // a first guess only: settleFacts reads every id the plan really allocates
const MAX_CANDIDATES = 1000;
const MAX_PARSE = 2000000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// A name or id shown on screen: one that looks like a secret is hidden (the scan sees the same text).
export const labelOf = shown;

// ---- export

export function exportName(now) {
  return `drover-herdr-agents-${new Date(now).toISOString().slice(0, 10)}.json`;
}

export const allTicked = (cfg) => ({ agents: new Set(cfg.agents.map((a) => a.id)), squads: new Set(cfg.squads.map((s) => s.id)) });

// Agents a ticked squad needs: its leader and members. They stay in the export and cannot be unticked.
export function lockedAgents(cfg, sel) {
  const out = new Set();
  for (const s of cfg.squads) if (sel.squads.has(s.id)) for (const id of [s.leader, ...s.members.map((m) => m.agent)]) out.add(id);
  return out;
}

export function toggle(cfg, sel, kind, id) {
  const next = { agents: new Set(sel.agents), squads: new Set(sel.squads) };
  const set = kind === "squad" ? next.squads : next.agents;
  if (kind === "agent" && lockedAgents(cfg, sel).has(id)) return next;
  if (set.has(id)) set.delete(id); else set.add(id);
  return next;
}

const EXPORT_WARNING = {
  "home-path": "has a home folder path",
  "local-path": "names a local file that the export does not carry",
  "soul-missing": "its soul file is not here: exported without a soul",
};

// ctx: { souls: {name: sha256}, now, app }. ok: the file may be copied or saved. A blocked export has no file.
export function exportView(cfg, sel, ctx = {}) {
  const agents = [...new Set([...sel.agents, ...lockedAgents(cfg, sel)])];
  const r = exportHerd(cfg, { agents, squads: [...sel.squads], souls: ctx.souls, now: ctx.now, app: ctx.app, home: ctx.home });
  if (r.error) return { ok: false, message: r.error, blocked: [], warnings: [] };
  if (r.blocked) {
    const blocked = r.blocked.map((b) => `${labelOf(b.id)} · ${b.field} · ${b.rule}`);
    return { ok: false, blocked, warnings: [], message: `Blocked: ${plural(blocked.length, "problem")}. Edit the agent or squad, then export again.` };
  }
  const warnings = r.warnings.map((w) => `${labelOf(w.id)} · ${w.field}: ${EXPORT_WARNING[w.rule] ?? w.rule}`);
  return { ok: true, file: r.file, agents: r.agents, squads: r.squads, blocked: [], warnings, message: `No secret-shaped text found in ${plural(r.agents, "agent")} and ${plural(r.squads, "squad")}. The scan is best effort: review before sharing.` };
}

// ---- import

// The file text may be big or hostile; this only reads ids and soul names, with the same grammar as the core.
function listsOf(text) {
  if (typeof text !== "string" || text.length > MAX_PARSE) return { agents: [] };
  try {
    const d = JSON.parse(text);
    return { agents: isObj(d) && Array.isArray(d.agents) ? d.agents.filter(isObj) : [] };
  } catch { return { agents: [] }; }
}

// Agent ids whose <config>/agents/<id>.json the plan needs to know about.
export function candidateIds(cfg, text) {
  const mine = cfg.agents.map((a) => a.id);
  const have = new Set(mine);
  const out = [...mine];
  const add = (id) => { if (!have.has(id) && out.length < MAX_CANDIDATES) { have.add(id); out.push(id); } };
  const fileIds = listsOf(text).agents.map((a) => a.id).filter((id) => typeof id === "string" && ID.test(id));
  for (const id of fileIds) add(id);
  for (const id of fileIds) {
    if (!mine.includes(id)) continue;
    for (let n = 2; n < 2 + COPY_TRIES; n++) { const s = `-${n}`; add(id.slice(0, 64 - s.length) + s); }
  }
  return out;
}

// Agent ids the plan would write (add or copy): each needs its env file checked, whatever suffix the core picked.
const destinationIds = (p) => p.rows.filter((r) => r.kind === "agent" && (r.action === "add" || r.action === "copy") && r.item).map((r) => r.item.id);

// The facts for plan(): env files of the likely ids first, then of every id the plan actually allocates, until nothing new is allocated.
// base: { localSouls, supported }. readEnv(ids) -> Set of ids that have a file | { error }. A failed read gives the { error } shape.
export async function settleFacts(cfg, text, base, choices, readEnv) {
  const checked = new Set(candidateIds(cfg, text)), found = new Set();
  let r = await readEnv([...checked]);
  if (!(r instanceof Set)) return { ...base, envIds: r };
  r.forEach((id) => found.add(id));
  for (let round = 0; round < 30; round++) {
    const ctx = { ...base, envIds: new Set(found) };
    const p = plan(cfg, text, ctx, choices);
    if (!p.ok) return ctx;
    const need = destinationIds(p).filter((id) => !checked.has(id));
    if (!need.length) return ctx;
    need.forEach((id) => checked.add(id));
    r = await readEnv(need);
    if (!(r instanceof Set)) return { ...base, envIds: r };
    r.forEach((id) => found.add(id));
  }
  return { ...base, envIds: { error: "too many id clashes" } };
}

// Soul names that may need a local hash: those of the config and of the file.
export function soulNames(cfg, text) {
  const names = [...cfg.agents, ...listsOf(text).agents].map((a) => a.soul).filter((s) => typeof s === "string" && SOUL.test(s));
  return [...new Set(names)];
}

const BLOCK_TEXT = {
  "bad-id": () => "id is not valid",
  "bad-item": () => "not an agent or squad",
  "bad-field": (b) => `${b.field} is not valid`,
  "ref-missing": () => "names an agent that is neither in the file nor here",
  "ref-unavailable": () => "needs an agent that is blocked or not imported",
  secret: (b) => `${b.field} · ${b.rule}`,
};
const blockText = (b) => (BLOCK_TEXT[b.code] ? BLOCK_TEXT[b.code](b) : String(b.text ?? b.code));

// The actions a person may pick for a row. Identical rows and blocked rows have none.
export function rowOptions(row) {
  if (row.action === "blocked") return [];
  if (row.exists) return row.identical ? [] : [{ action: "keep", label: "Keep mine" }, { action: "copy", label: "Import as copy" }, { action: "overwrite", label: "Overwrite" }];
  return [{ action: "add", label: "Add" }, { action: "skip", label: "Skip" }];
}

// ui: { "<agent|squad>:<id>": { action, ackEnv, ackSoul } } -> the choices of plan().
export function toChoices(ui) {
  const out = {};
  if (!isObj(ui)) return out;
  for (const [key, v] of Object.entries(ui)) {
    if (!/^(agent|squad):/.test(key) || !isObj(v)) continue;
    const e = {};
    if (CHOICES.includes(v.action)) e.action = v.action;
    if (v.ackEnv === true) e.ackEnv = true;
    if (v.ackSoul === true) e.ackSoul = true;
    if (Object.keys(e).length) out[key] = e;
  }
  return out;
}

function viewRow(cfg, r, choices) {
  const kind = r.kind;
  const base = { key: r.key, kind, id: r.id, name: r.name, action: r.action, warnings: r.warnings.map((w) => w.text), blocked: r.blocked.map(blockText), acks: [] };
  if (r.action === "blocked") return { ...base, exists: false, identical: false, writes: false, options: [] };
  const it = r.item;
  const exists = cfg[kind === "agent" ? "agents" : "squads"].some((x) => x.id === it.id);
  const identical = exists && r.action === "skip";
  const detail = kind === "agent" ? { command: it.command, instructions: it.instructions, soul: it.soul ?? null } : { leader: it.leader, members: it.members.map((m) => ({ agent: m.agent, role: m.role })) };
  const c = choices[r.key] ?? {};
  const acks = [];
  if (kind === "agent" && WRITES.includes(r.action)) {
    if (r.warnings.some((w) => w.code === "soul-dropped")) acks.push({ kind: "soul", text: "No soul: only its instructions apply", ticked: c.ackSoul === true });
    if (r.action === "overwrite" && r.hasEnv) {
      const names = r.envNames?.length ? ` (names: ${r.envNames.join(", ")})` : "";
      acks.push({ kind: "env", text: `This agent keeps its environment${names}; the imported command and instructions will run with it`, ticked: c.ackEnv === true });
    }
  }
  const row = { ...base, ...detail, exists, identical, acks, newId: r.newId ?? null, writes: WRITES.includes(r.action) && acks.every((a) => a.ticked) };
  return { ...row, options: rowOptions(row) };
}

// ctx: { localSouls, envIds, supported }. ui: the person's picks. The plan object goes back to applyImport unchanged.
export function previewImport(cfg, text, ctx, ui) {
  const choices = toChoices(ui);
  const p = plan(cfg, text, ctx, choices);
  if (!p.ok) return { ok: false, plan: p, errors: p.errors, rows: [], warnings: [], canApply: false };
  const rows = p.rows.map((r) => viewRow(cfg, r, p.choices));
  return { ok: true, plan: p, errors: [], rows, warnings: p.warnings.map((w) => w.text), canApply: rows.some((r) => r.writes) };
}

const kindOf = (key) => (String(key).startsWith("squad:") ? "squad" : "agent");

// { config } to hand to one setShared, or { message } only (stale: true when the person must preview again).
export function applyImport(cfg, p, ctx) {
  const r = apply(cfg, p, ctx);
  if (r.error) return { message: r.error };
  if (r.stale) return { stale: true, message: "The agents or squads changed since the preview. Preview again." };
  const held = r.held.length ? ` ${plural(r.held.length, "row")} waiting for a tick ${r.held.length === 1 ? "was" : "were"} not applied.` : "";
  if (!r.applied.length) return { message: `Nothing to apply.${held}` };
  const count = (kind, actions) => r.applied.filter((a) => kindOf(a.key) === kind && actions.includes(a.action)).length;
  const part = (actions) => [["agent", count("agent", actions)], ["squad", count("squad", actions)]].filter(([, n]) => n).map(([k, n]) => plural(n, k)).join(" and ");
  const added = part(["add", "copy"]), over = part(["overwrite"]);
  const newAgents = count("agent", ["add", "copy"]) > 0;
  const message = [added && `Added ${added}.`, over && `Overwrote ${over}.`, newAgents && "Added agents start with no environment: set their variables in the agent editor.", held.trim()].filter(Boolean).join(" ");
  return { config: r.config, applied: r.applied, message };
}
