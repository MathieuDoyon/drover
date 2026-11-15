# Drover documentation

Start with the [README](../README.md) for what Drover is. Then:

| Read | When |
| --- | --- |
| [Install](install.md) | Setting up a new computer (requirements, install, check, update, remove) |
| [Getting started](getting-started.md) | First run and the everyday how-tos: work folder, Jira/GitHub on and off, shortcuts, create a task, start a drive |
| [The drover layout](layout.md) | What the window looks like and how to switch to it |
| [Agents and the herd](agents.md) | Default agents, souls, squads, the `drover` command-line tool, the work folder |
| [Configuration](configuration.md) | Every setting in Drover Config |
| [Development](development.md) | Layout of the repo, tests, recipes, renaming |

## The mods

Each mod has a page: what it does, how to open it, its settings, the data it touches, what it needs, and its limits. A mod works alone unless its page says otherwise; the pages name what each one needs.

| Mod | Group | What it does |
| --- | --- | --- |
| [`drover-todos`](mods/todos.md) | Work | The full task list, search, and the create/edit dialog every screen uses |
| [`drover-board`](mods/board.md) | Work | Backlog, Ready, In progress, Review, Blocked, Done: drag cards, start an agent with ▶ |
| [`drover-tasks`](mods/tasks.md) | Work | Right-hand attention panel (Needs you, Ready for review, Working, Ready) and the `drover` CLI |
| [`drover-newtask`](mods/newtask.md) | Work | A key that opens the Create task dialog from anywhere |
| [`drover-projects`](mods/projects.md) | Work | Projects: name, repos, folders and base branch that tasks and runs point at |
| [`drover-agents`](mods/agents.md) | Agents | Agents (command + soul), squads (leader + members), the default herd and the Start picker |
| [`drover-runs`](mods/runs.md) | Agents | Every run with its members' live status: Open room, Focus, Stop, Forget |
| [`drover-wakeups`](mods/wakeups.md) | Agents | Scheduled messages to an agent or a task's agent |
| [`drover-room`](mods/room.md) | Agents | Right panel for the run you are in: issue, PRs, wakeups, squad |
| [`drover-reader`](mods/reader.md) | Agents | Live read-only transcript of a Claude Code or Codex terminal |
| [`drover-github`](mods/github.md) | Sources | Read-only list of open issues and PRs in the orgs you add (`gh`) |
| [`drover-jira`](mods/jira.md) | Sources | Read-only list of Jira work from a saved JQL |
| [`drover-tabs`](mods/tabs.md) | Shell | Tab bar of the `drover` layout: capsule tabs, agent status, the Drover menu |
| [`drover-config`](mods/config.md) | Shell | Drover Config: settings, Work folder and shortcuts in one dialog |

## Guides

- [Jira setup](guides/jira-setup.md): create the private credential file for `drover-jira`.
- [Agent identity](guides/agent-identity.md): let an agent act as its own GitHub account.
- [Permanent Drover on a Linux box](guides/omarchy-permanent.md): run Drover as a service (the scripts are in `deploy/omarchy/`).

## Recipes

Every mod and the layout has a `RECIPE.md` next to it (`mods/drover-<name>/RECIPE.md`, `mods/_layouts/RECIPE.md`): the brief an agent can rebuild it from, in the order Herdr's gallery expects.
