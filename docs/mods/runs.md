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
| `max_parallel` | 2 (1-10). Squad runs active at once for each project. A card in Review or Blocked keeps its slot while its run is active. Set it in `Drover ▾ → Config` (Runs), or an agent can set it on your request: see [Parallel runs](#parallel-runs). |
| `kept` | 200 (10-5000). Ended runs remembered; a running run is never dropped. |

## Parallel runs

When a start is refused with `no free slot: limit N reached`, the limit is `drover-runs.max_parallel`. It is machine-wide, counts each project on its own, and applies at once (no restart). Lowering it never stops a run that is already going; it only refuses new starts.

You can raise it in `Drover ▾ → Config → Runs → Parallel runs`, or ask an agent to. The agent runs, in its terminal:

```
drover config                    # the settings an agent may change, with the value in force
drover config max-parallel       # show
drover config max-parallel 4     # set (1-10)
```

This is the only setting an agent can change, and the rule for agents is to do it only when you ask, in plain text in its own terminal, never to unblock itself. Each change shows a notice with the terminal that asked (the terminal is what the caller claims; it is not verified). `drover config` needs Drover mods at protocol 5: with older mods it says to update them, and with no Drover mod open it changes nothing. A change that gets no answer within 5 seconds is reported as not confirmed, and the request expires after 60 seconds.

## Data it reads and writes

Reads and writes `drover.runs`.

## Resume squad

An ended run whose card is not Done or archived has **Resume squad**; while an attempt runs it shows **Cancel resume**; after a crash it shows **Resume needs recovery** with **Recover** and **Cancel** (nothing recovers by itself). What it does, and when it refuses, is on the [Room page](room.md#resume-a-gone-squad). A resumed run keeps its history: the old run has `resumedBy` and is not touched by the orphan reaper.

## Needs

`drover-agents` or Board/Tasks start the runs it lists.

Works alone: It opens fine alone and stays empty until a run exists.

## Limits

Stop takes two clicks and kills the run's terminals; worktrees are never removed. A stopped agent shows "stopped: check the result", never "done".

## Rebuild it

[`RECIPE.md`](../../mods/drover-runs/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
