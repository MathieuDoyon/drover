// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// The request a UI op becomes (T-MWHVWR8TIJB): pure validation, the envelope body the exec transport (remote-exec.js) signs and sends to drover-headless.
// The inbox delivery that used to live here is retired (T-MWO2V65MUSX): no project reaches a remote machine any other way than exec.

export const TTL_MS = 120000; // an op older than this on arrival is refused as expired
export const OPS = ["move", "note", "edit", "add", "archive"];

const COLUMNS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const validId = (s) => typeof s === "string" && /^T-[A-Z0-9]+$/.test(s);
const PRIORITY_IDS = ["P0", "P1", "P2", "P3"];
const validRemoteProject = (s) => typeof s === "string" && /^P-[A-Z0-9]+$/.test(s);
// Strict, like the consumer: a value is valid or the whole request is not sent. {kind,id} is copied, never the caller's object.
const assigneeOf = (a) => (a === "none" ? { value: "none" } : a && typeof a === "object" && (a.kind === "agent" || a.kind === "squad") && typeof a.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(a.id) ? { value: { kind: a.kind, id: a.id } } : { error: "Bad assignee" });
const str = (v, max = 20000) => typeof v === "string" && v.length <= max;

// The op the UI asks for -> the request JSON, or { error }. Only op fields: nothing else from the caller is copied.
export function buildPayload(op, { projectId, rev }) {
  if (!op || !OPS.includes(op.op)) return { error: `${op?.op ?? "that op"} is not allowed from here` };
  if (op.op === "add") {
    if (!str(op.title, 500) || !op.title.trim()) return { error: "A title is required" };
    if (op.desc !== undefined && !str(op.desc)) return { error: "Bad description" };
    if (op.column !== undefined && !COLUMNS.includes(op.column)) return { error: "Bad column" };
    if (op.priority !== undefined && !["P0", "P1", "P2", "P3"].includes(op.priority)) return { error: "Bad priority" };
    if (op.tags !== undefined && !(Array.isArray(op.tags) && op.tags.every((t) => str(t, 100)))) return { error: "Bad tags" };
    const extra = {};
    if (op.assignee !== undefined) { const a = assigneeOf(op.assignee); if (a.error) return a; extra.assignee = a.value; }
    if (op.parent !== undefined) { if (!validId(op.parent)) return { error: "Bad parent" }; extra.parent = op.parent; }
    return { json: { op: "add", title: op.title, desc: op.desc ?? "", tags: op.tags ?? [], column: op.column ?? "backlog", priority: op.priority ?? "P2", project: projectId, ...extra, ttlMs: TTL_MS } };
  }
  if (!validId(op.id)) return { error: "Bad card id" };
  const head = { op: op.op, id: op.id };
  if (op.op === "move") {
    if (!COLUMNS.includes(op.column)) return { error: "Bad column" };
    head.column = op.column;
  } else if (op.op === "note") {
    if (!str(op.text) || !op.text.trim()) return { error: "A note needs text" };
    head.text = op.text;
    if (op.kind !== undefined) { if (!["decision", "log", "blocker", "pr", "handoff"].includes(op.kind)) return { error: "Bad note kind" }; head.kind = op.kind; }
  } else if (op.op === "edit") {
    if (!["title", "desc", "priority", "tags", "assignee", "parent", "project"].some((k) => op[k] !== undefined)) return { error: "Nothing to change" };
    if (op.title !== undefined) { if (!str(op.title, 500) || !op.title.trim()) return { error: "Bad title" }; head.title = op.title; }
    if (op.desc !== undefined) { if (!str(op.desc)) return { error: "Bad description" }; head.desc = op.desc; }
    if (op.priority !== undefined) { if (!PRIORITY_IDS.includes(op.priority)) return { error: "Bad priority" }; head.priority = op.priority; }
    if (op.tags !== undefined) { if (!(Array.isArray(op.tags) && op.tags.every((t) => str(t, 100)))) return { error: "Bad tags" }; head.tags = op.tags; }
    if (op.assignee !== undefined) { const a = assigneeOf(op.assignee); if (a.error) return a; head.assignee = a.value; }
    if (op.parent !== undefined) { if (op.parent !== "none" && !validId(op.parent)) return { error: "Bad parent" }; head.parent = op.parent; }
    if (op.project !== undefined) { if (op.project !== "none" && !validRemoteProject(op.project)) return { error: "Bad project" }; head.project = op.project; }
  }
  return { json: { ...head, ifRev: rev, ttlMs: TTL_MS } };
}
