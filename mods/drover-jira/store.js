// Canonical copy lives in mods/_lib. Herdr refuses imports from outside a mod folder,
// so mods/install.sh copies this file into each drover-* mod. Edit it here only.
// Pure: no herdr import, so `node --test mods/_lib` runs it.
import { parseSourceUrl } from "./sources.js";

export const KEY = "drover.tasks";
export const COLUMNS = [
  ["backlog", "Backlog"],
  ["todo", "Ready"],
  ["doing", "In progress"],
  ["review", "Review"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
const COLUMN_IDS = COLUMNS.map(([id]) => id);
// The CLI speaks the board's names: the label, lowercased, spaces to hyphens ("In progress" -> "in-progress"). Stored ids stay on the wire and in the data.
const squash = (v) => String(v).toLowerCase().replace(/[\s_-]+/g, "");
export const columnName = (id) => COLUMNS.find(([i]) => i === id)?.[1].toLowerCase().replace(/ /g, "-") ?? null;
// A column name, a label or a stored id (any case; "in progress", "in_progress", "doing", "todo" all work) -> the stored id, or null.
export const columnId = (input) => (typeof input === "string" && squash(input) ? COLUMNS.find(([id, label]) => squash(input) === squash(id) || squash(input) === squash(label))?.[0] ?? null : null);
const unknownColumn = (c) => `Unknown column ${c} (use ${COLUMN_IDS.map(columnName).join(", ")})`;
// Editor menus. tone = a theme color key (the editor maps it to a color).
export const PRIORITY_LABEL = { P0: "Urgent", P1: "High", P2: "Medium", P3: "Low" };
export const STATUS_ICON = {
  backlog: { icon: "◌", tone: "dim" },
  todo: { icon: "○", tone: "muted" },
  doing: { icon: "◐", tone: "working" },
  review: { icon: "◑", tone: "accent" },
  blocked: { icon: "⊘", tone: "blocked" },
  done: { icon: "●", tone: "done" },
};
export const nextIndex = (i, len, dir) => (len ? (dir === "down" ? (i + 1) % len : (i + len - 1) % len) % len : 0);
export const filterProjects = (projects, query) => {
  const q = String(query ?? "").trim().toLowerCase();
  return q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) : projects;
};

// Create modal: the Create button needs a non-blank title; Cmd+Enter submits (platform = Cmd on macOS).
export const canCreate = (title) => String(title ?? "").trim().length > 0;
export const isSubmitKey = (e) => e.key === "enter" && Boolean(e.modifiers?.platform);

// Labels chip: all tags in use, toggle one, and a new tag from the search text (null when blank, a comma, or already known).
export const allTags = (tasks) => [...new Set(tasks.flatMap((t) => t.tags ?? []))].sort();
export const toggleTag = (tags, tag) => (tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag]);
export const newTag = (text, known) => {
  const tag = String(text ?? "").trim().replace(/^#/, "").toLowerCase();
  return tag && !tag.includes(",") && !known.includes(tag) ? tag : null;
};

// Stable note ids "N-<hex>". Old notes get one from a hash of at+by+text (same result on every load; the drover script computes it
// the same way). The hash is cheap on purpose (the mod runtime's watchdog kills slow views): two FNV-1a 32-bit passes (seeds 0x811c9dc5 and
// 0x9e3779b9) over the UTF-8 bytes of "at\nby\ntext" -> 16 hex. A repeat of the same hash gets hash(<hash>#k) so ids stay distinct and stable.
// UTF-8 by hand: the runtime has no TextEncoder (see sources.js). Results are memoized by that key: list() runs on every render.
let hashCalls = 0;
export const noteHashCount = () => hashCalls;
const fnv = (s) => {
  hashCalls++;
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  const step = (c) => { h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 16777619) >>> 0; };
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) step(c);
    else if (c < 0x800) { step(0xc0 | (c >> 6)); step(0x80 | (c & 63)); }
    else if (c < 0x10000) { step(0xe0 | (c >> 12)); step(0x80 | ((c >> 6) & 63)); step(0x80 | (c & 63)); }
    else { step(0xf0 | (c >> 18)); step(0x80 | ((c >> 12) & 63)); step(0x80 | ((c >> 6) & 63)); step(0x80 | (c & 63)); }
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
};
const memo = new Map();
const hashOf = (s) => {
  let h = memo.get(s);
  if (h === undefined) { if (memo.size > 20000) memo.clear(); h = fnv(s); memo.set(s, h); }
  return h;
};
export const noteIds = (notes) => {
  const seen = new Set();
  return (Array.isArray(notes) ? notes : []).map((n) => {
    if (typeof n?.id === "string" && /^N-[0-9a-f]{6,}$/.test(n.id) && !seen.has(n.id)) { seen.add(n.id); return n; }
    let h = hashOf(`${n?.at}\n${n?.by ?? ""}\n${n?.text ?? ""}`), k = 0;
    while (seen.has("N-" + h)) h = hashOf(`${h}#${++k}`);
    const id = "N-" + h;
    seen.add(id);
    return { ...n, id };
  });
};
const withNoteIds = (t) => (Array.isArray(t.notes) && t.notes.some((n) => !/^N-[0-9a-f]{6,}$/.test(n?.id ?? "")) ? { ...t, notes: noteIds(t.notes) } : t);

export function freshNoteId(notes) {
  const used = new Set((notes ?? []).map((n) => n?.id));
  let id;
  do id = "N-" + Math.random().toString(16).slice(2, 8).padEnd(6, "0"); while (used.has(id));
  return id;
}

export const list = (raw) => (Array.isArray(raw) ? raw.filter((t) => t && typeof t.id === "string").map(withNoteIds) : []);

// A saved assignee is {kind: "agent"|"squad", id}; anything else is dropped (null).
export const normAssignee = (a) => (a && typeof a === "object" && (a.kind === "agent" || a.kind === "squad") && typeof a.id === "string" && a.id ? { kind: a.kind, id: a.id } : null);

