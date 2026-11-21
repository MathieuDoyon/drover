# Configuration

Open **Drover Config**: `Drover ▾ → Config`. Left: the mods; right: one row per setting with its help line, a field, and `Reset`. An invalid value is explained under its row and never written. Only the values you change are saved (shared key `drover.config`); a setting you never touched follows the default, or the `settings` block of the mod's `mod.json`.

Settings marked *reopen* apply the next time the screen opens; every other setting applies live.

## General

| Setting | Default | Meaning |
| --- | --- | --- |
| Work folder | `project` | `project` or `repo`: where agents write plans and reviews. See [Agents](agents.md#the-work-folder) |

## Per mod

Each mod also has an `enabled` switch (default on; off hides the screen only). `drover-config`, `drover-tabs` and `drover-newtask` have none.

| Mod | Setting | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| Agents | `default_squad` | empty | a squad id | Squad the Start picker selects first |
| Agents | `default_worktree` | off | | Start with Own git worktree ticked |
| Agents | `default_report` | off | | Start with Report to Drover ticked |
| Board | `visible_columns` | all 6 | at least one | Columns shown (screen only) |
| Board | `default_sort` | `manual` | `manual`, `priority`, `newest` | Column sort |
| GitHub | `query` | `is:issue state:open` | | Default search |
| GitHub | `scopes` | empty | | Orgs or `owner/repo` shown when none were added |
| GitHub | `limit` | 100 | 1-1000 | Most items per scope |
| Jira | `site` | empty | host name | Your Jira host; empty = not configured, no request |
| Jira | `jql` | `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` | | Default query |
| Jira | `pages` | 4 | 1-20 | Pages of 50 issues |
| Jira | `refresh_minutes` | 5 | 1-1440 | Reload interval |
| Room | `refresh_minutes` | 5 | 1-1440 | Minimum age before a run's context reloads |
| Room | `pr_cap` | 10 | 1-100 | Linked PRs shown |
| Room | `kept_contexts` | 30 | 1-1000 | Runs remembered |
| Tasks | `machine_polling` | off | | Show a load meter for each linked machine in the Tasks sidebar. On, one short read per machine every 5 minutes through `hc exec --on` (10 minutes after a failed read). Off: the machine list shows with no numbers and no read. See [Tasks](mods/tasks.md#machines) |
| Runs | `max_parallel` | 2 | 1-10 | Active squad runs per project. Runs on cards in Review or Blocked are waiting and do not count. An agent can set it on your request with `drover config max-parallel <n>` (the only setting it can change); see [Runs](mods/runs.md#parallel-runs) |
| Runs | `kept` | 200 | 10-5000 | Ended runs remembered |
| Wakeups | `min_repeat_minutes` | 5 | 1-1440 | Shortest repeat (the CLI uses it too) |
| Wakeups | `expiry_hours` | 2 | 1-168 | A wakeup not delivered by then expires |
| Wakeups | `ui_tick_seconds` | 30 | 1-3600 | Countdown repaint (*reopen*) |
| Todos | `context_refresh_seconds` | 60 | 5-3600 | Run and PR context reload (*reopen*) |
| Todos | `pr_cap` | 10 | 1-100 | PRs listed under a task |
| Todos | `run_history_cap` | 10 | 1-100 | Past runs listed under a task |
| Todos | `wake_cap` | 20 | 1-200 | Wakeups listed under a task |
| Reader | `max_text` | 4000 | 200-100000 | Longest transcript entry |

## Shortcuts

Drover Config → Shortcuts writes your `keys.json` only when the file is valid JSON in the standard 2-space format, and never replaces a key. If the combo is already bound to something else in `keys.json` (any section that would mask it), the switch refuses and tells you to free that key first; edit `keys.json` yourself, then switch it on. Turning a shortcut off removes only Drover's own binding. Defaults: `cmd-alt-b` (toggle the right column, section `layout:drover`) and `cmd-shift-c` (create a task, section `global`, runs `mod.open:drover-newtask`).

The authoritative list of settings is `mods/_lib/config-schema.js`.
