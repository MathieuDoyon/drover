# GitHub

`drover-github`. A read-only list of every open issue and pull request in the orgs and repos you add, with a filter menu and `+ Board` to make a linked card.

## Open it

`herdr-app do tab.new --name GitHub --mod drover-github`, or the Sources preset (`Drover ▾`).

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `enabled` | Drover Config → `enabled` (on by default). Off hides the screen and blanks it; the data and the `drover` CLI stay. |
| `query` | `is:issue state:open`. The search used when no filter was committed, and by Reset filter. |
| `scopes` | Empty. Orgs or `owner/repo` shown when none were added. |
| `limit` | 100 (1-1000). Most issues and PRs fetched for each scope. |

## Data it reads and writes

Runs `gh search issues` and `gh api`. Reads and writes its saved scopes and filter in shared state; `+ Board` writes `drover.tasks`.

## Needs

The GitHub CLI `gh`, logged in.

Works alone: Yes, to browse. `+ Board` cards need Board/Todos to be seen.

## Limits

Read-only: it never writes to GitHub. Not supported by `gh search issues`: Parent issue, Blocking, Blocked by, Relates to, Sub-issue, Has author. The filter menu assumes the caret is at the end of the text.

## Rebuild it

[`RECIPE.md`](../../mods/drover-github/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
