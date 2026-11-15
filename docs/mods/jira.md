# Jira

`drover-jira`. A read-only list of Jira work from a saved JQL, with `+ Board` to make a linked card.

## Open it

`herdr-app do tab.new --name Jira --mod drover-jira`, or the Sources preset (`Drover ▾`).

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `enabled` | Drover Config → `enabled` (on by default). Off hides the screen and blanks it; the data and the `drover` CLI stay. |
| `site` | Empty. Your Jira host, for example `acme.atlassian.net`. Empty means not configured: the screen asks for it and makes no request. |
| `jql` | `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`. The default query. |
| `pages` | 4 (1-20). Pages of 50 issues fetched before the list is marked partial. |
| `refresh_minutes` | 5 (1-1440). How often the list reloads. |

## Data it reads and writes

Reads `~/.config/drover-herdr/atlassian.json` (`email`, `apiToken`, mode 0600) and talks only to the configured site. `+ Board` writes `drover.tasks`.

## Needs

The credential file: see the [Jira setup guide](../guides/jira-setup.md).

Works alone: Yes, and nothing else needs it.

## Limits

Read-only. It reaches the network. With no site it makes no request.

## Rebuild it

[`RECIPE.md`](../../mods/drover-jira/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
