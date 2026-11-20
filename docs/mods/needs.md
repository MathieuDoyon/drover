# Needs you

`drover-needs`. One page of the `drover` column that lists only what waits on you now: a card whose agent asks in its terminal, an In-progress card whose agent is gone, and a wakeup that failed or expired in the last 24 hours. The Blocked column and Review are not counted (the Tasks panel shows them in their own groups). Oldest first, all projects, no filters.

## Open it

Click `Needs you N` in the switch on top of the `drover` column, or the `N` chip in the tab bar. Only inside the `drover` layout.

## What you see

A header `Needs you` with the count, then one row per card: the title and a line with the reason (`Agent asks: open its terminal`, `Agent <t…> is gone`, or for a wakeup `Wakeup delivery failed` (it may have arrived) / `Wakeup didn't start`), the id, the project and the machine for a remote card. When nothing waits for you the page says `Nothing needs you`.

## How it behaves

- A row click shows Room + Tasks again, then focuses the card's live agent; a card with no live agent opens its editor; a wakeup row opens the Wakeups screen, where you re-schedule or delete it (the row leaves when you do, or after 24 hours). A remote card never waits on you here: its agent is not a terminal of this machine.
- The cards are the `Needs you` group of the Tasks panel with no filter, plus the failed wakeups, in one list ordered by one time (a card by `created`, a wakeup by when it failed), then key: the count in the header, the switch tab and the tab-bar chip are always the same number. A card is in one group; the order is oldest `created` first, then id.
- The list is derived outside render (when the page starts and every second, because live agent status has no event) and render only reads it.

## Settings

| Setting | Meaning |
| --- | --- |
| `(none)` | No `enabled` switch. |

## Data it reads and writes

Reads `drover.tasks`, `drover.projects`, `drover.runs`, the remote boards cache and the live agents and terminals. Writes nothing. It keeps the remote boards fresh itself (a mod starts the first time it shows).

## Needs

`drover-switch` and `drover-tabs` for the navigation; the layout `drover` with the hidden `drover-needs` block.

Works alone: Only useful inside the `drover` layout.

## Limits

Herdr has no tab or sidebar badge API (only the Dock icon text), so the count lives in the switch tab and the tab-bar chip. Whether the layout shows and hides the pages as designed needs a native check after install.

Remote cards never count here: their agent is cleared on load, and a remote agent that asks is not observable from this machine. The page also delivers due wakeups itself (every 15 seconds), so a failed or expired one shows even when no other Drover view is open.

## Rebuild it

[`RECIPE.md`](../../mods/drover-needs/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
