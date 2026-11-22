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

`drover doctor` checks the install and changes nothing: one line per check (`ok`, `WARN`, `FAIL` or `skip`, then the check name and a short detail) and a summary line. It looks at the mod links in the home, the shared `_lib` copies, the soul files, a hint that a running Herdr may hold older shared code (the `_lib` fingerprint against the stamp `install.sh` wrote; the answer is to reopen the window, and it is not probed), and whether `drover` on your `PATH` is this file. Exit 0 means no `FAIL` (a `WARN` or `skip` does not fail); exit 1 means a `FAIL`. It needs no Herdr and prints no paths, file content or environment values. Two more lines, `hooks-claude` and `hooks-codex`, read your agent hook config (`~/.claude/settings.json`, `~/.codex/hooks.json`; `--claude-settings <file>` and `--codex-hooks <file>`, or `DROVER_CLAUDE_SETTINGS` and `DROVER_CODEX_HOOKS`, choose other files) and look only for Drover's `drover-asks-hook` entries: `skip` when the file or any such entry is absent (install is opt-in: see [Asks hook install](#asks-hook-install)), `ok` when every event of the set calls an existing, executable script, `WARN` when an event is missing, unknown, has the wrong action, or the script is gone. A third line, `hooks-locks`, is a `WARN` when a lock folder of the hook in `<home>/data/drover-asks` is older than 10 seconds (a hook stopped in the middle of a write; the next hook reclaims it by age alone), `ok` otherwise, and `skip` when that folder does not exist yet. A fourth line, `hooks-runtime`, is `skip` while no hook is installed; otherwise `ok` when `node` is on the PATH or the runtime file names an existing node, and a `WARN` when neither is true (the hooks then do nothing). The checks need `node` and never print a path or any file content. An `accept-locks` line is a `WARN` when an Accept lock (see [Accept](#accept)) is older than 15 minutes; it counts them and never removes one.

The asks hook is killed by its own launcher after 3 seconds and a lock goes stale after 10, so a stale lock always comes from a hook that died. Stated plainly: a system suspend or a clock jump in the middle of a write can make a live lock look stale and let two writers overlap; the worst case is one wrong or lost reason, and the reader (a reason shows only while Herdr reports the agent blocked) covers it.

**Why an agent asks.** Tasks reads the asks files once a second (a read-only helper, `bin/drover-asks-read`, with a 2 second limit and one scan at a time; it starts when the panel starts, whether or not Runs is open) and the Needs you row of a blocked agent then says `Asks permission · <tool>`, `Question for you` or `Plan to approve` instead of `Agent asks: open its terminal`. Without the hooks installed, or when a scan fails, the row keeps that fallback text. The reader only reads: it never answers, writes or deletes anything. An ask is dropped when its file is cleared, when a newer ask replaces it, or when the agent stops being blocked after it was seen blocked; an ask has no age limit while its terminal exists, and one older than 30 minutes is dropped only when its terminal is gone. Counts and groups never depend on it.

## Asks hook install

`drover asks-hook install | uninstall | status [--claude] [--codex] [--yes] [--claude-settings <file>] [--codex-hooks <file>]` adds the asks hook to your Claude `settings.json` and Codex `hooks.json`. It is opt-in: `install.sh`, the doctor and every mod never run it.

