# Remote machines

A remote machine is any computer that `hc machine ls` lists. Drover uses it through `hc` only: `hc exec --on <machine>` runs a command there and `hc file --on <machine>` reads or writes a file there. Nothing of Drover runs on the remote as a daemon, there is no Herdr app and no mod on it, and Drover adds no ssh, key or connection of its own. Linux and macOS machines both work.

This guide is the map. Each step has its own reference: [Machines](machines.md) (install, check, doctor, the sync hold), [Headless board writer](headless-board.md) (the board verbs) and [Share a herd](share-a-herd.md) (moving agents and squads).

## 1. Link the machine (you do this)

```sh
hc machine add <machine> …
hc machine ls
```

`hc machine add` is a human step: Drover never links a machine for you. Read `hc machine ls --json` for the facts Drover relies on. `state` must be `connected`. `keeps_running_after_logout` says whether the machine keeps your session when nobody is logged in; when it is `false`, a long job on that machine can stop at logout, and `drover machines doctor` says so with a WARN on the `link` check. Setting that up is the machine's own business (its own login and service settings); this guide does not cover it.

## 2. Install the Drover CLI there

```sh
drover machines install <machine>     # copies the CLI and helpers, verifies them, switches atomically
drover machines check   <machine>     # read-only; exit 1 on any drift
drover machines doctor  <machine>     # read-only report: link, node, python3, current, files, tests, entry, hold
```

Flags: `--node <dir>` (where node is), `--force`, `--json`; `drover machines hold clear --reason <text>` releases a stuck hold by hand. Details and the failure codes are in [Machines](machines.md).

**What the machine needs**

- **node**, found in this order: `PATH`, the folder you pass with `--node`, the common install locations, then version managers (nvm, fnm, asdf, volta, mise; none is assumed). No node: the install stops with `E_NODE_NOT_FOUND` before it writes anything.
- **python3** (`E_PYTHON_NOT_FOUND` before any write when it is missing) and **bash**.

## 3. How Drover talks to it

Only through `hc`:

- `hc exec --on <machine> …` for commands (no shell is added by Drover; where a script is needed it is sent as a short `sh -c` argument).
- `hc file read|write --on <machine> <path>` for files.

The installed CLI includes `drover-headless`, the board of that machine without a window. It is run over `hc exec`, and its verbs are listed in [Headless board writer](headless-board.md). Nothing is pushed to a machine while an install is unfinished (the [sync hold](machines.md#the-sync-hold)).

## What works today, and what is planned

| Item | State |
| --- | --- |
| `drover machines install`, `check`, `doctor`, the hold | works (see [Machines](machines.md)) |
| `drover-headless` verbs over `hc exec` | works (see [Headless board writer](headless-board.md)) |
| Moving a herd to or from a remote with `hc file` and `drover agents import\|export` | legacy, local-app-only: it needs an existing Drover app or mod consumer on that machine, so it is not supported on a machine set up as above (no app, no mods); pending ([Share a herd](share-a-herd.md)) |
| A per-project transport, `inbox` (the default) or `exec`: the board of a remote project is read and written through `drover-headless` over `hc exec` | works (see [The exec transport and the cutover](#the-exec-transport-and-the-cutover)) |
| Starting an agent or a squad on the remote | planned; not available |
| Holding new starts when a machine is overloaded | works for this computer only, advisory (a raw `hc run --on` bypasses it); see [Runs](../mods/runs.md#load-hold). A remote start would use the same check once it exists |

Remote writes are advisory in the board: a control that cannot act on a remote project stays off and says why. Drover never pushes anything to a machine by itself.

## The exec transport and the cutover

Each remote project has a **Transport** in the project editor, next to the Writes toggle: `inbox` (the default: the laptop reads the machine's old `shared.json` and drops files in its inbox) or `exec` (the laptop runs `drover-headless` over `hc exec --on <machine>`). Flipping it saves the binding only: no card, project or file moves, and the binding keeps its id.

With `exec`:

- **Reads.** The laptop asks `version` once (the ops the machine supports), then polls `rev`, and fetches tasks and projects only when the rev changed. A failure backs the poll off. The last copy stays on screen, marked stale with a banner (`<machine> unreachable · last update HH:MM · showing a saved copy`). A call that hangs is abandoned at its deadline and never blocks the window.
- **The ops list drives the controls.** A control is on only when the machine reported its op (`move`, `note`, `edit`, `add`, `archive`); otherwise it is off and says `The remote machine does not support <op>`. There is no protocol probe.
- **Writes.** One envelope (`nonce`, `issuedAt`, `ttlMs`, and the card's `ifRev`), sent as JSON on the remote program's stdin, never in a remote command line. (Limit: the app's exec has no stdin option, so on this computer the JSON is briefly an argument of a local `sh` that pipes it to `hc exec --stdin`, as the inbox transport already does.) If the answer is lost, repeat the same action: a retry within 24 h re-sends the same request and creates no second card; after 24 h the remote no longer remembers it and a repeat can create a duplicate: check the card first. Only the clear failures are reported as "not applied"; an error that can come after the write (a failed disk sync) is reported as unknown, never as not applied. A write on a machine that is unreachable, or whose view is stale, is **refused with "nothing was sent"**: there is no queue and nothing is sent later by itself.
- **Clocks.** `version` and `rev` carry the machine's clock. If it differs from this computer's by more than 30 seconds, in either direction, the controls are off and a write is refused with the reason, because every envelope is stamped with this computer's time and the machine checks its age. `drover machines doctor` also reports the difference.
- **Known limit.** The assignee picker is empty, because `drover-headless` does not report agents.

### Cutover, one machine

1. `drover machines install <machine>`, then `drover machines doctor <machine>` (fail must be 0).
2. `drover machines migrate-in <machine>`: copies the cards, projects, and agent and squad names of the machine's old `shared.json` into its headless board and prints the counts (`copied`, `skipped`). The old file is only read; running it again copies nothing new.
3. In the project editor, press **Switch to exec**. The laptop first asks the machine for `drover-headless` and the project, and refuses (binding unchanged) if either is missing.
4. Live check, with the owner present: read the board, add a card, edit it, add a note, move it, archive it, and check each result on the board.

### Rollback

Press **Back to inbox**. The old `shared.json` was never written by the exec transport, so the inbox shows the cards it had, with the same ids. **Cards written after the flip are not carried back**: they stay on the headless board (flip to exec again to see them). Nothing is retired by a flip.

A rehearsal of all of this on a fake machine is `node --test mods/_test/install/exec-rehearsal.test.js`.

## Check list

1. `hc machine ls` shows `<machine>` as `connected`.
2. `drover machines install <machine>` prints the file actions, then `installed: …` (or `current: … nothing to do` when it was already whole), and exits 0.
3. `drover machines doctor <machine>`: read its summary line, `doctor: N ok, N warn, N fail`. Fail must be 0; a WARN on `link` means the machine may stop when nobody is logged in.
4. `drover machines check <machine>` exits 0 (read-only; exit 1 on drift).