export function validate(fields) {
  const title = String(fields.title ?? "").trim();
  if (!title) return { error: "Title is required" };
  if (title.length > 200) return { error: "Title is longer than 200 characters" };
  const rawTags = Array.isArray(fields.tags) ? fields.tags : String(fields.tags ?? "").split(",");
  const tags = [...new Set(rawTags.map((s) => String(s).trim().replace(/^#/, "").toLowerCase()).filter(Boolean))];
  return {
    value: {
      title,
      desc: String(fields.desc ?? "").trim(),
      priority: PRIORITIES.includes(fields.priority) ? fields.priority : "P2",
      tags,
      column: COLUMN_IDS.includes(fields.column) ? fields.column : "todo",
      project: typeof fields.project === "string" && fields.project ? fields.project : null,
      assignee: normAssignee(fields.assignee),
      ...("parent" in fields ? { parent: typeof fields.parent === "string" && fields.parent ? fields.parent : null } : {}),
    },
  };
}

const newId = (now) => "T-" + now.toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

export function add(tasks, fields, now = Date.now()) {
  const v = validate(fields);
  if (v.error) return v;
  const source = fields.source ? { kind: fields.source.kind, id: fields.source.id, url: fields.source.url } : null;
  const task = { id: newId(now), ...v.value, archived: false, agent: null, notes: [], source, created: now, updated: now };
  return { tasks: [...tasks, task], task };
}

// Protocol 3 field checks. STRICT: a value that is given is either valid or the whole request is refused; nothing is coerced
// (validate() would turn a bad priority into P2 and drop a bad assignee). Pure; the caller passes what it knows of this machine.
// ctx: { agents: [id], squads: [id] } of the machine that owns the card. Returns { value } or { error }.
const ids = (v) => (Array.isArray(v) ? v : []);
export function strictAssignee(a, ctx) {
  if (a === "none") return { value: null };
  if (!a || typeof a !== "object" || Array.isArray(a) || (a.kind !== "agent" && a.kind !== "squad") || typeof a.id !== "string" || !a.id)
    return { error: 'Bad assignee: give {"kind":"agent"|"squad","id":"…"} or "none"' };
  if (!ids(a.kind === "agent" ? ctx?.agents : ctx?.squads).includes(a.id)) return { error: `Unknown ${a.kind} ${a.id} for the assignee (see: drover squads)` };
  return { value: { kind: a.kind, id: a.id } };
}
export function strictPriority(p) {
  return PRIORITIES.includes(p) ? { value: p } : { error: `Bad priority ${typeof p === "string" ? p : JSON.stringify(p)}: use ${PRIORITIES.join(", ")}` };
}
// Tags replace the whole set. Same normal form as validate(): trimmed, no leading #, lower case, no duplicates.
export function strictTags(t) {
  if (!Array.isArray(t) || t.some((x) => typeof x !== "string")) return { error: "Bad tags: give a list of strings (it replaces all the tags)" };
  return { value: [...new Set(t.map((s) => s.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))] };
}
// A parent for card `id` that will sit in project `project`: it exists, is in the same project, and closes no cycle. "none" clears.
export function strictParent(tasks, id, parent, project) {
  if (parent === "none") return { value: null };
  if (typeof parent !== "string" || !parent) return { error: 'Bad parent: give a task id or "none"' };
  if (parent === id) return { error: "A task cannot be its own parent" };
  const p = tasks.find((t) => t.id === parent);
  if (!p) return { error: `Parent ${parent} not found` };
  if ((p.project ?? null) !== (project ?? null)) return { error: `Parent ${parent} is in another project` };
  const seen = new Set();
  for (let cur = p; cur && !seen.has(cur.id); cur = tasks.find((t) => t.id === cur.parent)) {
    if (cur.id === id) return { error: "That would make a parent cycle" };
    seen.add(cur.id);
  }
  return { value: parent };
}

// `drover add`: every field that is GIVEN is valid or nothing is added. The CLI sends null / "" for "none" and always a priority and a tags list.
export function addCommand(tasks, cmd, projectId, now, ctx) {
  const none = (v) => v === undefined || v === null || v === "";
  let priority = "P2", tags = [], parent = null, assignee = null;
  if (cmd.priority !== undefined && cmd.priority !== null) { const r = strictPriority(cmd.priority); if (r.error) return r; priority = r.value; }
  if (cmd.tags !== undefined && cmd.tags !== null) { const r = strictTags(cmd.tags); if (r.error) return r; tags = r.value; }
  if (!none(cmd.parent)) { const r = strictParent(tasks, null, cmd.parent, projectId); if (r.error) return r; parent = r.value; }
  if (cmd.assignee !== undefined && cmd.assignee !== null) { const r = strictAssignee(cmd.assignee, ctx); if (r.error) return r; assignee = r.value; }
  let column = "backlog";
  if (!none(cmd.column)) { column = columnId(cmd.column); if (!column) return { error: unknownColumn(cmd.column) }; }
  return add(tasks, { title: cmd.title, desc: cmd.desc ?? "", tags, column, priority, project: projectId, assignee, ...(parent ? { parent } : {}) }, now);
}

// One card per source item: "Add to Board" twice finds the first one.
// A card linked by hand (drover link) has the same url but not always the same id (Jira: host/KEY vs host/numeric), so the url matches too.
export const bySource = (tasks, kind, id, url) => tasks.find((t) => t.source?.kind === kind && (t.source.id === id || (url && t.source.url === url))) ?? null;

// A card back in backlog or todo has no run: its agent is dead or no longer works on it.
// A launch in flight (CLAIMING) stays: its run still adopts or expires the claim.
const unstaffed = (cur, to) => cur.column === "doing" && (to === "backlog" || to === "todo") && cur.agent !== CLAIMING;

// rev: a per-card change counter, never a clock. Every writer of a stored card bumps it by one, so a sender that names the rev it
// saw (inbox `ifRev`) can tell the card changed. A card with no rev (older data, or just added) counts as 0.
export const revOf = (t) => (Number.isSafeInteger(t?.rev) && t.rev > 0 ? t.rev : 0);
const bumped = (t) => ({ ...t, rev: revOf(t) + 1 });

export function update(tasks, id, patch, now = Date.now()) {
  const cur = tasks.find((t) => t.id === id);
  if (!cur) return { error: `Task ${id} not found` };
  const v = validate({ ...cur, ...patch });
  if (v.error) return v;
  const task = { ...cur, ...patch, ...v.value, id: cur.id, updated: now, rev: revOf(cur) + 1 };
  if (unstaffed(cur, task.column) && !("agent" in patch)) Object.assign(task, { agent: null, run: null, claimedAt: null });
  if (task.column !== cur.column) delete task.order; // the old column's number means nothing in the new one
  return { tasks: tasks.map((t) => (t.id === id ? task : t)), task };
}

// Edit Save: writes ONLY title and desc, against the stored task. Priority, tags, column, assignee, project are never touched here.
export function saveText(tasks, id, { title, desc }, now = Date.now()) {
  if (!tasks.some((t) => t.id === id)) return { error: `Task ${id} not found` };
  return update(tasks, id, { title, desc: desc ?? "" }, now);
}

// Property edits that save at once: one field, patched onto the stored task. "status" is the column.
// Why a note was written: the badge on the card. A note without a kind is a plain note.
export const NOTE_KINDS = ["decision", "log", "blocker", "pr", "handoff"];

const PATCH_FIELDS = { title: "title", desc: "desc", status: "column", priority: "priority", assignee: "assignee", project: "project", tags: "tags", parent: "parent" };
export function patchField(tasks, id, field, value, now = Date.now()) {
  const key = PATCH_FIELDS[field];
  if (!key) return { error: `Cannot patch ${field}` };
  if (key === "parent") return setParent(tasks, id, value, now);
  return update(tasks, id, { [key]: value }, now);
}

// Local parent: one optional task id. An archived parent stays valid; a deleted one leaves a dangling id that parentOf reads as none.
export function setParent(tasks, id, parentId, now = Date.now()) {
  if (!tasks.some((t) => t.id === id)) return { error: `Task ${id} not found` };
  if (parentId == null || parentId === "") return update(tasks, id, { parent: null }, now);
  if (parentId === id) return { error: "A task cannot be its own parent" };
  if (!tasks.some((t) => t.id === parentId)) return { error: `Parent ${parentId} not found` };
  const seen = new Set();
  for (let cur = tasks.find((t) => t.id === parentId); cur && !seen.has(cur.id); cur = tasks.find((t) => t.id === cur.parent)) {
    if (cur.id === id) return { error: "That would make a parent cycle" };
    seen.add(cur.id);
  }
  return update(tasks, id, { parent: parentId }, now);
}
export const parentOf = (tasks, task) => (task?.parent ? tasks.find((t) => t.id === task.parent) ?? null : null);
// Tasks that may become id's parent: not itself, not archived, not one of its descendants (those would close a cycle).
export const parentChoices = (tasks, id) => tasks.filter((t) => t.id !== id && !t.archived && !setParent(tasks, id, t.id).error);
// True when the editor's title, description or unsent note differ from the stored task (text compared trimmed, as Save stores it).
export const hasUnsaved = (stored, { title, desc, note }) =>
  String(title ?? "").trim() !== String(stored?.title ?? "").trim() || String(desc ?? "").trim() !== String(stored?.desc ?? "").trim() || String(note ?? "").trim() !== "";
// The Parent menu's search box: a task's title or id contains the query.
export const filterParents = (tasks, query) => {
  const q = String(query ?? "").trim().toLowerCase();
  return q ? tasks.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)) : tasks;
};
// A parent's short label: GitHub cards start with "owner/repo", which makes every row read alike. Strip it ("owner/repo#21 Parent issue" -> "#21 Parent issue").
export const parentLabel = (task) => {
  const title = String(task?.title ?? "");
  return title.replace(/^[\w.-]+\/[\w.-]+(?=#\d)/, "");
};
export const childrenOf = (tasks, id) => tasks.filter((t) => t.parent === id);

export function shift(tasks, id, step, now) {
  const cur = tasks.find((t) => t.id === id);
  const i = COLUMN_IDS.indexOf(cur?.column) + step;
  if (!cur || i < 0 || i >= COLUMN_IDS.length) return { error: "No column there" };
  return update(tasks, id, { column: COLUMN_IDS[i] }, now);
}

// Words all must match: "#tag" a tag prefix, "p0".."p3" a priority, else text in title/desc/id.
export function matches(task, query) {
  return String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean).every((w) => {
    if (w.startsWith("#")) return task.tags.some((tag) => tag.startsWith(w.slice(1)));
    if (/^p[0-3]$/.test(w)) return task.priority === w.toUpperCase();
    return `${task.id} ${task.title} ${task.desc}`.toLowerCase().includes(w);
  });
}

// Dragged cards carry `order` and come first. Cards without it (old or new) follow, by priority then age.
const rank = (t) => (typeof t.order === "number" ? t.order : Infinity);
export const sorted = (tasks) =>
  [...tasks].sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1) || a.priority.localeCompare(b.priority) || a.created - b.created);

// Drop a card into a column, before the card beforeId (null: at the end). Renumbers that column.
// Uses every card of the column, not only the filtered ones the board shows.
// shift() for a board that hides columns: the card moves to the nearest VISIBLE column in that direction. A hidden column is never a
// landing spot (the card would vanish from the screen); with none left that way it is an error and the card stays where it is.
export function shiftVisible(tasks, id, step, visible, now) {
  const cur = tasks.find((t) => t.id === id);
  let i = COLUMN_IDS.indexOf(cur?.column) + step;
  while (i >= 0 && i < COLUMN_IDS.length && !visible.includes(COLUMN_IDS[i])) i += step;
  if (!cur || i < 0 || i >= COLUMN_IDS.length) return { error: "No column there" };
  return update(tasks, id, { column: COLUMN_IDS[i] }, now);
}

export function reorder(tasks, id, column, beforeId, now = Date.now()) {
  const cur = tasks.find((t) => t.id === id);
  if (!cur) return { error: `Task ${id} not found` };
  if (!COLUMN_IDS.includes(column)) return { error: `Unknown column ${column}` };
  const rest = sorted(tasks.filter((t) => t.column === column && !t.archived && t.id !== id));
  const at = rest.findIndex((t) => t.id === beforeId);
  rest.splice(at < 0 ? rest.length : at, 0, cur);
  const order = new Map(rest.map((t, i) => [t.id, i]));
  const next = tasks.map((t) => {
    if (!order.has(t.id)) return t;
    const moved = t.id === id;
    if (!moved && t.order === order.get(t.id)) return t;
    return { ...bumped(t), order: order.get(t.id), ...(moved ? { column, updated: now, ...(unstaffed(t, column) ? { agent: null, run: null, claimedAt: null } : {}) } : {}) };
  });
  return { tasks: next, task: next.find((t) => t.id === id) };
}

// Where a task sits in the Tasks panel. An agent that stops is not proof of a result:
// only the Review column means "ready for review"; a stopped or lost agent needs you.
export function attention(task, agentsByAddress) {
  if (task.archived || task.column === "done") return null;
  if (task.column === "blocked") return { group: "needs", reason: "Blocked" };
  if (task.column === "review") return { group: "review", reason: "Ready for review" };
  if (task.agent === CLAIMING) return { group: "working", reason: "Agent is starting" };
  if (task.agent) {
    const a = agentsByAddress.get(task.agent);
    if (!a) return { group: "needs", reason: `Agent ${task.agent} is gone` };
    if (a.status === "blocked") return { group: "needs", reason: "Agent is blocked" };
    if (a.status === "working") return { group: "working", reason: "Agent is working" };
    return { group: "needs", reason: "Agent stopped: check the result" };
  }
  if (task.column === "doing") return { group: "working", reason: "In progress" };
  return { group: "todo", reason: null };
}

export const GROUPS = [
  ["needs", "Needs you"],
  ["review", "Ready for review"],
  ["working", "Working"],
  ["todo", "Ready"],
];

// A request from outside (the `drover` script an agent runs). Only known ops and fields.
export function applyCommand(tasks, cmd, now, ctx) {
  if (typeof cmd?.id !== "string") return { error: "Unknown drover command" };
  if (cmd.op === "archive") return update(tasks, cmd.id, { archived: true }, now);
  if (cmd.op === "note") {
    const kind = cmd.kind == null || cmd.kind === "" ? null : cmd.kind;
    if (kind && !NOTE_KINDS.includes(kind)) return { error: `Unknown note kind ${kind}: use ${NOTE_KINDS.join(", ")}` };
    const text = String(cmd.text ?? "").trim();
    const cur = tasks.find((t) => t.id === cmd.id);
    if (!text) return { error: "Note is empty" };
    if (!cur) return { error: `Task ${cmd.id} not found` };
    const by = String(cmd.by ?? "").trim() || "you";
    return update(tasks, cmd.id, { notes: [...(cur.notes ?? []), { id: freshNoteId(cur.notes), at: now ?? Date.now(), by, text, ...(kind ? { kind } : {}) }] }, now);
  }
  if (cmd.op === "note-edit" || cmd.op === "note-rm") {
    const cur = tasks.find((t) => t.id === cmd.id);
    if (!cur) return { error: `Task ${cmd.id} not found` };
    const notes = noteIds(cur.notes);
    if (!notes.some((n) => n.id === cmd.noteId)) return { error: `Note ${cmd.noteId} not found on ${cmd.id}` };
    if (cmd.op === "note-rm") return update(tasks, cmd.id, { notes: notes.filter((n) => n.id !== cmd.noteId) }, now);
    const text = String(cmd.text ?? "").trim();
    if (!text) return { error: "Note is empty" };
    return update(tasks, cmd.id, { notes: notes.map((n) => (n.id === cmd.noteId ? { ...n, text, edited: cmd.now ?? now ?? Date.now() } : n)) }, now);
  }
  if (cmd.op === "edit") { // protocol 3: title, desc, priority, tags, assignee, parent, project in ONE update (one rev bump); omitted = untouched
    const cur = tasks.find((t) => t.id === cmd.id);
    if (!cur) return { error: `Task ${cmd.id} not found` };
    const patch = Object.fromEntries(["title", "desc"].filter((k) => typeof cmd[k] === "string").map((k) => [k, cmd[k]]));
    const given = (k) => cmd[k] !== undefined;
    if (given("priority")) { const r = strictPriority(cmd.priority); if (r.error) return r; patch.priority = r.value; }
    if (given("tags")) { const r = strictTags(cmd.tags); if (r.error) return r; patch.tags = r.value; }
    if (given("assignee")) { const r = strictAssignee(cmd.assignee, ctx); if (r.error) return r; patch.assignee = r.value; }
    if (given("project")) { // the caller resolved the name to an id (or null) and checked who owns it
      if (cmd.project !== null && typeof cmd.project !== "string") return { error: "Bad project: give a project id, name or none" };
      patch.project = cmd.project;
    }
    if ("project" in patch && (patch.project ?? null) !== (cur.project ?? null)) { // a move may not leave a parent/child pair in two projects
      const parentCard = !given("parent") && cur.parent ? tasks.find((t) => t.id === cur.parent) : null; // a given parent is checked below against the new project
      if (parentCard && (parentCard.project ?? null) !== (patch.project ?? null)) return { error: `${cmd.id} has parent ${parentCard.id} in another project: detach parent/children first (or send parent "none" with the move)` };
      const kid = tasks.find((t) => t.parent === cmd.id && (t.project ?? null) !== (patch.project ?? null));
      if (kid) return { error: `${cmd.id} has child ${kid.id}: detach parent/children first` };
    }
    if (given("parent")) { const r = strictParent(tasks, cmd.id, cmd.parent, "project" in patch ? patch.project : cur.project); if (r.error) return r; patch.parent = r.value; }
    if (!Object.keys(patch).length) return { error: "Nothing to edit: give a title, a description, a priority, tags, an assignee, a parent or a project" };
    return update(tasks, cmd.id, patch, now);
  }
  if (cmd.op === "link") { // `drover link <T-…> <url|none>`: set or clear the source, like an import
    const cur = tasks.find((t) => t.id === cmd.id);
    if (!cur) return { error: `Task ${cmd.id} not found` };
    const by = String(cmd.by ?? "").trim() || "you";
    const noteOf = (text) => [...(cur.notes ?? []), { id: freshNoteId(cur.notes), at: now ?? Date.now(), by, text, kind: "log" }];
    if (String(cmd.url ?? "").trim() === "none") {
      if (!cur.source) return { error: `${cmd.id} has no linked issue` };
      return update(tasks, cmd.id, { source: null, notes: noteOf(`unlinked ${cur.source.url}`) }, now);
    }
    const src = parseSourceUrl(cmd.url);
    if (!src) return { error: "Not an issue link: use a GitHub issue/PR URL or a Jira browse URL (https://site/browse/KEY)" };
    if (src.kind === "jira") { // the card reads the issue on the configured site only: refuse another host before any request
      if (!cmd.jiraSite) return { error: "Set the Jira site in Drover Config before linking a Jira issue" };
      if (src.id.split("/")[0].toLowerCase() !== String(cmd.jiraSite).toLowerCase()) return { error: `Jira link is on ${src.id.split("/")[0]}, not the configured site ${cmd.jiraSite}` };
    }
    const other = tasks.find((t) => t.id !== cmd.id && t.source?.url === src.url);
    if (other) return { error: `${src.url} is already linked to ${other.id}` };
    return update(tasks, cmd.id, { source: src, notes: noteOf(`linked ${src.url}`) }, now);
  }
  if (cmd.op === "project") return update(tasks, cmd.id, { project: cmd.project ?? null }, now); // the caller resolved the name to an id
  if (cmd.op !== "move") return { error: "Unknown drover command" };
  const column = columnId(cmd.column);
  if (!column) return { error: unknownColumn(cmd.column) };
  if (column === "done" && cmd.from && !cmd.fromDrover) return { error: "Only the owner moves a card to done: tell the owner" }; // from = an agent's terminal; fromDrover = io.js checked it is a live Drover
  return update(tasks, cmd.id, { column }, now);
}

// Queue mode: a Drover takes Ready cards (column todo) of its own project.
// Skip reasons are for cards the owner may fix. Cards of other projects are not listed.
export function queue(tasks, projectId, projects = []) {
  const picks = [], skips = [];
  for (const t of sorted(tasks.filter((x) => x.column === "todo" && !x.archived))) {
    const why = !t.project ? "no project" : t.project !== projectId ? null : t.agent ? "has an agent" : !repoOf(t, projects) ? "no repo" : "";
    if (why === "") picks.push(t);
    else if (why) skips.push({ task: t, reason: why });
  }
  return { picks, skips };
}

// A suggestion: the Drover reads the card and may choose another squad.
export function squadFor(task) {
  const tags = task.tags ?? [];
  if (tags.includes("bug") || tags.includes("fix")) return "stray";
  if (tags.includes("spike") || tags.includes("scope") || !String(task.desc ?? "").trim()) return "scouting";
  return "cattle-drive";
}

// The reply to `drover next`: free slots, then one line per card to start (at most the slots), then skip reasons.
export function nextReport(tasks, projects, projectId, slots) {
  const head = `ok: ${slots} slots`;
  if (slots <= 0) return head;
  const q = queue(tasks, projectId, projects);
  return [head, ...q.picks.slice(0, slots).map((t) => `${t.id} ${t.priority} squad=${squadFor(t)} ${t.title}`),
    ...q.skips.map((s) => `skip ${s.task.id} ${s.reason}`)].join("\n");
}

// Claim before any await: card to doing with agent "claiming" in one step, so a 2nd start sees it.
// prev is what release() restores if the launch fails.
export const CLAIMING = "claiming";
// alive: Set of live terminal addresses. An agent that is gone no longer owns the card (manual restart).
export function claim(tasks, id, projectId, now, alive) {
  const cur = tasks.find((t) => t.id === id);
  if (!cur || cur.archived) return { error: `Task ${id} not found` };
  if (cur.agent === CLAIMING) return { error: `${id} is already starting` };
  if (cur.agent && (!alive || alive.has(cur.agent))) return { error: `${id} already has agent ${cur.agent}` };
  if (projectId !== undefined) { // queue mode; a manual start (undefined) may take a card from any column
    if (cur.column !== "todo") return { error: `${id} is not Ready (it is in ${columnName(cur.column)})` };
    if (cur.project !== projectId) return { error: `${id} is not in this project` };
  }
  const r = update(tasks, id, { column: "doing", agent: CLAIMING, claimedAt: now ?? Date.now() }, now);
  return r.error ? r : { ...r, prev: { column: cur.column, order: cur.order } };
}

// A launch failed: clear the claim. Put the column back only if the owner did not move the card meanwhile.
export function release(tasks, id, prev, now) {
  const cur = tasks.find((t) => t.id === id);
  if (!cur || cur.agent !== CLAIMING) return { tasks };
  if (cur.column !== "doing" || cur.archived) return update(tasks, id, { agent: null, claimedAt: null }, now);
  const r = update(tasks, id, { column: prev.column, agent: null, claimedAt: null }, now);
  if (typeof prev.order !== "number") return r;
  const next = r.tasks.map((t) => (t.id === id ? { ...t, order: prev.order } : t));
  return { tasks: next, task: next.find((t) => t.id === id) };
}

// A pasted image: a unique file name, and the markdown line that points at the saved file.
export const imageName = (now) => `img-${now}-${Math.random().toString(36).slice(2, 7)}.png`;
export const appendImage = (desc, path) => `${desc}${desc && !desc.endsWith("\n") ? "\n" : ""}![image](<${path}>)`;
// Image paths in a description. The host image() resolves against the app home, so a path under it is made relative.
export const imageLines = (desc, home) => [...desc.matchAll(/!\[[^\]]*\]\(<([^>]+)>\)/g)].map((m) => (m[1].startsWith(`${home}/`) ? m[1].slice(home.length + 1) : m[1]));
// Files this editor session pasted that no saved description links. descs: every saved task's description, archived too.
// Only session files are listed: never scan the folder.
// Paths compare the way image() resolves them (imageLines): absolute under home and home-relative are the same file.
export const staleImages = (pasted, descs, home) => {
  const linked = new Set(descs.flatMap((d) => imageLines(d, home)));
  return pasted.filter((f) => !linked.has(imageLines(appendImage("", f), home)[0]));
};

