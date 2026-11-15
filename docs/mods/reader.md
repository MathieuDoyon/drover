# Reader

`drover-reader`. A read-only, live transcript of a Claude Code or Codex terminal, with agent chips and Back to terminal.

## Open it

`herdr-app do tab.new --name Reader --mod drover-reader`, or `Drover ▾ → Reader`.

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `enabled` | Drover Config → `enabled` (on by default). Off hides the screen and blanks it; the data and the `drover` CLI stay. |
| `max_text` | 4000 (200-100000). Longer entries are cut and end with an ellipsis. |

## Data it reads and writes

Reads the agent CLIs' transcript files (found with `find` and the terminal's `revive.session` label). Writes nothing.

## Needs

A Claude Code or Codex terminal.

Works alone: Yes.

## Limits

It never sends input. It reads files outside its own folder (the CLIs' transcript folders under your home). It refreshes every 5 seconds.

## Rebuild it

[`RECIPE.md`](../../mods/drover-reader/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
