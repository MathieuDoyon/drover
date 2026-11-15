# Room

`drover-room`. The right panel for the run you are in: the linked issue's properties, agent, branch, the run's wakeups, parent issue, PRs on the branch and the squad.

![Room](../../mods/drover-room/preview.png)

## Open it

In the `drover` layout it is the top of the right column. As a bare pane it needs a block: `herdr-app do pane.split '{"direction":"right","mod":"drover-room"}'`.

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `enabled` | Drover Config → `enabled` (on by default). Off hides the screen and blanks it; the data and the `drover` CLI stay. |
| `refresh_minutes` | 5 (1-1440). Minimum age before a run's context reloads. |
| `pr_cap` | 10 (1-100). Most PRs linked from the issue. |
| `kept_contexts` | 30 (1-1000). Runs whose context it remembers. |

## Data it reads and writes

Reads `drover.runs`, `drover.tasks`, `drover.wakeups`, `drover.projects`; writes its cache `drover.room` and wakeup toggles. Calls `gh` and the Jira API for the linked issue.

## Needs

`gh` and the Jira credential file for issue data; `drover-wakeups` (the `+` dialog) and `drover-todos` (edit).

Works alone: It opens alone and says "Not inside a run" until a run exists.

## Limits

Read-only for Jira and GitHub. It refreshes no faster than `refresh_minutes` per run and keeps the last good data on errors.

## Rebuild it

[`RECIPE.md`](../../mods/drover-room/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