// Inbox: every open mod may read the same request file. The shared "seen" list (file names) makes
// each request apply once, like the old wake check but for all ops. Keeps the last 200 names.
export const SEEN_KEY = "drover.inbox-seen";
export function firstSight(seen, name) {
  const list = Array.isArray(seen) ? seen : [];
  return list.includes(name) ? { fresh: false, seen: list } : { fresh: true, seen: [...list, name].slice(-200) };
}

// ---- Inbox protocol 2 (T-MWHVWQW21AG). Optional fields on a request:
//   ifRev  the card rev the sender saw; the request is refused (`stale`) when the card is at another rev.
//   ttlMs  the request is dropped (`expired`) when it arrived more than ttlMs ago.
// An OLD consumer ignores both fields and applies the request unconditionally. A sender must therefore send `{op:"protocol"}` first
// and use these fields only when the answer is `ok: protocol 2` (an old consumer answers `error: Unknown drover command`).
export const PROTOCOL = 4; // 4 = 3 + ops agents-import (dry run + plan token + confirm) and agents-export (T-MWJHXZ6Q72Q); 3 = 2 + edit takes priority/tags/assignee/parent/project and add takes assignee (T-MWIA1D6HO84)
const REV_OPS = ["move", "edit", "note", "note-edit", "note-rm", "archive", "link", "project"]; // ops that name one card
const whole = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
// Pure. { ifRev, ttlMs } (each undefined when absent) or { error: "bad …" }.
export function protocolFields(cmd) {
  const out = {};
  for (const f of ["ifRev", "ttlMs"]) {
    if (cmd?.[f] === undefined) continue;
    if (!whole(cmd[f])) return { error: `bad ${f}: ${typeof cmd[f] === "number" ? cmd[f] : JSON.stringify(cmd[f])} is not a whole number of 0 or more` };
    if (f === "ifRev" && !REV_OPS.includes(cmd.op)) return { error: `bad ifRev: not supported for ${cmd.op}` };
    out[f] = cmd[f];
  }
  return out;
}
// When a request file arrived, in ms: the file's mtime (seconds), else the epoch seconds a CLI file name starts with (`<epoch>-<pid>`).
// Never the first time a mod saw it and never a time inside the body. null when neither exists.
export function arrivalOf(name, mtimeS) {
  if (Number.isFinite(mtimeS)) return mtimeS * 1000;
  const m = /^(\d{9,11})-/.exec(name);
  return m ? Number(m[1]) * 1000 : null;
}
// Pure and synchronous: the caller runs it and applies in the same turn (no await between). null = go on, else { error }.
// Order: bad, expired, stale. `arrival` is arrivalOf(...). Clock skew: arrival is the file host's clock and `now` is this host's; the
// consumer and the file's disk are the same machine in practice, so the age is one clock, but a wrong clock there skews the TTL.
export function inboxGate(cmd, tasks, { arrival, now }) {
  const f = protocolFields(cmd);
  if (f.error) return f;
  if (f.ttlMs !== undefined) {
    if (arrival == null) return { error: "no arrival time: the file has no mtime and no epoch in its name; not applied" };
    if (now - arrival > f.ttlMs) return { error: `expired: arrived ${Math.round((now - arrival) / 1000)}s ago, ttl ${f.ttlMs}ms; not applied` };
  }
  if (f.ifRev !== undefined) {
    const cur = tasks.find((t) => t.id === cmd.id);
    if (cur && revOf(cur) !== f.ifRev) return { error: `stale: card ${cmd.id} is at rev ${revOf(cur)}, request saw ${f.ifRev}${cur.rev === undefined ? " (card has no rev, counts as 0)" : ""}` };
  }
  return null;
}

