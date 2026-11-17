# Install

Drover is a set of Herdr mods. You install them into your Herdr home (`~/.config/herdr-app`) with one script, or one at a time from the Herdr gallery.

## 1. Requirements

| Tool | Check | Needed for |
| --- | --- | --- |
| Herdr app + core | `herdr-app --version` (0.1.15 or later), `hc --help` | Everything |
| Node | `node -v` (22 or later) | `install.sh` runs the tests |
| git | `git --version` | Everything |
| [Claude Code](https://claude.com/claude-code), logged in | `claude --version` | Agents and squads |
| Codex, logged in | `codex --version` | Only the Inspector agent |
| [GitHub CLI `gh`](https://cli.github.com), logged in | `gh auth status` | Only `drover-github` and PR rows in the Room |
| Atlassian email + API token | `ls -l ~/.config/drover-herdr/atlassian.json` (mode 0600) | Only `drover-jira`; see the [Jira setup guide](guides/jira-setup.md) |

## 2. Get the code

Clone this repository (the command is in the [README](../README.md#install)) and stay at its root: step 4 runs the installer from there.

## 3. Create the Herdr home

1. Open the app once: `herdr-app`. It creates `~/.config/herdr-app` with the built-in mods and `gpui-kit.d.ts`.
2. Keep the app open.

## 4. Install all the mods

`install.sh` touches only what differs, so a running Herdr reloads a mod only when its files really changed. Run it from the main checkout: from a linked git worktree it refuses (a link into a worktree breaks the mods when the worktree is deleted). To look at a worktree on purpose, run `./install.sh --from-worktree`, then run `install.sh` from the main checkout again before you delete the worktree. `install.sh` replaces only its own symlinks. If `~/.config/herdr-app/mods/drover-*` is a real folder, the script skips it: move that folder away first.

```sh
cd mods && ./install.sh
```

It runs the tests, copies the shared library into each mod, links the 14 `drover-*` mods and the `drover` layout into the Herdr home, and checks each mod with `herdr-app check`. Expected output: 14 lines `ok   drover-…`, then `ok   layout drover`. On `FAIL <mod>` it prints the `herdr-app check` errors and stops.

Variables:

- `HERDR_APP_HOME`: install into another home (default `~/.config/herdr-app`).
- `DROVER_SKIP_TESTS=1`: skip the test stage.
- `DROVER_SKIP_MODS="drover-jira drover-github"`: leave those mods out and remove their symlink.

## 5. Check

```sh
ls -l ~/.config/herdr-app/mods | grep -c 'drover-.* -> '   # 14
herdr-app status                                           # no errors
herdr-app do layout.switch '{"name":"drover"}'             # back: '{"name":"main"}'
```

## Install one mod from the gallery

Each mod folder is import-self-contained (it carries its own copy of the shared library), so it loads on its own. That does not make every feature work alone: some mods need a companion (for example New task opens the Todos dialog, and the Board needs Todos and Squads). The [mod pages](README.md#the-mods) list what each one needs. Install the mod, then run its `RECIPE.md` check: it lists which `drover-*` mods are installed and which are missing, and recommends installing **all** of them. The mods share one task store, so the screens fill each other in: for example the Board edits cards in the Todos dialog and starts agents from the Squads picker.

To check by hand:

```sh
ls ~/.config/herdr-app/mods | grep '^drover-'   # you want 14 lines
ls ~/.config/herdr-app/layouts/drover.json      # the layout
```

What needs what is on each [mod page](README.md#the-mods).

## 6. First data

A new home has an empty board. See [Getting started](getting-started.md).

## Agent CLI

Path: `~/.config/herdr-app/mods/drover-tasks/bin/drover` (no arguments prints help).

- Read commands (`tasks`, `task`, `squads`, `projects`) work at all times.
- Write commands go to `~/.config/herdr-app/data/drover-inbox`. An open Tasks, Board or Wakeups mod applies them. If none is open the CLI prints `queued: …`.

## Update

```sh
git pull && mods/install.sh
```

Edit `mods/_lib/*.js` only; the copies in each mod are tracked and refreshed by `install.sh`.

## Not covered here

- Board data, agents and squads from another computer live in `~/.config/herdr-app/shared.json`. A new home starts empty.
- Running Drover as a service on a Linux box: [guide](guides/omarchy-permanent.md).

## Remove

```sh
for m in ~/.config/herdr-app/mods/drover-*; do [ -L "$m" ] && rm "$m"; done
rm -f ~/.config/herdr-app/layouts/drover.json   # only if it is a symlink
```
