# Getting started

After [installing](install.md), switch to the layout: `herdr-app do layout.switch '{"name":"drover"}'` (back: `'{"name":"main"}'`).

## First run

1. Open **Squads** (`Drover ▾ → Squads`) and click **Add default herd**. It adds the built-in agents and squads and never changes yours.
2. Open **Projects** (`Drover ▾ → Projects`) and click **New**: a name, one or more git repositories (the first is the default), and the base branch (default `main`).
3. Open the **Board** (`Drover ▾ → Board`).

## How to

### Create a task

Press the create-task shortcut (below), or `+ New` on the Board or Todos, or type a title in the Tasks panel and press Enter. In the dialog pick a priority, column, tags and a project.

### Start a drive on a task

A drive is one task, one squad, one leader. On the Board (or in the Tasks panel) click ▶ on a card, pick an agent or a squad, tick **Own git worktree** to keep the work in its own branch, and start. The run shows in **Runs**; the leader reports to the Drover or to you. Agents move the card (`drover move`) and write notes on it. Only you move a card to Done. See [Agents and the herd](agents.md).

### Choose where agents write their plans (work folder)

Drover Config → General → **Work folder**:

- `project` (default): `~/.config/drover-herdr/work/<project id>/`, shared by every run of the project so later runs read earlier plans and reviews.
- `repo`: `<repo>/.drover/` (or `<worktree>/.drover/` for a worktree run).

A run without a project uses `work/_free/`. The setting applies to runs started after the change. In `project` mode the dialog offers "Move existing .drover files here" with a confirm step. It never overwrites.

### Turn GitHub or Jira on or off

Each screen has an `enabled` switch in Drover Config (one section per mod). Off hides the screen from the Drover menu and blanks it; no request is made, and your data and the `drover` CLI stay.

- **GitHub** needs `gh auth status` to pass. Add an org or `owner/repo` scope in the screen.
- **Jira** needs the [credential file](guides/jira-setup.md) and your site (Drover Config → Jira site, for example `acme.atlassian.net`). With no site the screen asks for it and makes no request.

To link a card to an issue, use `+ Board` on an issue row, or `drover link <T-…> <issue URL>`, or the Link issue action in the task dialog.

### Keyboard shortcuts

Drover Config → **Shortcuts** writes two keys into your `keys.json`. It never replaces a key you already use: if the combo is taken it refuses and tells you to free it first. It also leaves a `keys.json` that is not valid JSON in the standard 2-space format untouched:

| Action | Default key | Section |
| --- | --- | --- |
| Toggle the right (Tasks) column | `cmd-alt-b` | `layout:drover` |
| Create a task from anywhere | `cmd-shift-c` | `global` |

Board keys (click the board first): arrows select, shift+←/→ move a card, enter edit, `n` new, `s` start.

### Schedule a message to an agent

Wakeups → `+`, or in a terminal `drover wake <terminal|T-…> <when> "<message>"` (`15m`, `14:30`, `"tomorrow 9:00"`) and `drover wake … every 2h "<message>"`. It is delivered only when the agent is idle. See the [Wakeups page](mods/wakeups.md).

### Use the agent CLI

`~/.config/herdr-app/mods/drover-tasks/bin/drover` (no arguments prints help). Started agents get its path in their prompt. An agent in a run says what it is doing with `drover line <T-…> "<text, 40 characters at most>" [--progress n]`: the line shows on the run card and the Tasks row, and goes when the run ends (see [Runs](mods/runs.md#live-line)).