// Projects: a name, its repos (first = default), loose folders and the base branch. Shared key drover.projects.
export const PROJECTS_KEY = "drover.projects";
const lines = (v) => (Array.isArray(v) ? v : String(v ?? "").split("\n")).map((x) => String(x?.path ?? x).trim()).filter(Boolean);
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function validateProject(projects, fields, selfId) {
  const name = String(fields.name ?? "").trim();
  if (!name) return { error: "Name is required" };
  if (projects.some((p) => p.id !== selfId && sameName(p.name, name))) return { error: `A project named ${name} exists` };
  const repos = [...new Set(lines(fields.repos))].map((path, i) => (i ? { path } : { path, default: true }));
  return { value: { name, repos, folders: [...new Set(lines(fields.folders))], branch: String(fields.branch ?? "").trim() || "main" } };
}

export function addProject(projects, fields, now = Date.now()) {
  const v = validateProject(projects, fields);
  if (v.error) return v;
  const project = { id: "P-" + now.toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(), ...v.value, created: now };
  return { projects: [...projects, project], project };
}

// Inbox op project-add: the shape of the request (no Git here). Returns { error } or { value: { name, repo, branch, folders } };
// branch "" means omitted (the consumer resolves it from the repo). A path is absolute with no newline/NUL/edge space, at most 4096 chars.
const PATH_MAX = 4096, FOLDERS_MAX = 20, NAME_MAX = 200;
const badText = (s) => /[\0\r\n]/.test(s);
const goodPath = (p) => typeof p === "string" && p.startsWith("/") && p.length <= PATH_MAX && !badText(p) && p === p.trim();
export function projectAddRequest(cmd) {
  const name = typeof cmd?.name === "string" && !badText(cmd.name) ? cmd.name.trim() : ""; // a line break is refused before trim, never trimmed away
  if (!name || name.length > NAME_MAX) return { error: `Name must be 1-${NAME_MAX} characters with no line break` };
  if (!goodPath(cmd.repo)) return { error: `repo must be an absolute path (at most ${PATH_MAX} characters, no line break)` };
  const raw = cmd.folders ?? [];
  if (!Array.isArray(raw) || raw.length > FOLDERS_MAX) return { error: `folders must be a list of at most ${FOLDERS_MAX} absolute paths` };
  if (!raw.every(goodPath)) return { error: `every folder must be an absolute path (at most ${PATH_MAX} characters, no line break)` };
  const branch = cmd.branch == null ? "" : cmd.branch;
  if (typeof branch !== "string" || badText(branch) || branch.startsWith("-") || branch !== branch.trim()) return { error: "branch is not a valid branch name" };
  return { value: { name, repo: cmd.repo, branch, folders: [...new Set(raw)] } };
}

