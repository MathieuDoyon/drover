# Drover layout

A Herdr window with a Drover tab bar on top, the usual terminal in the middle and a right column with the current run (Room) above the attention list (Tasks).

![Drover layout](preview.png)

## What you see

A row `root` on the `canvas` background. Left, a 268px `sidebar` column (`chrome` background, not resizable, 44-480px): `brand` (46px, `workspace-chrome`), then `spaces` and `agents` blocks of equal weight, then `sidebar-footer` (69px, `workspace-chrome` with `footer: true`). Right, a `work` column: `tabs` (42px, `drover-tabs`), a `work-body` row, and `status` (28px, `workspace-status`).
`work-body` holds `main` (the active tab; panes with gap 8, radius 10, a 1px border, a 1px accent focus ring, a 30px `pane` header), a hidden 368px `panel` (a stack of `files` and `changes`), and the `drover` column (300px, `chrome`) with `drover-switch` (34px, the page tabs) on top, `drover-room` and `drover-tasks` of equal weight, and `drover-needs` (hidden by default, weight 1: the Needs you page; `layout.show` / `layout.hide` swap it with Room and Tasks). Title bar is `none`, traffic lights at 12,16, terminal padding 14,12, dividers 1px `border`.

## How it behaves

- The `Tasks` capsule (or `cmd-alt-b`, section `layout:drover`) toggles the `drover` column; the sidebar toggles with `ctrl-shift-b`.
- Below 160px the sidebar draws a compact rail.
- Switch in: `herdr-app do layout.switch '{"name":"drover"}'`; back: `'{"name":"main"}'` or `ctrl-shift-l`.
- Agent status shows in the tabs and in the sidebar `agents` list.

## Built from

- `_layouts/drover.json`, one JSON file that `mods/install.sh` links to `<home>/layouts/drover.json`.
- Shipped Herdr mods: `workspace-chrome`, `spaces`, `agents`, `workspace-status`, `pane`, `files`, `changes`.
- Drover mods: `drover-tabs`, `drover-switch`, `drover-needs`, `drover-room`, `drover-tasks`.

## Watch out

- It needs `drover-tabs`, `drover-switch`, `drover-needs`, `drover-room` and `drover-tasks` in `<home>/mods`; a layout block whose mod is missing stays empty.
- The `drover` column is the one `drover-tabs` toggles: keep its id `drover` or the `Tasks` capsule does nothing.
- `install.sh` only creates a symlink and skips a real `layouts/drover.json` file.
- The `panel` column is hidden by default; unhide it in the file for files and changes.

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

- `herdr-app do layout.switch '{"name":"drover"}'` shows the tab bar with `Drover ▾`, `Agents` and `Tasks`.
- The right column shows Room above Tasks and `Tasks` hides it.
- `herdr-app check` on `drover-tabs`, `drover-room` and `drover-tasks` passes.
