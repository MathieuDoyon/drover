# Jira

`drover-jira`. A read-only list of Jira work, filtered with a search box of inline tokens that build the JQL, with `+ Board` to make a linked card.

## Open it

`herdr-app do tab.new --name Jira --mod drover-jira`, or the Sources preset (`Drover ▾`).

## Filter

Click the box and a menu lists the keys: Project, Status, Assignee, Reporter, Type, Label, Priority, Sprint, Created, Updated and Sort, then AND, OR, Exclude and Reset filter. Type to narrow them (`ass` finds Assignee). After a key (`assignee:`) the menu offers Me, Unassigned, Exclude, then people, statuses, projects and so on from Jira. A pick becomes one token. Press Enter to load. Type `key:value` and a space to make a token by hand; type a date as `created:>2026-01-01`, a sort as `order:updated-desc`.

- Tokens are joined with AND. `OR` joins the clauses beside it. `Exclude` gives `!=` (or `NOT`).
- Every value is quoted for JQL, so a value cannot add its own JQL.
- The default is your `jql` setting as one raw token, `jql:"..."`, so the default list is unchanged. The query is saved and `↺ Defaults` brings the default back.
- A query saved before this filter (the plain JQL box) becomes that `jql:` token once.
- The menu lists come from Jira (cached 5 minutes). With the screen off or no site, nothing is requested.

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `enabled` | Drover Config → `enabled` (on by default). Off hides the screen and blanks it; the data and the `drover` CLI stay. |
| `site` | Empty. Your Jira host, for example `acme.atlassian.net`. Empty means not configured: the screen asks for it and makes no request. |
| `jql` | `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`. The default query, shown as one `jql:` token. |
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