// Which fields of an existing project differ from a normalized request (branch already resolved). [] = the same request.
export function projectDiff(project, req) {
  const diff = [];
  if (project.repos.length !== 1 || project.repos[0].path !== req.repo) diff.push("repo");
  if (project.branch !== req.branch) diff.push("branch");
  const a = [...project.folders].sort(), b = [...req.folders].sort();
  if (a.length !== b.length || a.some((f, i) => f !== b[i])) diff.push("folders");
  return diff;
}

export function updateProject(projects, id, fields) {
  const cur = projects.find((p) => p.id === id);
  if (!cur) return { error: `Project ${id} not found` };
  const v = validateProject(projects, { ...cur, ...fields }, id);
  if (v.error) return v;
  const project = { ...cur, ...v.value };
  return { projects: projects.map((p) => (p.id === id ? project : p)), project };
}

// Refuses while a task uses the project: the owner moves those tasks first.
export function removeProject(projects, tasks, id) {
  const n = tasks.filter((t) => t.project === id).length;
  if (n) return { error: `${n} task${n > 1 ? "s use" : " uses"} this project: move ${n > 1 ? "them" : "it"} first` };
  return { projects: projects.filter((p) => p.id !== id) };
}

export const projectNamed = (projects, name) => projects.find((p) => sameName(p.name, name)) ?? null; // by name only: a name that looks like an id is still a name
export const findProject = (projects, key) => projects.find((p) => p.id === key) ?? projects.find((p) => sameName(p.name, String(key ?? ""))) ?? null;
export const projectOf = (task, projects) => (task?.project ? projects.find((p) => p.id === task.project) ?? null : null);
export const repoOf = (task, projects) => {
  const repos = projectOf(task, projects)?.repos ?? [];
  return (repos.find((r) => r.default) ?? repos[0])?.path ?? null;
};
// CLI/inbox: "" or "none" clears, an id or name picks. Unknown is an error, never a silent null.
export function projectKey(projects, key) {
  if (key == null || key === "" || String(key).toLowerCase() === "none") return { id: null };
  const p = findProject(projects, key);
  return p ? { id: p.id } : { error: `no project ${key} (see: drover projects)` };
}

