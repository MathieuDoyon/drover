# Runs

`drover-runs`. Every agent or squad run with its members' live status, and Open room, Focus, Stop and Forget.

![Runs](../../mods/drover-runs/preview.png)

## Open it

`herdr-app do tab.new --name Runs --mod drover-runs`, or the Squads preset (`Drover ▾`), which shows Agents and Runs side by side.

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `enabled` | Drover Config → `enabled` (on by default). Off hides the screen and blanks it; the data and the `drover` CLI stay. |
| `max_parallel` | 2 (1-10). Squad runs active at once for each project. |
| `kept` | 200 (10-5000). Ended runs remembered; a running run is never dropped. |

## Data it reads and writes

Reads and writes `drover.runs`.

## Needs

`drover-agents` or Board/Tasks start the runs it lists.

Works alone: It opens fine alone and stays empty until a run exists.

## Limits

Stop takes two clicks and kills the run's terminals; worktrees are never removed. A stopped agent shows "stopped: check the result", never "done".

## Rebuild it

[`RECIPE.md`](../../mods/drover-runs/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
