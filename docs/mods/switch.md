# Switch

`drover-switch`. The two page tabs on top of the `drover` column, drawn as segmented tabs: `Room + Tasks` and `Needs you`, with the count as a small badge.

## Open it

Always shown on top of the `drover` column of the `drover` layout.

## How it behaves

- The selected tab is read from the layout (`Needs you` is selected when that page shows and Room is hidden), never stored here. Herdr keeps shown and hidden blocks across restarts.
- A click shows the page (`layout.show` / `layout.hide` on `drover-room`, `drover-tasks`, `drover-needs`). A half-applied state reads as Room + Tasks and heals on the next click.
- The badge after `Needs you` is the number of things that wait for you (cards and failed wakeups); it is the length of the `Needs you` page, and the badge is hidden at 0. It refreshes every second.

## Settings

| Setting | Meaning |
| --- | --- |
| `(none)` | No `enabled` switch. |

## Data it reads and writes

Reads the same cards, runs, agents and terminals as the Tasks panel. Writes nothing.

## Needs

[`drover-needs`](needs.md), `drover-room` and `drover-tasks` (the pages it switches).

Works alone: Only useful inside the `drover` layout.

## Limits

No tab or sidebar badge API exists in Herdr, so the count is drawn here and in the tab-bar chip.

## Rebuild it

[`RECIPE.md`](../../mods/drover-switch/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
