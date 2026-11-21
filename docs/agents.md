# Agents and the herd

In Drover the herd is your tasks, and each squad is a **drive**: one task, one trail, one leader. An agent is a command (`claude …`, `codex …`) with a soul (a Markdown file describing who it is and how it works).

## The default herd

Squads → **Add default herd** adds these (it never changes yours). ▶ on any agent or squad starts it with no task.

| Agent | Soul | Command | Job |
| --- | --- | --- | --- |
| Drover | `drover.md` | Claude Opus, high effort | Coordinator: plans a group of tasks, starts drives with `drover start`, watches, unblocks, reports. Writes no product code |
| Trail Boss | `trail-boss.md` | Claude Sonnet | Leads a Cattle Drive: plan, relay, run the checks, gate the review, babysit the PR |
| Wrangler | `wrangler.md` | Claude Sonnet | Writes the code, test first. Leads a Stray Roundup |
| Wrangler 2 | `wrangler.md` | Codex (gpt-6.1-sol, medium) | A second Wrangler on another model: a rival lane in an arena, or a swap-in |
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

## Share a herd and move it to a new machine

Squads → **Export…** and **Import…**, or `drover agents export` and `drover agents import`. A short walk-through: [Share a herd](guides/share-a-herd.md).

**What is exported** (one file, `drover-herdr-agents-<date>.json`): for each agent its `id`, `name`, `soul` (a name), `command` (harness, model and effort) and `instructions`; for each squad its leader and members with roles. A squad brings its agents.

**What is never exported:**

- Environment values and names. The file only says how many variables an agent needs; re-add them on the new machine.
- Soul text. See the limit below.
- Run history, tasks, projects, wakeups, notes.
- Your home folder, where it can be rewritten: a standalone path in a command is written as `~`. Other home paths (for example inside `--config=/home/you/x.json`, or in instructions) can stay in the file with a warning. Read the JSON before you share it.

**Secrets block the export.** The scan looks at `command`, `instructions`, `name` and roles for token, key and private-key shapes (plus `--api-key`/`--token` flags, `AKIA…` and long `Bearer` values). A hit shows the agent, field and rule, never the value, and no file is made: edit the agent and export again. The scan is best effort, so read the text before you share it. Import runs the same scan on a friend's file and blocks only the rows that hit.

**Soul limitation.** A soul travels as a name plus a hash, not its text. The soul files are the ones installed with the mod on each machine (`mods/drover-agents/souls/`). On import, a soul name you do not have becomes "no soul" (only the instructions apply, and you must tick the warning). A soul with the same name but different text keeps your file and shows a warning. So an export means same agents, same commands, same instructions, not the same soul text.

**Import merges, it never replaces.** The preview lists `add`, `skip` (identical), `copy` (new id `<id>-2`) or `overwrite` per row, and nothing is written until Apply. A clash defaults to keep yours. An overwrite of an agent that has an environment needs a tick, and an id that already has an orphan environment file blocks the row. Added and copied agents start with no environment. An overwrite keeps the agent's existing environment, so the imported command and instructions run with it. The preview shows every command in full: an imported agent runs it on your machine, so read it first.

**CLI.** `drover agents import <file>` is a dry run that prints the plan and a token. `--confirm <token>` applies it, only if the file and your herd are unchanged. The CLI adds, skips and keeps yours; copy and overwrite are in the Squads screen. It needs Drover mods with protocol 4.

**`queued` is not restored.** When no Tasks, Board or Wakeups mod is open (a headless machine), an import answers `queued:` and applies later, when a mod opens, and not at all after 1 hour or if the herd changed. Check `drover squads` before you call it done.

