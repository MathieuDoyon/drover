# Room

The right panel for the run you are inside: the linked issue's properties, the run's wakeups, the parent issue, the PRs on its branch and the squad.

![Room](preview.png)

## What you see

The top block of the `drover` layout's right column (300px, above Tasks). Outside a run it says "Not inside a run. Focus a run's agent or open its room (Runs → Open room)". Inside a run: properties (the issue's status, project and type; the card's assignee; the issue's own GitHub/Jira assignee only when it has one; the column by its Board name), the agent, branch, the run's wakeups with toggles and a `+`, the parent issue, PRs with Open / Draft / Merged / Closed badges, and the squad members.

## How it behaves

- Read-only for Jira and GitHub. It refreshes on entry and every `refresh_minutes` (default 5) per run, never faster, one at a time, and keeps the last good data on errors.
- `+` opens the New wakeup dialog aimed at the run's task, else its leader.
- A wakeup toggle pauses it; ✕ cancels it ("Cancelled by you").
- Context is cached in shared state (`drover.room`, the last `kept_contexts` runs).

## Built from

- Mod `drover-room`, `place: none`, `main.js` (about 190 lines), `mod.schema.json`.
- `herdr` imports: `agents`, `terminals`, `focused`, `run`, `theme`, `shared`, `setShared`.
- Calls `gh` and the Jira REST API through `_lib/io.js` (`loadContext`) for the linked issue and PRs.

## Watch out

- Shared state keys are named in `_lib/store.js` (`drover.tasks`, `drover.projects`), `_lib/wake.js` (`drover.wakeups`) and `_lib/runs.js` (`drover.agents`, `drover.runs`). `mods/install.sh` copies the `_lib` files listed in `_lib/copies.txt` next to `main.js`; a copy of the mod alone must carry them.
- Reads the run (`drover.runs`), the card (`drover.tasks`) and the wakeups; without a run started by `drover-agents`, Board or Tasks it stays on the "Not inside a run" text.
- Reaches the network (`gh`, Jira) with the same credentials as `drover-github` and `drover-jira`.
- Built for the `drover` layout; in another layout give it a block.
- Colors, borders and radii come from `theme()`; no hex value is hard coded. Every screen has an `enabled` switch in Drover Config (off hides the screen only; the data and the `drover` CLI stay).

## Companion mods

<!-- companions:begin -->
**Before you finish, check the companion mods.** Drover is 17 `drover-*` mods and one layout that work together. This mod is one of them.

1. List what is installed: `ls <home>/mods | grep '^drover-'` (`<home>` is the Herdr home, `~/.config/herdr-app` by default). Compare it with this list and work out which are missing:
   `drover-agents`, `drover-board`, `drover-config`, `drover-github`, `drover-jira`, `drover-jump`, `drover-needs`, `drover-newtask`, `drover-projects`, `drover-reader`, `drover-room`, `drover-runs`, `drover-switch`, `drover-tabs`, `drover-tasks`, `drover-todos`, `drover-wakeups`. Also check `<home>/layouts/drover.json`.
2. Tell the person plainly: "installed X of 17, missing [...]". Count this mod as installed once it is in place. If this is the only one, say so.
3. If any are missing, recommend installing all of them: clone `github.com/MathieuDoyon/drover`, then run `mods/install.sh` (it also links the `drover` layout). Or install them one by one from herdr.dev. Ask before installing anything.
4. Then ask once, in one message: Work folder location (project default or the repo's `.drover/`); enable GitHub (y/n); enable Jira (y/n); a shortcut for the right sidebar (Tasks) (y/n); a shortcut to create a task (y/n). Apply the answers in Drover Config (Work folder, the GitHub and Jira switches). The two shortcuts go into `keys.json` under `layout:drover` (`cmd-alt-b` runs `layout.toggle` for the `drover` column) and `global` (`cmd-shift-c` runs `mod.open:drover-newtask`); Drover Config → Shortcuts writes them. Ask before replacing a key the person already uses.
<!-- companions:end -->

## Done when

- Outside a run it shows the "Not inside a run" text.
- Inside a run it shows the card's linked issue properties.
- `+` opens the wakeup dialog for that run.
- `herdr-app check` on the mod passes.
- The Squad section offers **Resume squad** on an ended run whose card is not Done/archived (`canResume` = `resumeGuard`); one click = one `resumeSquad` call; Cancel sets the durable attempt flag (`cancelResume`). A crashed attempt (`resumeState` = needs-recovery) shows **Resume needs recovery** with Recover (`recoverResume`) and Cancel (`recoverResume(…, {adopt:false})`); no tick ever kills or frees anything.
