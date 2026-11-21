# Jump

`drover-jump`. No screen: a key that opens a dialog to jump to any card, run or project.

## Open it

Press `cmd-k` once the shortcut is on (Drover Config → Shortcuts; it is off until you turn it on). It is bound in `keys.json` as `"cmd-k": "mod.open:drover-jump"` under `global`. The default is Cmd+K, not Ctrl+K: a global `ctrl-k` would take the kill-line key from the shell in every terminal. If you want Ctrl+K anyway, bind it by hand in `keys.json`.

Type to filter, Up/Down move, Enter goes, Esc closes.

## What Enter does

| Result | Enter |
| --- | --- |
| Card with a live agent | Focuses that agent |
| Card without one | Opens its editor (a card of another machine: read-only) |
| Run | Focuses its first live member, else opens the Runs screen |
| Project | Sets the Tasks panel filter of this space to that project and shows the `drover` column with Room + Tasks (this replaces the filters set there and clears the Tasks text box) |

## Settings

| Setting | Meaning |
| --- | --- |
| `(none)` | It has no `enabled` switch. Turn the shortcut on or off in Drover Config → Shortcuts. |

## Data it reads and writes

Reads the cards, projects, runs, agents and terminals already in memory, plus the remote cards already loaded (it fetches none and starts no watch). Writes only the Tasks filter key (`drover.tasks.filters:<space>`) and a reset token (`drover.tasks.query-reset:<space>`, read by Tasks in its timer) when you jump to a project. It never writes `keys.json`; Drover Config does, and refuses a combo that `keys.json` or Herdr's own bindings already use, or when Herdr's bindings cannot be read (switching it off is always allowed).

## Needs

`drover-todos` for the editor. A project jump shows its result in `drover-tasks`.

Works alone: No.

## Limits

At most 50 results are listed; type more to narrow them. Not yet confirmed in a native window: that the dialog takes keyboard focus, and that `cmd-k` reaches Herdr before a terminal pane does.

## Rebuild it

[`RECIPE.md`](../../mods/drover-jump/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
