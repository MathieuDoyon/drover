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
| A per-project exec transport for the board's own writes, replacing the older inbox path | planned (card A3b); not live |
| Starting an agent or a squad on the remote | planned; not available |
| Holding new starts when a machine is overloaded | works for this computer only, advisory (a raw `hc run --on` bypasses it); see [Runs](../mods/runs.md#load-hold). A remote start would use the same check once it exists |

Remote writes are advisory in the board today: a control that cannot act on a remote project stays off and says why. Drover never pushes anything to a machine by itself.

## Check list

1. `hc machine ls` shows `<machine>` as `connected`.
2. `drover machines install <machine>` prints the file actions, then `installed: …` (or `current: … nothing to do` when it was already whole), and exits 0.
3. `drover machines doctor <machine>`: read its summary line, `doctor: N ok, N warn, N fail`. Fail must be 0; a WARN on `link` means the machine may stop when nobody is logged in.
4. `drover machines check <machine>` exits 0 (read-only; exit 1 on drift).