**A headless machine** (for example a Linux box over `hc`): see [Headless machine over hc](guides/share-a-herd.md#headless-machine-over-hc). Set the machine up first: [Remote machines](guides/remote-machines.md).

## The `drover` command-line tool

`~/.config/herdr-app/mods/drover-tasks/bin/drover` (no arguments prints help):

| Command | Does |
| --- | --- |
| `tasks [tag\|column] [--project <id\|name>]`, `task <T-…>` | List tasks, show one |
| `projects`, `squads`, `next` | List projects, squads and agents; show free slots and Ready cards (queue mode) |
| `add "<title>" [--desc …] [--tag …] [--column …] [--priority P0-P3] [--project …] [--parent <T-…>]` | Create a task |
| `move <T-…> <backlog\|ready\|in-progress\|review\|blocked\|done>` | Move a card (an agent never moves to done). The names are the Board's column names; the old `todo` and `doing` still work as input |
| `note <T-…> [--kind decision\|log\|blocker\|pr\|handoff\|review] "<text>"`, `edit`, `link`, `archive`, `task-project` | Notes and edits |
| `project add "<name>" --repo <abs path> [--branch <b>] [--folder <abs path>]…` | Create a project (for a headless Drover); same request again answers `exists` |
| `start <T-…\|-> <squad\|agent> [--worktree]` | Open a squad on a task; its leader reports to `$HC_TERMINAL_ID` |
| `agents export [--out <file>] [--agent <id>]… [--squad <id>]…`, `agents import <file> [--confirm <token>]` | Export or import the herd (import is a dry run until `--confirm`; protocol 4) |
| `config`, `config max-parallel [<n>]` | List, show or set the parallel-runs limit (1-10); the owner's call, see [Runs](mods/runs.md#parallel-runs); protocol 5 |
| `wake <t\|T-…> <when> "<msg>"`, `wake … every <30m\|2h\|1d> "<msg>"`, `wakes`, `wake off\|on\|rm <W-…>` | Wakeups |

Reads come from `shared.json`. Writes go to `<home>/data/drover-inbox`; an open Tasks, Board or Wakeups mod applies them (otherwise: `queued`).

## The work folder

Where agents write plans, scouts, reviews and lane logs. Drover Config → General → Work folder: `project` (default, `~/.config/drover-herdr/work/<project id>/`) or `repo` (`<repo>/.drover/`). Every launch prompt carries the resolved absolute path, and the souls use it. A folder outside the repo is created with mode 0700. Existing `.drover` files are never moved automatically: in `project` mode use the "Move existing .drover files here" button, or by hand:

```sh
~/.config/herdr-app/mods/drover-agents/bin/drover-workfolder move <repo>/.drover ~/.config/drover-herdr/work/<project id>
```

It never overwrites and lists the names that already exist.

## Lane log

Each card has `<work folder>/lane-<T-id>.md`. `drover-agents/bin/drover-lane log <lane file> <EVENT> --who <role> [text]` appends one timed line (the helper takes the time, under `flock`, append only); the Trail Boss, Wrangler and Inspector log through it, and Drover logs the owner and chain events.
`drover-lane report <lane file> [--json]` gives the per-phase minutes of each PR cycle (build, owner wait, PR to merge, merge to done, start to done) and the busy time per member. Events and format: `souls/_herd.md`, "Lane log timing".

## Lessons writer

`drover-agents/bin/drover-lessons <verb> <scope>` is the only writer of the lessons files (format: `mods/_lib/lessons.js`). Scope is exactly one of `--org <slug> [--kind lessons|workflows|squads]` (`orgs/<slug>/<kind>.md`), `--project <id>` (`projects/<id>/lessons.md`) or `--agent <id>` (`agents/<id>.lessons.md`) under `~/.config/drover-herdr` (`--config <abs dir>` overrides it). It opens no other file.

| Verb | What it does |
|---|---|
| `check` | Validates a candidate (format, secret scan, duplicate title when a scope is given). Writes nothing |
| `add [--source <id>]` | Appends a new entry; prints its id and token |
| `edit <id> --expect <token>` | Replaces the text, keeps id, added and source, clears `confirmed` |
| `rm <id> --expect <token>` | Removes the entry |
| `confirm <id> --expect <token>` | Sets `confirmed` to today (refused on an undated entry) |
| `list [--full]`, `stale [--days N]` | Entries with their tokens; the entries not confirmed (else added) for N days (default 90), or undated |

Guarantees: the text comes on stdin (4096 bytes at most) or from a private `--text-file`, never argv, and is never printed. A refusal names the rule, never the value. Writes hold an `flock`, replace the file atomically and keep the old one as `.<file>.prev`; dirs are 0700 and files 0600; a symlink or a hardlink anywhere is refused. `--expect` is the SHA-256 of the entry as the owner saw it (`list` prints it): if the entry changed or is gone, the writer exits 2 with `stale: re-review` and changes nothing. Dedup refuses an exact normalised-title duplicate. The secret scan fails closed on token prefixes, `Bearer`, JWTs, key blocks, credentials or query strings in URLs, long hex or base64 runs, emails, code fences, more than 3 body lines and more than 400 characters. **A scan cannot prove an entry is clean**: the owner reads the exact text before anything is added. Lessons are never part of the herd export.

## Optional: an agent with its own GitHub account

See the [agent identity guide](guides/agent-identity.md) (for example a reviewer that approves PRs). You run it yourself; no agent handles the token.
