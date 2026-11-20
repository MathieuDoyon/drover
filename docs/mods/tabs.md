# Drover Tabs

`drover-tabs`. The tab bar of the `drover` layout: capsule tabs with agent status, the `Agents N` selector, the `Drover ▾` menu (open a screen, split, or open a two-screen preset) the Tasks toggle and the Needs you chip.

![Drover Tabs](../../mods/drover-tabs/preview.png)

## Open it

Only through the `drover` layout: `herdr-app do layout.switch '{"name":"drover"}'`.

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `(none)` | No `enabled` switch. The `cmd-alt-b` shortcut (section `layout:drover`) toggles the right column; set it in Drover Config → Shortcuts. |

## Data it reads and writes

Reads `drover.runs` and the Herdr spaces, panes and agents; reads each screen's `enabled`.

## Needs

The shipped Herdr `menu` and `new-menu` mods. It opens every other Drover screen by name and `drover-config` for Settings.

Works alone: Only useful inside the `drover` layout.

## Limits

A screen is listed only when its `enabled` is on. A missing mod's entry opens an empty tab. A chip with the number of cards that need you shows beside `Tasks` (hidden at 0); a click shows the `Needs you` page of the `drover` column (the column too, if hidden). Herdr has no tab or sidebar badge API, so the number lives in this chip and in the `drover-switch` tab.

## Rebuild it

[`RECIPE.md`](../../mods/drover-tabs/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