// Assignee choices for the create modal: squads, then agents. Names match the ▶ picker.
export function runnerChoices(cfg) {
  const name = (id) => cfg.agents.find((a) => a.id === id)?.name ?? id;
  return [
    ...cfg.squads.map((s) => ({ kind: "squad", id: s.id, name: s.name, detail: [s.leader, ...s.members.map((m) => m.agent)].map(name).join(" + ") })),
    ...cfg.agents.map((a) => ({ kind: "agent", id: a.id, name: a.name, detail: a.command })),
  ];
}
// The coordinator identity (drover) never runs a one-shot create: it would pass for the coordinator.
export const agentChoices = (cfg) => runnerChoices(cfg).filter((c) => c.kind === "agent" && c.id !== "drover");
export const canCreateAgent = (prompt) => String(prompt ?? "").trim().length > 0;
export const startHint = (name) => `${name} will start working right after creation.`;

// Create modal size: the overlay size is fixed at open, so expand = reopen. Large is a share (0..1) of the window.
export const createSize = (large) => (large ? { width: 0.9, height: 0.85 } : { width: 720, height: 520 });

// Edit dialog size: same shell as create.
export const editSize = createSize;

// The create draft as overlay props (JSON-safe, known keys only), and back with defaults. Bad input gives no draft or default fields.
const DRAFT_KEYS = ["mode", "title", "desc", "prompt", "column", "priority", "labels", "assignee", "runner", "project", "another", "pasted", "note", "parent"];
export const packDraft = (f) => Object.fromEntries(DRAFT_KEYS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));
export function unpackDraft(d) {
  if (!d || typeof d !== "object") return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const out = {
    mode: d.mode === "agent" ? "agent" : "manual", title: str(d.title), desc: str(d.desc), prompt: str(d.prompt),
    labels: strs(d.labels), pasted: strs(d.pasted), another: d.another === true, note: str(d.note),
    assignee: d.assignee && typeof d.assignee.kind === "string" && typeof d.assignee.id === "string" ? { kind: d.assignee.kind, id: d.assignee.id } : null,
  };
  for (const k of ["column", "priority", "runner", "project"]) if (typeof d[k] === "string") out[k] = d[k];
  if (typeof d.parent === "string" && d.parent) out.parent = d.parent; // only an omarchy card's draft uses it (a local create takes its parent from the props)
  return out;
}

