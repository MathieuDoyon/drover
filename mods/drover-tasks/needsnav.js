// Needs-you navigation (T-MWO2HFFHWRB, Rev 3). The `drover` column holds three pages as blocks: Room, Tasks and Needs you.
// Shown/hidden is Herdr's own persisted click state, so the page survives a restart. Pure: showPage() returns commands, runPage() runs them.
export const COLUMN = "drover", ROOM = "drover-room", TASKS = "drover-tasks", NEEDS = "drover-needs";

// Room page: Room + Tasks. Needs page: the column too (the chip can be clicked while it is hidden), then only Needs you.
export function showPage(page) {
  if (page === "needs") return [["layout.show", { id: COLUMN }], ["layout.hide", { id: ROOM }], ["layout.hide", { id: TASKS }], ["layout.show", { id: NEEDS }]];
  return [["layout.show", { id: ROOM }], ["layout.show", { id: TASKS }], ["layout.hide", { id: NEEDS }]];
}
export const runPage = (run, page) => { for (const [cmd, args] of showPage(page)) run(cmd, args); };

export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}
// Read from the shown layout, never stored: needs shown AND room hidden is the needs page. Anything else (default, half applied, other layout) is room,
// so the next click on a page heals a half-applied state.
export function pageOf(root) {
  const needs = findNode(root, NEEDS), room = findNode(root, ROOM);
  return needs && room && !needs.hidden && room.hidden ? "needs" : "room";
}
