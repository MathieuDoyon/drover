# Tasks

`drover-tasks`. The right-hand attention panel: one row per task grouped as Needs you, Ready for review, Working, Ready and Blocked, with a filter box (Enter adds a task). It also holds the `drover` command-line tool agents use.

![Tasks](../../mods/drover-tasks/preview.png)

## Open it

In the `drover` layout it is the bottom of the right column. Alone: `herdr-app do pane.split '{"direction":"right","mod":"drover-tasks"}'`.

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `enabled` | Drover Config → `enabled` (on by default). Off hides the screen and blanks it; the data and the `drover` CLI stay. |

## Data it reads and writes

Reads and writes `drover.tasks`; filters are saved per space (`drover.tasks.filters`). `bin/drover` reads `<home>/shared.json` and writes requests to `<home>/data/drover-inbox`.

`drover doctor` checks the install and changes nothing: one line per check (`ok`, `WARN`, `FAIL` or `skip`, then the check name and a short detail) and a summary line. It looks at the mod links in the home, the shared `_lib` copies, the soul files, a hint that a running Herdr may hold older shared code (the `_lib` fingerprint against the stamp `install.sh` wrote; the answer is to reopen the window, and it is not probed), and whether `drover` on your `PATH` is this file. Exit 0 means no `FAIL` (a `WARN` or `skip` does not fail); exit 1 means a `FAIL`. It needs no Herdr and prints no paths, file content or environment values. A `hooks` line is reserved and always `skip` for now.

## Needs

`drover-todos` (editor), `drover-agents` (▶ picker). The CLI needs `bash`, `python3`, and `hc` for wakeups.

Works alone: Lists and filters tasks alone. Without an open Tasks, Board or Wakeups mod, CLI writes stay `queued`.

## Limits

One card is in one group, by this order (first match wins): archived or Done: none; an agent that is starting: Working; an agent whose terminal asks (blocked), in any open column: Needs you; Blocked column: Blocked (parked, last group, not counted); Review column: Ready for review; In progress with an agent whose terminal is gone: Needs you; an agent working: Working; an agent on a live terminal that stopped, went idle or reports no status: Working; In progress with no agent: Working; else Ready (a gone agent on a Ready card is still Ready). So `Needs you` holds only what waits on you now: an agent that asks beats the Blocked column and Review, and neither the Blocked column nor Review is counted there. Reasons are at most 40 characters. The groups, dots and remote ✓ state are derived outside render (when the panel starts and every second) and render only reads them. The `Needs you` number (cards plus failed wakeups, see [Needs you](needs.md)) is shown in the switch tab on top of the `drover` column and in the tab-bar chip (the count ignores your filters; the group header in the panel shows the filtered count). Herdr has no tab or sidebar badge API (only the Dock icon text), so there is no badge. A 300px right panel (`place: right`). The ✓ on a review row moves the card to Done. The filter menu never defaults to hiding anything. In a narrow pane the rows truncate.

## Rebuild it

[`RECIPE.md`](../../mods/drover-tasks/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