// "Updated 15h ago": relative age of a card for the board footer. Empty when there is no timestamp.
export function updatedAgo(updated, now = Date.now()) {
  if (typeof updated !== "number") return "";
  const s = Math.max(0, Math.floor((now - updated) / 1000));
  if (s < 60) return "Updated just now";
  if (s < 3600) return `Updated ${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `Updated ${Math.floor(s / 3600)}h ago`;
  return `Updated ${Math.floor(s / 86400)}d ago`;
}

// gpui-kit has no line_clamp: cut a title to `max` chars (at a word when one fits) and add an ellipsis.
export function clampText(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

// Column menu: view-only sort of one column's cards. "manual" is the board order; unknown modes fall back to it.
export const SORT_MODES = [["manual", "Manual"], ["priority", "Priority"], ["newest", "Newest"]];
export function sortCards(cards, mode) {
  if (mode === "priority") return [...cards].sort((a, b) => a.priority.localeCompare(b.priority) || a.created - b.created);
  if (mode === "newest") return [...cards].sort((a, b) => b.created - a.created);
  return sorted(cards);
}

// "Archive all" in the Done column: touches only done cards that are not archived yet.
// `ids` (optional): only those cards, so a confirm archives exactly the cards its count showed.
export function archiveDone(tasks, now = Date.now(), ids = null) {
  let count = 0;
  const only = ids ? new Set(ids) : null;
  const next = tasks.map((t) => {
    if (t.column !== "done" || t.archived || (only && !only.has(t.id))) return t;
    count++;
    return { ...bumped(t), archived: true, updated: now };
  });
  return { tasks: next, count };
}

// Board top bar "All issues" menu. A scope is an id from SCOPES or "project:<id>". Unknown scopes and deleted projects show everything.
export const SCOPES = [["all", "All issues"], ["agent", "With agent"], ["noagent", "No agent"], ["p01", "P0-P1"]];
export function inScope(task, scope, projects = []) {
  if (scope === "agent") return Boolean(task.agent);
  if (scope === "noagent") return !task.agent;
  if (scope === "p01") return task.priority === "P0" || task.priority === "P1";
  if (typeof scope === "string" && scope.startsWith("project:")) {
    const id = scope.slice(8);
    return projects.some((p) => p.id === id) ? task.project === id : true;
  }
  return true;
}

// Card progress: count "- [ ]", "- [x]", "* [X]" task lines (indented too) in a description, skipping fenced code blocks.
export function checklistProgress(desc) {
  let done = 0, total = 0, fence = null;
  for (const line of String(desc ?? "").split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // closes only on the same char, at least as long, nothing else on the line
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === "") fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const m = /^\s*[-*]\s+\[([ xX])\]/.exec(line);
    if (m) { total++; if (m[1] !== " ") done++; }
  }
  return { done, total };
}

export function ringGlyph(done, total) {
  if (!(total > 0)) return "○";
  const f = Math.max(0, Math.min(1, done / total));
  return f >= 1 ? "●" : ["○", "◔", "◑", "◕"][Math.floor(f * 4)];
}

// Board popovers (column "…" menus, "All issues"): `current` is the open key or null. Opening replaces it;
// a close only counts when it comes from the open one, because Popover reports the old one closing as a new one opens.
export const menuChange = (current, key, open) => (open ? key : current === key ? null : current);

// Board filter menu (Multica-style). State: { field: [values] }, in memory only. OR within a field, AND across fields.
export const FILTER_FIELDS = [
  ["status", "Status"], ["agentStatus", "Agent status"], ["priority", "Priority"], ["date", "Date"],
  ["assignee", "Assignee"], ["project", "Project"], ["label", "Label"], ["source", "Source"],
];
const FIELD_LABEL = Object.fromEntries(FILTER_FIELDS);
const AGENT_STATUS = ["working", "idle", "blocked", "done", "none"];
const SOURCES = [["github", "GitHub"], ["jira", "Jira"], ["manual", "Manual"]];
const WINDOWS = [["today", "today"], ["7d", "last 7 days"], ["30d", "last 30 days"]];
const DATE_VALUES = [["created", "Created"], ["updated", "Updated"]].flatMap(([k, kl]) => WINDOWS.map(([w, wl]) => ({ value: `${k}:${w}`, label: w === "today" ? `${kl} today` : `${kl} ${wl}` })));

export function toggleFilter(state, field, value) {
  const cur = state[field] ?? [];
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  const { [field]: _gone, ...rest } = state;
  return next.length ? { ...rest, [field]: next } : rest;
}

// No field: drop everything. A field: drop just that one.
export function clearFilters(state = {}, field) {
  if (field === undefined) return {};
  const { [field]: _gone, ...rest } = state;
  return rest;
}

// ctx: { now, projects, runs, agentsByAddress (address -> {status}), tasks }
export const assigneeLabel = (runs, address) => (runs ?? []).flatMap((r) => r.terminals ?? []).find((m) => m.address === address)?.name ?? address;

// A card's assignee for filtering: its task.assignee ("squad:id" / "agent:id"), else the live agent's address ("live:t9"), else "none".
export const assigneeKey = (t) => (t.assignee?.kind && t.assignee?.id ? `${t.assignee.kind}:${t.assignee.id}` : t.agent && t.agent !== CLAIMING ? `live:${t.agent}` : "none");
function assigneeName(key, ctx) {
  const i = key.indexOf(":"), kind = key.slice(0, i), id = key.slice(i + 1);
  if (kind === "live") return assigneeLabel(ctx.runs, id);
  return (kind === "squad" ? ctx.config?.squads : ctx.config?.agents)?.find((x) => x.id === id)?.name ?? id;
}

// Display name of a saved assignee for the card footer and editor ("" when none).
export const assigneeText = (a, cfg) => {
  const n = normAssignee(a);
  return n ? ((n.kind === "squad" ? cfg?.squads : cfg?.agents)?.find((x) => x.id === n.id)?.name ?? n.id) : "";
};

export function filterValues(field, ctx) {
  const tasks = ctx.tasks ?? [];
  if (field === "status") return COLUMNS.map(([value, label]) => ({ value, label }));
  if (field === "agentStatus") return AGENT_STATUS.map((v) => ({ value: v, label: v === "none" ? "No agent" : v[0].toUpperCase() + v.slice(1) }));
  if (field === "priority") return PRIORITIES.map((p) => ({ value: p, label: `${p} ${PRIORITY_LABEL[p]}` }));
  if (field === "date") return DATE_VALUES.map((v) => ({ ...v }));
  if (field === "assignee") {
    const keys = [...new Set(tasks.map(assigneeKey).filter((k) => k && k !== "none"))];
    const rows = keys.map((value) => ({ value, label: assigneeName(value, ctx), live: value.startsWith("live:") }));
    const byName = (a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value);
    // Saved assignees by name, then live agents by name, then Unassigned
    return [...rows.filter((r) => !r.live).sort(byName), ...rows.filter((r) => r.live).sort(byName), { value: "none", label: "Unassigned" }].map(({ value, label }) => ({ value, label }));
  }
  if (field === "project") return (ctx.projects ?? []).map((p) => ({ value: p.id, label: p.name }));
  if (field === "label") return allTags(tasks).map((g) => ({ value: g, label: g }));
  if (field === "source") return SOURCES.map(([value, label]) => ({ value, label }));
  return [];
}

const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const inWindow = (stamp, w, now) => typeof stamp === "number" && stamp <= now + 60_000 && stamp >= (w === "today" ? startOfDay(now) : now - (w === "7d" ? 7 : 30) * 86_400_000);

const fieldMatch = {
  status: (t, v) => t.column === v,
  agentStatus: (t, v, ctx) => (v === "none" ? !t.agent : Boolean(t.agent) && ctx.agentsByAddress?.get(t.agent)?.status === v),
  priority: (t, v) => t.priority === v,
  date: (t, v, ctx) => { const [k, w] = v.split(":"); return (k === "created" || k === "updated") && inWindow(t[k], w, ctx.now ?? Date.now()); },
  assignee: (t, v) => assigneeKey(t) === v,
  project: (t, v) => t.project === v,
  label: (t, v) => (t.tags ?? []).includes(v),
  source: (t, v) => (t.source?.kind ?? "manual") === v,
};

export function matchesFilter(task, state, ctx) {
  return Object.entries(state ?? {}).every(([field, values]) => !values?.length || !fieldMatch[field] || values.some((v) => fieldMatch[field](task, v, ctx)));
}

// The menu's search box: fields whose name matches, plus (for a non-empty query) the values that match, across all fields.
export function searchFilters(query, ctx) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { fields: FILTER_FIELDS, values: [] };
  const fields = FILTER_FIELDS.filter(([, label]) => label.toLowerCase().includes(q));
  const values = FILTER_FIELDS.flatMap(([field, fieldLabel]) =>
    filterValues(field, ctx).filter((v) => v.label.toLowerCase().includes(q) || v.value.toLowerCase().includes(q)).map((v) => ({ field, fieldLabel, ...v })));
  return { fields, values };
}

export const filterChips = (state, ctx) => Object.entries(state ?? {}).flatMap(([field, values]) =>
  (values ?? []).map((value) => ({ field, value, fieldLabel: FIELD_LABEL[field] ?? field, label: filterValues(field, ctx).find((v) => v.value === value)?.label ?? value })));