- **What it adds.** Claude: `PermissionRequest`, `Notification` (matcher `permission_prompt|elicitation_dialog`), `PreToolUse` (matcher `AskUserQuestion|ExitPlanMode`) record the ask; `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionEnd` clear it. Codex: `PermissionRequest` records; `PostToolUse`, `UserPromptSubmit`, `Stop` clear. Each entry is one group at the end of its event's list, `type: command`, command `'<HERDR_APP_HOME>/mods/drover-tasks/bin/drover-asks-hook' set|clear`, `timeout` 5 seconds (Claude `SessionEnd` 1, so it keeps its 1.5 s budget). The hook only records why an agent waits; it never answers a prompt.
- **Diff first, then ask.** For each file it prints the exact unified diff and asks `Apply to <file>? [y/N]`. `--yes` skips only the question, never the diff. With no terminal and no `--yes` it prints the diff, writes nothing and exits 2. `n` writes nothing. A CLI whose config folder does not exist is skipped. Files are found with the same rules as the doctor: the flag, `DROVER_CLAUDE_SETTINGS` / `DROVER_CODEX_HOOKS`, `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, then `~/.claude/settings.json` and `~/.codex/hooks.json`.
- **Never overwrites.** Your other keys, hooks, key order, indentation and trailing newline stay. Like `install.sh`, an entry of ours is added, updated or removed only if it is absent or exactly what Drover wrote; an entry that names `drover-asks-hook` but differs is **KEPT**: untouched, reported, exit 1, with the wanted entry printed (no `.new` file is written into `~/.claude` or `~/.codex`). A file that is not valid JSON, has a byte-order mark, is not an object, is over 2 MB, is a FIFO or a dangling link, or that could not be written back byte for byte (comments, odd spacing, duplicate keys) is **refused**: nothing changes and you get the snippet to add by hand. A symlinked file keeps its link and the real file is edited.
- **Backups and the record.** The old file is kept (the old inode is moved, not copied) in `<home>/data/drover-asks-install/backups/`, never in `~/.claude`, never deleted. A record for each file, in `<home>/data/drover-asks-install/`, lets `uninstall` restore the file byte for byte when nothing has changed since, and delete a file install created. If you edited the file since, or the install was ever repaired, `uninstall` removes only our entries and keeps your edits. A second `install` that finds everything in place says `already installed` and writes nothing. One install at a time per home (`<home>/data/drover-asks-install.lock`; a stale lock is named in the refusal and you remove it yourself).
- **A stated limit** (the same as `install.sh`): between our last check and the rename, an editor that saves the file by rename can lose that save. Bytes written in place in that instant are kept as `KEPT-OWNER` in the backups folder. Claude and Codex themselves rewrite these files, so run `install` while they are not saving settings.
- **The runtime file.** The hook runs the node that is on its PATH, else the absolute path in `<home>/data/drover-asks-runtime`. `install` creates that file (equal bytes: no change; other bytes: KEPT, never overwritten) and `uninstall` never removes it and says so. `status` and the doctor line `hooks-runtime` report it as present, absent or differs.
- **Codex.** After an install, Codex asks you to trust the new hook on its first run (`/hooks`); Drover never bypasses that.
- **Limit.** A permission you deny raises no `PostToolUse`, so its ask stays until the next clear or 30 minutes.
- `status` is read-only: per file `not installed`, `installed`, `partial`, `changed-by-owner`, whether a record exists, and the runtime file.

## Live line on a Working row

A Working card whose run has a live line (`drover line <T-…> "<text>" [--progress n]`, run by an agent of that run) shows it under the id row instead of the reason: `reading the code · 40% · 3m`. A line older than 10 minutes is dimmed, and it is gone when the run ends. A card of another machine never shows one, and there is no time-left estimate. The command, its checks (length 40, progress 0 to 100, no secret-shaped text or home path; the scan is best effort) and the self-reported terminal check are on the [Runs page](runs.md#live-line). The line is derived with the groups (at start and every second); the row only reads it.

## Needs

`drover-todos` (editor), `drover-agents` (▶ picker). The CLI needs `bash`, `python3`, and `hc` for wakeups.

Works alone: Lists and filters tasks alone. Without an open Tasks, Board or Wakeups mod, CLI writes stay `queued`.

## Limits

One card is in one group, by this order (first match wins): archived or Done: none; an agent that is starting: Working; an agent whose terminal asks (blocked), in any open column: Needs you; Blocked column: Blocked (parked, last group, not counted); Review column: Ready for review; In progress with an agent whose terminal is gone: Needs you; an agent working: Working; an agent on a live terminal that stopped, went idle or reports no status: Working; In progress with no agent: Working; else Ready (a gone agent on a Ready card is still Ready). So `Needs you` holds only what waits on you now: an agent that asks beats the Blocked column and Review, and neither the Blocked column nor Review is counted there. Reasons are at most 40 characters. The groups, dots and remote ✓ state are derived outside render (when the panel starts and every second) and render only reads them. The `Needs you` number (cards plus failed wakeups, see [Needs you](needs.md)) is shown in the switch tab on top of the `drover` column and in the tab-bar chip (the count ignores your filters; the group header in the panel shows the filtered count). Herdr has no tab or sidebar badge API (only the Dock icon text), so there is no badge. A 300px right panel (`place: right`). The ✓ on a review row opens the [proof panel](#proof-panel) (the Accept steps) and moves nothing; the ▤ beside it opens the same panel. The filter menu never defaults to hiding anything. In a narrow pane the rows truncate.

## Proof panel

The ▤ icon on a Review row (left of the ✓) opens a read-only dialog, hosted by `drover-todos` like the card editor, with what you need before you approve: the summary and the last `handoff` note, the commits and files of the change, the PR checks on its head commit, the Inspector's verdict, and the proof artifact. It loads when it opens and on Refresh (which re-reads the card from the store: a card that is gone or moved shows "Card not found here"), never while it draws. Loading it merges, moves, syncs and writes nothing. The **Accept** button is live only when every gate passes (see [Accept](#accept)). The ✓ on a Review row now opens this dialog instead of moving the card to Done. A card of another machine has the icon off ("Proof reads this machine only").

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

## Accept

The **Accept** button of the proof dialog runs the whole chain on your click, and only on your click. The click is permission for this repo, this PR number and this head commit (A), once. Nothing runs when the dialog opens, on Refresh or while it draws.

1. **Lock.** One atomic `mkdir` of `<Herdr home>/data/drover-accept/<project>__<card>.lock` (a token file inside). Exactly one window wins; the other sees "Another Accept may be running, or one stopped without finishing" and writes nothing. A lock folder that cannot be read or written is not called held: Accept says "Could not take the Accept lock: cannot read or write the lock folder" and the dialog says "Cannot read the lock state"; either way nothing is written and Accept stays off. A double click is one run.
2. **Bind.** The repo, PR number and URL, base branch and base commit, and head A you looked at are frozen on the card as a log note (`accept: bound …`).
3. **Re-read.** Everything is read again. A different head, or any difference in the PR (another PR, a new base, a no-PR branch that gained a PR) means: evidence refreshed, **nothing merged**, you read it and click again.
4. **Merge.** `gh pr merge <PR URL> --squash --match-head-commit A`, as the Herdr `gh` login. Never `--admin`, `--auto` or `--delete-branch`, no push. GitHub refuses it if the head moved.
5. **Read back.** The PR must read **MERGED at A**. Still open (queued, rejected, or a lost answer) is shown as "Not merged: PR still open (queued or rejected, not proven)", never as queued, and the card does not move. **Check again** only reads. A retry is a fresh click through the whole chain.
6. **Source sync** (only after step 5). The linked GitHub issue is closed with its `status:` labels removed, only when every other card on that source (any project, archived included) is Done. Otherwise it is left open and a log note says why. A Jira source is skipped with a note. If the sync fails the merge stands; **Finish** (the button after a restart) retries it, and never merges again.
7. **Done.** The card moves to Done. The order is fixed: read-back, then sync, then Done.

A work item with **no PR** gets the same gates and goes to Done only: no merge, no issue is touched.

**What disables Accept.** *Hard* (no override): PR unknown or unreadable, closed or merged at another commit, a draft, a conflict, checks not green on A (red, pending, missing, skipped, cancelled, neutral or unknown all count as not green), the PR text or any of its commits unreadable (the list must equal the REST count, at most 250), a card of another machine, a changed head or identity, and a **closing keyword** (`close`, `fix`, `resolve` and their forms, followed by `#N`, `owner/repo#N` or the issue URL) in the PR title, body or any commit that names a source other cards still use. *Soft* (a typed reason of 10 to 300 characters on one line, logged on the card as a `decision` note, and only for the codes it covered): no plan approval, and a review of head A that is missing, stale or adverse. Plan approval is the newest `decision` note whose whole text is `plan approved` (or `plan approved: <text>`); a newer `plan withdrawn` revokes it. Finish needs the soft gates too.

**A lock that does not clear.** The app never removes, replaces or "releases" a lock it did not create in the running chain, however old. A lock left by a window that closed mid-chain shows the PR state read-only, the exact lock path and the one command that clears it. Run it yourself only after you confirm no Drover window or process is mid-Accept and you have read the PR state: removing the lock gives up the app's one-at-a-time guarantee, so read the PR first. The merge itself stays safe (`--match-head-commit A`), and the sync and the move are repeatable. `drover doctor` warns about a lock older than 15 minutes and removes nothing.

Limits: squash is the only merge method; GitHub only (no Jira tool); the other ways to move a card to Done (Board drag, `drover move`, the edit dialog) stay your own manual moves and skip these gates.

## Rebuild it

[`RECIPE.md`](../../mods/drover-tasks/RECIPE.md) is the brief another agent can build this mod from. Back to the [mods index](../README.md#the-mods).
