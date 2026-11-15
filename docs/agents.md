# Agents and the herd

In Drover the herd is your tasks, and each squad is a **drive**: one task, one trail, one leader. An agent is a command (`claude …`, `codex …`) with a soul (a Markdown file describing who it is and how it works).

## The default herd

Squads → **Add default herd** adds these (it never changes yours). ▶ on any agent or squad starts it with no task.

| Agent | Soul | Command | Job |
| --- | --- | --- | --- |
| Drover | `drover.md` | Claude Opus, high effort | Coordinator: plans a group of tasks, starts drives with `drover start`, watches, unblocks, reports. Writes no product code |
| Trail Boss | `trail-boss.md` | Claude Sonnet | Leads a Cattle Drive: plan, relay, run the checks, gate the review, babysit the PR |
| Wrangler | `wrangler.md` | Claude Sonnet | Writes the code, test first. Leads a Stray Roundup |
| Inspector | `inspector.md` | Codex | Reviews code or plans. Never edits |
| Scout | `scout.md` | Claude Sonnet | Leads a Scouting Party: turns a task that is not ready into ready tasks |
| PM, Architect, QA, Security, Writer | `pm.md`, `architect.md`, `qa.md`, `security.md`, `writer.md` | Claude / Codex | The Scoping squad |
| Claude, Codex | (none) | `claude`, `codex --no-daemon` | Plain agents for ad-hoc work |

The souls live in `mods/drover-agents/souls/`; `_herd.md` holds the rules shared by all of them (`hc`, messages, STATUS lines, wakeups, hard rules such as no push without permission).

| Squad (drive) | Leader + members | For |
| --- | --- | --- |
| Cattle Drive | Trail Boss + Wrangler + Inspector | A feature that ends in a PR (use a worktree) |
| Stray Roundup | Wrangler + Inspector | A small fix |
| Scouting Party | Scout + Inspector (plan critic) | Turn an idea into ready tasks |
| Scoping | PM + Architect, QA, Security, Writer, Scout | Scope a larger piece of work |
| Dev + Reviewer | Claude + Codex reviewer | A quick dev and review pair |

Edit or add agents and squads in the Squads screen. Profiles are versioned on save. Agent environment variables are masked: their values go to a private file, never into shared state.

## The `drover` command-line tool

`~/.config/herdr-app/mods/drover-tasks/bin/drover` (no arguments prints help):

| Command | Does |
| --- | --- |
| `tasks [tag\|column] [--project <id\|name>]`, `task <T-…>` | List tasks, show one |
| `projects`, `squads`, `next` | List projects, squads and agents; show free slots and Ready cards (queue mode) |
| `add "<title>" [--desc …] [--tag …] [--column …] [--priority P0-P3] [--project …] [--parent <T-…>]` | Create a task |
| `move <T-…> <backlog\|todo\|doing\|review\|blocked\|done>` | Move a card (an agent never moves to done) |
| `note <T-…> [--kind decision\|log\|blocker\|pr\|handoff] "<text>"`, `edit`, `link`, `archive`, `task-project` | Notes and edits |
| `start <T-…\|-> <squad\|agent> [--worktree]` | Open a squad on a task; its leader reports to `$HC_TERMINAL_ID` |
| `wake <t\|T-…> <when> "<msg>"`, `wake … every <30m\|2h\|1d> "<msg>"`, `wakes`, `wake off\|on\|rm <W-…>` | Wakeups |

Reads come from `shared.json`. Writes go to `<home>/data/drover-inbox`; an open Tasks, Board or Wakeups mod applies them (otherwise: `queued`).

## The work folder

Where agents write plans, scouts, reviews and lane logs. Drover Config → General → Work folder: `project` (default, `~/.config/drover-herdr/work/<project id>/`) or `repo` (`<repo>/.drover/`). Every launch prompt carries the resolved absolute path, and the souls use it. A folder outside the repo is created with mode 0700. Existing `.drover` files are never moved automatically: in `project` mode use the "Move existing .drover files here" button, or by hand:

```sh
~/.config/herdr-app/mods/drover-agents/bin/drover-workfolder move <repo>/.drover ~/.config/drover-herdr/work/<project id>
```

It never overwrites and lists the names that already exist.

## Optional: an agent with its own GitHub account

See the [agent identity guide](guides/agent-identity.md) (for example a reviewer that approves PRs). You run it yourself; no agent handles the token.
