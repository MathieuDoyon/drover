// Work folder: where agents write plans, scouts, reviews and lane logs. Pure (no herdr import), so node --test runs it.
// Mode comes from the config field drover-config.work_folder:
//   repo    -> <worktree>/.drover for a worktree run, else <repo>/.drover   (gitignored, today's behaviour)
//   project -> <configDir>/work/<project id>
// Default is project (config-schema.js). A run without a project uses "_free" as the project segment. An unknown mode means repo,
// except "run" (an earlier version had a per-run folder; a saved "run" reads as project, see config.js).
// Ids become path segments below <configDir>/work, so agents/ and identities/ next to it are never a work folder.
// Ids become path segments, so an empty, "."/".." or separator/control-character id throws (never a path outside configDir).
export const FREE_PROJECT = "_free";
export const MODES = ["repo", "project"];
export const WORK_DIR = "work";

export function safeSegment(v) {
  if (typeof v !== "string" || !v.trim() || v === "." || v === ".." || /[\/\\\u0000-\u001f\u007f]/.test(v)) throw new Error(`unsafe path segment: ${JSON.stringify(v)}`);
  return v;
}

const absolute = (p, what) => {
  if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`${what} must be an absolute path`);
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
};

export function resolveWorkFolder({ mode, repo, worktree, project, configDir }) {
  if (mode === "project" || mode === "run") return `${absolute(configDir, "configDir")}/${WORK_DIR}/${safeSegment(project ? project.id : FREE_PROJECT)}`;
  return `${absolute(worktree || repo, worktree ? "worktree" : "repo")}/.drover`;
}

// ---- the one-time move offer (never automatic) ----
// An existing <repo>/.drover is offered a move only in project mode (its target is one fixed folder per project).
// counts: { "<repo path>": number of entries in <repo>/.drover }.
export function moveOffers({ mode, projects, counts, configDir }) {
  if (mode !== "project") return [];
  const out = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    const repo = (p?.repos?.find((r) => r.default) ?? p?.repos?.[0])?.path;
    const count = repo ? counts?.[repo] ?? 0 : 0;
    if (!repo || !count) continue;
    try { out.push({ id: p.id, name: p.name ?? p.id, from: `${repo.replace(/\/+$/, "")}/.drover`, to: resolveWorkFolder({ mode, repo, project: p, configDir }), count }); } catch { /* unsafe id or path: no offer */ }
  }
  return out;
}

export const confirmText = (o) => `Move ${o.count} item${o.count === 1 ? "" : "s"} from ${o.from} to ${o.to}? Nothing is overwritten: a name already there stays, and is listed.`;

// "moved 3, skipped 1\nconflict: a.md" (drover-workfolder move) -> { moved, skipped, conflicts }
export function parseMove(out) {
  const lines = String(out ?? "").split("\n");
  const m = /^moved (\d+), skipped (\d+)$/.exec(lines[0] ?? "");
  return m ? { moved: Number(m[1]), skipped: Number(m[2]), conflicts: lines.slice(1).filter((l) => l.startsWith("conflict: ")).map((l) => l.slice(10)), leftovers: lines.slice(1).filter((l) => l.startsWith("leftover: ")).map((l) => l.slice(10)) } : null;
}

export const moveSummary = (r) => `${moveSummaryBase(r)}${r.leftovers?.length ? ` Kept as ${r.leftovers.slice(0, 2).join(", ")}${r.leftovers.length > 2 ? ", …" : ""}: a newer file took the name.` : ""}`;
const moveSummaryBase = (r) => `Moved ${r.moved} file${r.moved === 1 ? "" : "s"}${r.skipped ? `, left ${r.skipped} that already exist${r.skipped === 1 ? "s" : ""} there (${r.conflicts.slice(0, 3).join(", ")}${r.conflicts.length > 3 ? ", …" : ""})` : ""}.`;

// The one-line command for the README / a person without the dialog.
export const moveCommand = (bin, from, to) => `${bin} move ${from} ${to}`;
