# Drover Config

`drover-config`. One dialog for the settings of every Drover mod, the Work folder and the shortcuts.

## Open it

`Drover ▾ → Config` (in the `drover` layout).

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `(none)` | It is the settings screen: no `enabled` switch. |

## Data it reads and writes

Writes only `drover.config` (the values you changed) and `keys.json` (Shortcuts: it refuses a key that is already bound and says to free it first; it never replaces one). Reads every mod's `mod.json` settings.

## Needs

Nothing required. A setting of an uninstalled mod lists but has no effect.

Works alone: Yes.

## Limits

Invalid values are explained and never written. Timer settings apply when the screen reopens. See [Configuration](../configuration.md).

## Rebuild it

[`RECIPE.md`](../../mods/drover-config/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
