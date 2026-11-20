# Drover Switch

Build `drover-switch`: the page tabs on top of the `drover` column (Room + Tasks | Needs you N).

## What you see

A 34px bar with segmented tabs: one rounded track (4px padding, radius 8, hover background) holding two rounded segments (height 28, radius 6): `Room + Tasks` and `Needs you`. The selected segment has the canvas background and full text; the other is muted with a hover background. The count is a small rounded badge after `Needs you` in the blocked colour with white text, hidden at 0. The selected tab follows the layout.

## How it behaves

- Selected tab = `pageOf(layout())`; a click runs `showPage(page)` (`_lib/needsnav.js`). The count comes from the Needs-you cache, refreshed by its own 1 s timer.

## Built from

- Mod `drover-switch`, `place: none`, `main.js`, the shared `_lib` copies listed in `_lib/copies.txt`.

## Watch out

- Preview coming: no preview.png yet (needs a native window).
- Render reads memory only: no exec, file read or write, timer or spawn.
- The layout block id must be `drover-switch` in `_layouts/drover.json`.

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

- The count equals the list on the Needs you page.
- `herdr-app check` on the mod passes.
