# Projects

The list of projects (a name, its repos, folders and base branch) that tasks and runs point at.

![Projects](preview.png)

## What you see

A tab with a header and `New`, then one row per project: name, repos (first = default), loose folders, base branch, and Edit / ✕. New and Edit are a dialog of the same mod with name, repos (one per line), folders and base branch (default `main`).

## How it behaves

- `New` and Edit check that each repo path is a git repository (`git` runs on it) before saving; the first bad path is named and nothing is saved.
- ✕ asks to confirm and refuses while tasks use the project ("N tasks use this project: move them first").
- A task picks its project in the Todos editor; starting with a worktree uses the project's default repo.

## Built from

- Mod `drover-projects`, `place: none`, `main.js` (about 130 lines); project logic is in `_lib/store.js` (`addProject`, `updateProject`, `removeProject`, `findProject`).
- `herdr` imports: `theme`, `setShared`, `props`, `closeOverlay`, `openOverlay`, `exec`, `notify`, `shared`.
- Runs `git` to check repo paths. Writes the shared key `drover.projects`.

## Watch out

- Shared state keys are named in `_lib/store.js` (`drover.tasks`, `drover.projects`), `_lib/wake.js` (`drover.wakeups`) and `_lib/runs.js` (`drover.agents`, `drover.runs`). `mods/install.sh` copies the `_lib` files listed in `_lib/copies.txt` next to `main.js`; a copy of the mod alone must carry them.
- Needs `git` on PATH. Project names are unique, case-insensitive.
- Read by `drover-todos` (project chip, `drover add --project`), `drover-agents` (the `▶ opens in` selector) and `drover-room` (the Project row).
- Colors, borders and radii come from `theme()`; no hex value is hard coded. Every screen has an `enabled` switch in Drover Config (off hides the screen only; the data and the `drover` CLI stay).

## Companion mods

<!-- companions:begin -->
**Before you finish, check the companion mods.** Drover is 16 `drover-*` mods and one layout that work together. This mod is one of them.

1. List what is installed: `ls <home>/mods | grep '^drover-'` (`<home>` is the Herdr home, `~/.config/herdr-app` by default). Compare it with this list and work out which are missing:
   `drover-agents`, `drover-board`, `drover-config`, `drover-github`, `drover-jira`, `drover-needs`, `drover-newtask`, `drover-projects`, `drover-reader`, `drover-room`, `drover-runs`, `drover-switch`, `drover-tabs`, `drover-tasks`, `drover-todos`, `drover-wakeups`. Also check `<home>/layouts/drover.json`.
2. Tell the person plainly: "installed X of 16, missing [...]". Count this mod as installed once it is in place. If this is the only one, say so.
3. If any are missing, recommend installing all of them: clone `github.com/MathieuDoyon/drover`, then run `mods/install.sh` (it also links the `drover` layout). Or install them one by one from herdr.dev. Ask before installing anything.
4. Then ask once, in one message: Work folder location (project default or the repo's `.drover/`); enable GitHub (y/n); enable Jira (y/n); a shortcut for the right sidebar (Tasks) (y/n); a shortcut to create a task (y/n). Apply the answers in Drover Config (Work folder, the GitHub and Jira switches). The two shortcuts go into `keys.json` under `layout:drover` (`cmd-alt-b` runs `layout.toggle` for the `drover` column) and `global` (`cmd-shift-c` runs `mod.open:drover-newtask`); Drover Config → Shortcuts writes them. Ask before replacing a key the person already uses.
<!-- companions:end -->

## Done when

- `New` with a non-git folder shows an error and saves nothing.
- A valid project appears in the Todos editor's project menu.
- ✕ on a project used by a task is refused.
- `herdr-app check` on the mod passes.
