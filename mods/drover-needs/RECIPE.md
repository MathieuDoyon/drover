# Needs you

Build `drover-needs`: the page of the `drover` column that lists the cards waiting for the owner.

## What you see

A header `Needs you` with the count, then one row per thing that waits on you (a card whose agent asks or is gone, or a failed wakeup in the last 24 h; title; reason, id, project), oldest first; a wakeup row opens the Wakeups screen. Empty: `Nothing needs you`.

## How it behaves

- Row click: show Room + Tasks (`showPage('room')`), then `agent.focus {terminal}` for a live agent, else open the card editor.
- The list comes from the Needs-you cache (`_lib/needs.js`): derived in init and by a 1 s timer, never in render. Init also starts the remote board watch.

## Built from

- Mod `drover-needs`, `place: none`, `main.js`, the shared `_lib` copies listed in `_lib/copies.txt`.

## Watch out

- Preview coming: no preview.png yet (needs a native window).
- Render reads memory only: no exec, file read or write, timer or spawn.
- The layout block id must be `drover-needs` in `_layouts/drover.json`.

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

- The count equals the list on the Needs you page.
- `herdr-app check` on the mod passes.
