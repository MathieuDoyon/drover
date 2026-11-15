// Canonical copy lives in mods/_lib; mods/install.sh copies it into each drover-* mod.
// View-model for the write controls on a remote project's cards (T-MWHVWR8TIJB): pure, so the views stay thin.
// The state comes from io.js remoteWriteState(); the ops go to io.js remoteSend(), which builds the real request (remote-write.js).

export const OFF_TIP = "not available for omarchy projects yet"; // start / wake / next / agent stay off
const COLUMNS = ["backlog", "todo", "doing", "review", "blocked", "done"];

// { on, tip } for any control that writes a card. ws = remoteWriteState(localId).
export function controlState(ws) {
  if (ws?.enabled) return { on: true, tip: null };
  if (ws?.frozen) return { on: false, tip: "writes frozen" };
  return { on: false, tip: ws?.reason || "writes are off" };
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
export function addOp({ title, desc, column, priority, tags } = {}) {
  const t = String(title ?? "").trim();
  if (!t) return null;
  return { op: "add", title: t, desc: String(desc ?? ""), tags: Array.isArray(tags) ? tags : [], column: column ?? "backlog", priority: priority ?? "P2" };
}
// The editor's Save: an edit of the changed fields, then a note. Sent in this order, one after the other (a save re-reads the board, so
// the note carries the card's new rev).
export function editOps(card, { title, desc, note }) {
  const ops = [];
  const fields = {};
  const nt = String(title ?? "").trim();
  if (nt && nt !== card.title) fields.title = nt;
  if (desc !== undefined && String(desc) !== (card.desc ?? "")) fields.desc = String(desc);
  if (Object.keys(fields).length) ops.push({ op: "edit", id: card.id, ...fields });
  const n = String(note ?? "").trim();
  if (n) ops.push({ op: "note", id: card.id, text: n });
  return ops;
}

// The card as it is on omarchy once `op` was saved: the editor's new baseline (a revert is then a change, a saved edit is not sent again).
export function applied(card, op) {
  if (op?.op === "move") return { ...card, column: op.column };
  if (op?.op !== "edit") return card;
  return { ...card, ...(op.title !== undefined ? { title: op.title } : {}), ...(op.desc !== undefined ? { desc: op.desc } : {}) };
}

// A writer outcome -> the text the person reads.
export function outcomeText(o) {
  if (!o) return "";
  switch (o.status) {
    case "saved": return "Saved";
    case "stale": return "card changed on omarchy: reloaded, try again";
    case "expired": return "not applied, too old";
    case "pending": return "sent, may still apply";
    case "unknown": return "outcome unknown: check the card on omarchy";
    case "refused": case "failed": return o.message || "not sent";
    default: {
      const first = String(o.text ?? "").split("\n")[0].trim() || `error: ${o.message ?? "unknown"}`;
      return first.startsWith("error:") ? first : `error: ${first}`;
    }
  }
}

// The "Writes to omarchy" toggle in the project editor. remote = the saved binding; ws = remoteWriteState.
export function writesToggle(remote, ws) {
  const on = remote?.writes !== false;
  return { on, label: `Writes to ${remote?.machine ?? "omarchy"}`, note: on ? "on" : ws?.frozen ? "frozen" : "off, waiting for sends in flight" };
}
