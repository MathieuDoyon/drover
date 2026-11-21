# Tasks

`drover-tasks`. The right-hand attention panel: one row per task grouped as Needs you, Ready for review, Working, Ready and Blocked, with a filter box (Enter adds a task). It also holds the `drover` command-line tool agents use.

![Tasks](../../mods/drover-tasks/preview.png)

## Open it

In the `drover` layout it is the bottom of the right column. Alone: `herdr-app do pane.split '{"direction":"right","mod":"drover-tasks"}'`.

## Settings

Change them in Drover Config (see [Configuration](../configuration.md)).

| Setting | Meaning |
| --- | --- |
| `enabled` | Drover Config → `enabled` (on by default). Off hides the screen and blanks it; the data and the `drover` CLI stay. |
| `machine_polling` | Drover Config → Tasks → Machine health (**off by default**, applies at once). On, the Machines section reads each linked machine every 5 minutes. See [Machines](#machines). |

## Machines

Below the task groups, a collapsible **Machines** section lists every machine `hc machine ls` knows (the list is local and is read every 30 seconds): a link dot, the name, and one meter line such as `load 0.4/core · mem 61% · disk home 40%` with a thin bar for the highest of the three. The bar is a neutral gray scale; it means nothing about holds or limits.

- **Off by default.** With `machine_polling` off the rows show the name, the link and `polling off`, no numbers, and nothing runs on any machine.
- **On**, one short read per connected machine every 5 minutes (a machine whose read failed is retried after 10 minutes; never two reads at once for one machine). The read runs a fixed, secret-free Python script (see [the machines guide](../guides/machines.md#machine-health)) through `hc exec --on`. Only these numbers leave the machine: load, memory, and the disk use of the home directory and `/tmp`. Nothing a machine prints is stored or shown.
- **Failed or offline.** The last good numbers stay, dimmed, with `last read 12 min ago, failed` (or `offline, last read …`). A machine with no good read yet says `waiting for the first read`; one without `python3` says `python3 missing on this machine`. If the list itself cannot be read the header says `list unknown` and no machine is polled from a list older than 5 minutes.
- Render only reads this cache; a timer does the reads. The cache lives in memory, so after the window reopens the first read happens as soon as polling is on.

## Data it reads and writes

Reads and writes `drover.tasks`; filters are saved per space (`drover.tasks.filters`). `bin/drover` reads `<home>/shared.json` and writes requests to `<home>/data/drover-inbox`.

`drover doctor` checks the install and changes nothing: one line per check (`ok`, `WARN`, `FAIL` or `skip`, then the check name and a short detail) and a summary line. It looks at the mod links in the home, the shared `_lib` copies, the soul files, a hint that a running Herdr may hold older shared code (the `_lib` fingerprint against the stamp `install.sh` wrote; the answer is to reopen the window, and it is not probed), and whether `drover` on your `PATH` is this file. Exit 0 means no `FAIL` (a `WARN` or `skip` does not fail); exit 1 means a `FAIL`. It needs no Herdr and prints no paths, file content or environment values. Two more lines, `hooks-claude` and `hooks-codex`, read your agent hook config (`~/.claude/settings.json`, `~/.codex/hooks.json`; `--claude-settings <file>` and `--codex-hooks <file>`, or `DROVER_CLAUDE_SETTINGS` and `DROVER_CODEX_HOOKS`, choose other files) and look only for Drover's `drover-asks-hook` entries: `skip` when the file or any such entry is absent (nothing in Drover installs one), `ok` when every event of the set calls an existing, executable script, `WARN` when an event is missing, unknown, has the wrong action, or the script is gone. A third line, `hooks-locks`, is a `WARN` when a lock folder of the hook in `<home>/data/drover-asks` is older than 10 seconds (a hook stopped in the middle of a write; the next hook reclaims it by age alone), `ok` otherwise, and `skip` when that folder does not exist yet. The checks need `node` and never print a path or any file content.

The asks hook is killed by its own launcher after 3 seconds and a lock goes stale after 10, so a stale lock always comes from a hook that died. Stated plainly: a system suspend or a clock jump in the middle of a write can make a live lock look stale and let two writers overlap; the worst case is one wrong or lost reason, and the reader (a reason shows only while Herdr reports the agent blocked; an ask older than 30 minutes is ignored) covers it.

## Live line on a Working row

A Working card whose run has a live line (`drover line <T-…> "<text>" [--progress n]`, run by an agent of that run) shows it under the id row instead of the reason: `reading the code · 40% · 3m`. A line older than 10 minutes is dimmed, and it is gone when the run ends. A card of another machine never shows one, and there is no time-left estimate. The command, its checks (length 40, progress 0 to 100, no secret-shaped text or home path; the scan is best effort) and the self-reported terminal check are on the [Runs page](runs.md#live-line). The line is derived with the groups (at start and every second); the row only reads it.

## Needs

`drover-todos` (editor), `drover-agents` (▶ picker). The CLI needs `bash`, `python3`, and `hc` for wakeups.

Works alone: Lists and filters tasks alone. Without an open Tasks, Board or Wakeups mod, CLI writes stay `queued`.

## Limits

One card is in one group, by this order (first match wins): archived or Done: none; an agent that is starting: Working; an agent whose terminal asks (blocked), in any open column: Needs you; Blocked column: Blocked (parked, last group, not counted); Review column: Ready for review; In progress with an agent whose terminal is gone: Needs you; an agent working: Working; an agent on a live terminal that stopped, went idle or reports no status: Working; In progress with no agent: Working; else Ready (a gone agent on a Ready card is still Ready). So `Needs you` holds only what waits on you now: an agent that asks beats the Blocked column and Review, and neither the Blocked column nor Review is counted there. Reasons are at most 40 characters. The groups, dots and remote ✓ state are derived outside render (when the panel starts and every second) and render only reads them. The `Needs you` number (cards plus failed wakeups, see [Needs you](needs.md)) is shown in the switch tab on top of the `drover` column and in the tab-bar chip (the count ignores your filters; the group header in the panel shows the filtered count). Herdr has no tab or sidebar badge API (only the Dock icon text), so there is no badge. A 300px right panel (`place: right`). The ✓ on a review row moves the card to Done; the ▤ beside it opens the [proof panel](#proof-panel). The filter menu never defaults to hiding anything. In a narrow pane the rows truncate.

## Proof panel

The ▤ icon on a Review row (left of the ✓) opens a read-only dialog, hosted by `drover-todos` like the card editor, with what you need before you approve: the summary and the last `handoff` note, the commits and files of the change, the PR checks on its head commit, the Inspector's verdict, and the proof artifact. It loads when it opens and on Refresh (which re-reads the card from the store: a card that is gone or moved shows "Card not found here"), never while it draws. It merges, moves, syncs and writes nothing, and the **Accept** button is disabled ("Accept ships in B3b"); the ✓ stays as it is until Accept ships. A card of another machine has the icon off ("Proof reads this machine only").

- **Checks are green only when at least one check ran and every one succeeded on the head commit.** Pending, queued, missing, empty, red, cancelled, skipped, neutral, unknown, a failed `gh` call and "no PR" all show **NOT green**, with the reason.
- **One head commit (A).** The PR head, its checks and its base commit come from one `gh pr view` (the base from `gh api` when this `gh` does not offer it, never from a local `origin/<base>`). The commits and files are listed from those commit ids only, and show "unavailable" (never a fetch, never a substitute) when a commit is not in the local clone. With no PR in any state, A is the worktree HEAD commit, read once, and the checks are NOT green ("No PR: no checks"); a gone worktree means A is unknown.
- **Which PR.** A PR URL on the card (its source, or a `pr` note), or a `pr` note that names the PR by number (written `PR #5`, `pull request #5` or `pull/5`, read in the repo `gh` resolves from the clone), is the PR. Only these PR-qualified forms count: a bare `#5` is ignored (it could be an issue), so write `PR #N` in the note to be recognized. An unresolved reference is unknown, never "no PR"; a branch search (`gh pr list --head <branch> --state all`, for the repo `gh` reads from the clone) is only for a card that names none. Two matches, two different PR references, or a source and a `pr` note that disagree, are unknown. A merged or closed PR is shown with its state.
- **Which login.** Every `gh` call runs as argv through `/usr/bin/env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN -u GH_CONFIG_DIR -u GH_HOST -u GH_REPO gh …` (no shell), so it uses the login Herdr's own `gh` stored, never a token handed down from the process that started it. Without `/usr/bin/env` no `gh` call is made. No login shows "unknown (gh not logged in)". The dialog shows the login `gh` resolved ("Reading as …") and says it cannot prove who owns it. Errors are shown as one of `auth`, `offline`, `not-found`, `unexpected`, never as raw text.

### The review note

The Inspector (or you) records a verdict with `drover note <T-…> --kind review "head=<40-hex commit> verdict=pass|adverse report=<absolute path>"`; a path with spaces is quoted (`report="/a b/review.md"`). A text that does not parse is refused, on add, edit and import. The newest review note decides; its `head` is the commit it reviewed, so a review of another head is shown **Stale** (never as a pass), and none or a malformed one is "No review". An optional `proof=<absolute path>` line in the newest `pr` or `handoff` note names the proof artifact. Both paths open on click.

### The evidence contract (frozen for B3b)

`mods/_lib/evidence.js` builds it (`buildEvidence`, deep-frozen); `evidence.test.js` snapshots the keys, so a change is a deliberate break for the Accept action.

| Key | Meaning |
| --- | --- |
| `v` | Contract version, `1`. |
| `repo` | `owner/name` the PR belongs to, or `null`. |
| `pr` | `{ state: "found", number, url, prState }`, `{ state: "none" }` (a successful lookup found no PR in any state), or `{ state: "unknown", reason }` (a failed or ambiguous lookup; blocking). |
| `base`, `baseSha` | The PR's base branch name and its base commit id (`null` when not known: Accept must refuse). |
| `head`, `headSource` | Head commit A (full 40-hex id) and where it came from, `"pr"` or `"worktree"`; both `null` when it cannot be proven. |
| `checks` | `{ green, reason, items: [{ name, state }] }`. |
| `verdict` | `{ state: "pass"\|"adverse"\|"missing"\|"stale", head, by, at, report, was }`. |

The statuses on a PR have no commit id of their own: they are valid for A because they are read in the same call as A. Accept must read again and compare at the moment of the click.

## Rebuild it

[`RECIPE.md`](../../mods/drover-tasks/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
