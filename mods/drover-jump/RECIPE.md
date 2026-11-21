# Jump

Build `drover-jump`: a dialog, opened by a key, to jump to any card, run or project by typing.

## What you see

A dialog (600x440) with a text field, then a list of results (kind, title, id and column or status), the selected row highlighted, and a footer `↑↓ move · Enter go · Esc close`. No match: `No match`. Preview coming: no preview.png yet (see Watch out).

## How it behaves

- Bound in `keys.json` as `"cmd-k": "mod.open:drover-jump"` (section `global`). It is opt-in: Drover Config → Shortcuts switches it on, and the installer never writes `keys.json`. `ctrl-k` is not the default: a global `ctrl-k` would take readline's kill-line from every terminal pane.
- Typing filters (every word must match; label prefix, then word start, then anywhere), at most 50 rows. Up/Down move and stop at the ends, Enter acts once, Esc closes.
- Enter: a card with a live agent focuses it (`agent.focus`); a card without one opens its editor (a remote card: the read-only view); a run focuses its first live member, else opens the Runs screen; a project writes the Tasks filter (`drover.tasks.filters:<space>`, else `drover.tasks.filters`) to `{ project: [id] }` clears the Tasks text query (a shared token Tasks reads in its timer) and shows the `drover` column, then Room + Tasks.
- The list is the in-memory snapshot (`_lib/jump.js`): local cards, the already loaded remote cache (no fetch, no watch), runs, projects, agents and terminals. It is derived in init, on Enter and by a 1 s timer; the filter runs in the field's change handler; render reads memory only.

## Built from

- Mod `drover-jump`, `place: none`, `mod.json`: `{ "place": "none", "title": "Jump", "overlay": { "width": 600, "height": 440 } }`, `main.js` plus the shared `jump.js`, `io.js`, `needsnav.js` and the other shared copies.
- `herdr` imports: `props`, `closeOverlay`, `setShared`, `run`, `theme`, `spaces`, `panes`. A `View` whose `init` reads `props()?.overlay` (null when the host only checks the mod: then do nothing).
- `_lib/jump.js` is pure: `jumpIndex`, `jumpFilter`, `jumpTarget`, `createJumpCache`. The key's clash check lives in `_lib/keys.js`: it also refuses a combo that Herdr's own `keys()` list binds elsewhere, and refuses to enable when that list cannot be read.

## Watch out

- Hard dependency: `drover-todos` (the editor Enter opens). The Tasks panel follows a project jump only if `drover-tasks` is installed.
- The key is not bound until `keys.json` has it. Never replace a key the person already uses: tell them to free it first.
- Not seen in a native window yet: that the dialog takes keyboard focus and that `cmd-k` reaches the global section before a terminal pane. Check after a window reopen.
- Colors, borders and radii come from `theme()`; no hex value is hard coded.

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

- The key opens the dialog; typing filters; Enter goes to the card, run or project; Esc closes.
- A render does no exec, read, write or timer start, and costs the same at 3 and 300 cards.
- `herdr-app check` on the mod passes.
