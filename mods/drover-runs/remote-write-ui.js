// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// View-model for the write controls on a remote project's cards (T-MWHVWR8TIJB): pure, so the views stay thin.
// The state comes from io.js remoteWriteState(); the ops go to io.js remoteSend(), which builds the real request (remote-write.js).

export const OFF_TIP = "not available for projects on the remote machine yet"; // start / wake / next / agent stay off
export const offTip = (machine) => (machine ? `not available for projects on ${machine} yet` : OFF_TIP);
const named = (machine) => machine || "the remote machine";
const COLUMNS = ["backlog", "todo", "doing", "review", "blocked", "done"];

// { on, tip } for any control that writes a card. ws = remoteWriteState(localId).
// op: the card op this control sends (move, note, edit, add, archive). On the exec transport each op has its own gate (the remote's ops list), applied after the
// freshness / writes / clock gate; the inbox transport has one gate for all (no ws.controls).
export function controlState(ws, op) {
  if (ws?.enabled) {
    if (op && ws.controls && ws.controls[op] === false) return { on: false, tip: ws.opTips?.[op] || `The remote machine does not support ${op}` };
    return { on: true, tip: null };
  }
  if (ws?.frozen) return { on: false, tip: "writes frozen" };
  return { on: false, tip: ws?.reason || "writes are off" };
}
// { on, tip } for the field controls (priority, labels, assignee, parent, project): writes on AND the probe allows fields.
export function fieldState(ws) {
  const c = controlState(ws, "edit");
  if (!c.on) return c;
  return ws?.fields?.on ? { on: true, tip: null } : { on: false, tip: ws?.fields?.tip || "needs the update for priority, labels, assignee, parent and project" };
}
export const statusLine = (ws) => (ws?.enabled ? "writes on" : controlState(ws).tip);

export function moveOp(card, column) {
  if (!card?.id || !COLUMNS.includes(column) || card.column === column) return null;
  return { op: "move", id: card.id, column };
}
// dir -1 / +1 along the visible columns.
export function shiftOp(card, columnIds, dir) {
  const i = columnIds.indexOf(card?.column);
  return i < 0 ? null : moveOp(card, columnIds[i + dir]);
}
export const archiveOp = (card) => (card?.id ? { op: "archive", id: card.id } : null);
export function addOp({ title, desc, column, priority, tags, assignee, parent } = {}) {
  const t = String(title ?? "").trim();
  if (!t) return null;
  return { op: "add", title: t, desc: String(desc ?? ""), tags: Array.isArray(tags) ? tags : [], column: column ?? "backlog", priority: priority ?? "P2", ...(assignee ? { assignee } : {}), ...(parent ? { parent } : {}) };
}
// The editor's Save: one edit of the changed fields (text, priority, labels, assignee, parent), then the note, then the project change LAST (the
// card leaves this project's board, so nothing can follow it). Sent in this order, one after the other (a save re-reads the board, so each
// later op carries the card's new rev; a card with no rev counts as 0). Only the first op names ifRev: the rev the editor OPENED the card at; the ops after it follow our own save.
// A draft of undefined leaves the field alone; null clears assignee/parent ("none"); tags [] clears the labels.
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const sameAssignee = (a, b) => (a?.kind ?? null) === (b?.kind ?? null) && (a?.id ?? null) === (b?.id ?? null);
export function editOps(card, { title, desc, note, priority, tags, assignee, parent, project }) {
  const ops = [];
  const fields = {};
  const nt = String(title ?? "").trim();
  if (nt && nt !== card.title) fields.title = nt;
  if (desc !== undefined && String(desc) !== (card.desc ?? "")) fields.desc = String(desc);
  if (priority !== undefined && priority !== card.priority) fields.priority = priority;
  if (Array.isArray(tags) && !sameSet(tags, card.tags ?? [])) fields.tags = tags;
  if (assignee !== undefined && !sameAssignee(assignee, card.assignee)) fields.assignee = assignee ? { kind: assignee.kind, id: assignee.id } : "none";
  if (parent !== undefined && (parent || null) !== (card.parent || null)) fields.parent = parent || "none";
  if (Object.keys(fields).length) ops.push({ op: "edit", id: card.id, ...fields });
  const n = String(note ?? "").trim();
  if (n) ops.push({ op: "note", id: card.id, text: n });
  if (typeof project === "string" && project && project !== card.remote?.projectId) ops.push({ op: "edit", id: card.id, project });
  if (ops.length) ops[0] = { ...ops[0], ifRev: Number.isSafeInteger(card.rev) && card.rev > 0 ? card.rev : 0 }; // a card with no rev is version 0, never "no baseline"
  return ops;
}

// The card as it is on the remote once `op` was saved: the editor's new baseline (a revert is then a change, a saved edit is not sent again).
export function applied(card, op) {
  if (op?.op === "move") return { ...card, column: op.column };
  if (op?.op !== "edit") return card;
  return {
    ...card,
    ...(op.title !== undefined ? { title: op.title } : {}), ...(op.desc !== undefined ? { desc: op.desc } : {}),
    ...(op.priority !== undefined ? { priority: op.priority } : {}), ...(op.tags !== undefined ? { tags: op.tags } : {}),
    ...(op.assignee !== undefined ? { assignee: op.assignee === "none" ? null : op.assignee } : {}),
    ...(op.parent !== undefined ? { parent: op.parent === "none" ? null : op.parent } : {}),
    ...(op.project !== undefined ? { remote: { ...card.remote, projectId: op.project } } : {}),
  };
}

// A writer outcome -> the text the person reads.
export function outcomeText(o) {
  if (!o) return "";
  switch (o.status) {
    case "saved": return "Saved";
    case "stale": return `card changed on ${named(o.machine)}: reloaded, try again`;
    case "expired": return "not applied, too old";
    case "pending": return "sent, may still apply";
    case "unknown": return o.transport === "exec" && o.message ? o.message : `outcome unknown: check the card on ${named(o.machine)}`; // exec: "…Repeat the action to retry safely"
    case "refused": case "failed": return o.message || "not sent";
    default: {
      const first = String(o.text ?? "").split("\n")[0].trim() || `error: ${o.message ?? "unknown"}`;
      return first.startsWith("error:") ? first : `error: ${first}`;
    }
  }
}

// The "Writes to <machine>" toggle in the project editor. remote = the saved binding; ws = remoteWriteState.
export function writesToggle(remote, ws) {
  const on = remote?.writes !== false;
  return { on, label: `Writes to ${named(remote?.machine)}`, note: on ? "on" : ws?.frozen ? "frozen" : "off, waiting for sends in flight" };
}

// The "Transport" control next to it: inbox (the default, files in the machine's inbox) or exec (drover-headless over hc exec). Flipping saves the binding only.
export function transportToggle(remote) {
  const exec = remote?.transport === "exec";
  return {
    value: exec ? "exec" : "inbox",
    next: exec ? "inbox" : "exec",
    button: exec ? "Back to inbox" : "Switch to exec",
    label: `Transport to ${named(remote?.machine)}`,
    note: exec ? "exec: headless board. Back any time; nothing moves" : "inbox (default). exec needs install + migrate-in; nothing moves",
  };
}
