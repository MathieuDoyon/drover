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

`install.sh` touches only what differs, so a running Herdr reloads a mod only when its files really changed. Run it from the main checkout: from a linked git worktree it refuses (a link into a worktree breaks the mods when the worktree is deleted). To look at a worktree on purpose, run `./install.sh --from-worktree`, then run `install.sh` from the main checkout again before you delete the worktree. After a change to the shared `_lib` code, `install.sh` prints a `NOTE` (it compares a hash with `~/.config/herdr-app/.drover-lib-stamp`, written after each good run; it hashes with `sha256sum`, `shasum` or `cksum`; with none of them it says so only when it really updated a shared file). Herdr is not known to re-import a changed `_lib` file when it reloads a mod in place: a running mod can keep answering with the old code (for example an old inbox protocol). Probe it (`drover config max-parallel`); if it is stale, quit and reopen the Herdr window. Terminals survive, they live in herdr-core. `install.sh` replaces only its own symlinks. If `~/.config/herdr-app/mods/drover-*` is a real folder, the script skips it: move that folder away first.

```sh
cd mods && ./install.sh
```

It runs the tests, copies the shared library into each mod, links the 17 `drover-*` mods and the `drover` layout into the Herdr home, and checks each mod with `herdr-app check`. Expected output: 17 lines `ok   drover-…`, then `ok   layout drover`. On `FAIL <mod>` it prints the `herdr-app check` errors and stops.

Variables:

- `HERDR_APP_HOME`: install into another home (default `~/.config/herdr-app`).
- `DROVER_SKIP_TESTS=1`: skip the test stage.
- `DROVER_SKIP_MODS="drover-jira drover-github"`: leave those mods out and remove their symlink.

## 5. Check

```sh
ls -l ~/.config/herdr-app/mods | grep -c 'drover-.* -> '   # 17
herdr-app status                                           # no errors
herdr-app do layout.switch '{"name":"drover"}'             # back: '{"name":"main"}'
```

## Install one mod from the gallery

Each mod folder is import-self-contained (it carries its own copy of the shared library), so it loads on its own. That does not make every feature work alone: some mods need a companion (for example New task opens the Todos dialog, and the Board needs Todos and Squads). The [mod pages](README.md#the-mods) list what each one needs. Install the mod, then run its `RECIPE.md` check: it lists which `drover-*` mods are installed and which are missing, and recommends installing **all** of them. The mods share one task store, so the screens fill each other in: for example the Board edits cards in the Todos dialog and starts agents from the Squads picker.

To check by hand:

```sh
ls ~/.config/herdr-app/mods | grep '^drover-'   # you want 17 lines
ls ~/.config/herdr-app/layouts/drover.json      # the layout
```

What needs what is on each [mod page](README.md#the-mods).

## 6. First data

A new home has an empty board. See [Getting started](getting-started.md).

## Agent CLI

Path: `~/.config/herdr-app/mods/drover-tasks/bin/drover` (no arguments prints help).

- Read commands (`tasks`, `task`, `squads`, `projects`) work at all times.
- `drover asks-hook install|uninstall|status` is the one opt-in step that touches your Claude and Codex hook files (diff first, asks first, never overwrites; see [Asks hook install](mods/tasks.md#asks-hook-install)). `install.sh` never runs it.
- Write commands go to `~/.config/herdr-app/data/drover-inbox`. An open Tasks, Board or Wakeups mod applies them. If none is open the CLI prints `queued: …`.

## Update

```sh
git pull && mods/install.sh
```

Edit `mods/_lib/*.js` only; the copies in each mod are tracked and refreshed by `install.sh`. An edited copy is kept, not overwritten: see [Safe updates](#safe-updates).

## Safe updates

`install.sh` keeps a file you changed and puts the new version beside it. There is one stated exception, a "save by rename" in the instant before the installer's own rename (see the limit below). It manages two kinds of things: the generated copies of the shared library inside each `drover-*` mod (the files listed in `mods/_lib/copies.txt`, plus `drover-config/query.js`), and the symlinks it makes in the Herdr home (`mods/drover-*` and `layouts/drover.json`). Other tracked files (`main.js` and so on) are never written by the installer.

For each copy, the installer keeps the bytes it installed last time (the baseline, in `~/.config/herdr-app/.drover-baseline/`, outside `mods/` so nothing reloads). A copy is replaced only if it still equals the incoming file, the baseline, or (when `git` can show it, and only if the checkout moved since the last install, for example after `git pull`) the committed bytes of its source. Anything else is kept exactly as it is:

- the incoming file is written beside it as `<file>.new` (for example `drover-tasks/store.js.new`);
- the run prints `KEPT <mod>/<file> (owner-changed|unknown baseline): new copy at <mod>/<file>.new`;
- the run goes on with every other file, then exits with code 1 and does not write the lib stamp, so the reopen `NOTE` shows again next time.

`owner-changed` means a baseline exists and the file differs from it; `unknown baseline` means there is none (an install made before this feature) and the file is not the committed one. An edit made through a home symlink is an edit of the repo file, so the same rules apply. A copy that is a symlink, a dangling link or a folder is kept too ("not a regular file"), with no `.new`.

To take the new version, compare, merge or delete your edit, then run `install.sh` again: when the file equals the baseline or the incoming copy it is replaced.

The `.new` follows no record and does not follow the source. If it is absent, install creates it. If it already equals the incoming copy, nothing is written. If it exists and differs (an older copy from an earlier run, or yours), or it is a symlink, install never touches it: the run says it is "older than the incoming copy, or yours", names the source that holds the current incoming copy (for example `mods/_lib/store.js`), and exits 1 without writing the lib stamp. So if `_lib` changes again before you resolve a kept file, the `.new` is out of date and the run says so until you delete it. Once the file beside it is settled again, a `.new` equal to the incoming copy is moved (not deleted) into `mods/.install-backups/<stamp>/`; any other `.new` is reported and left.

Links work the same way. The installer records each link it makes. It repoints or removes a link only while it still points where it recorded (so `--from-worktree` and `DROVER_SKIP_MODS` still work on links the installer made). A link it has no record of is kept on a skip run; a normal run records a link that already points where install would point it. A link you repointed yourself, or one it has no record of, is kept, printed as `KEPT link …`, and the run exits 1. Remove that link by hand to let the installer make it again.

Right after a copy is replaced, the old file is moved (not copied) to `mods/.install-backups/<UTC stamp>-<pid>/<mod>/<file>`, so a late write through a handle that was still open lands in that file, not in nothing. It is extra safety, never the rule; the folder is ignored by git and is yours to delete. If the move fails, the old file stays beside the new one as `.drover-aside.*`, the run says so and exits 1. If you edit a file in the few moments while it is being replaced, your version is kept as `<file>.owner-<stamp>` and the run prints `KEPT-OWNER`.

One limit, in plain words: if you SAVE a managed copy with an editor that writes a new file and renames it over the old one (a "save by rename"), in the instant between the installer's last check and its own rename, the installer's rename replaces your saved file and your save is lost. The installer checks right before the rename that the file is still the one it looked at, which narrows this window, but a shell script cannot close it, and nothing guarantees how long it lasts. Edits made in place (appending, or an editor that overwrites the same file) are never lost. To be safe, do not save a managed copy while `install.sh` is running; the installer holds two locks, one per checkout (`mods/.install.lock`) and one per Herdr home (`~/.config/herdr-app/.drover-install.lock`, because every checkout installing into a home shares its link records), so two installers never run at once; a run that finds one held exits 2 and writes nothing. If an installer was killed, remove the lock folder it left. The baseline records are keyed by the checkout's physical path, so running through a symlinked path to the same checkout finds the same records. Better still, edit `mods/_lib/*.js` only, as the Update section says.

If a baseline record is unreadable or only half written, the installer treats the file as changed and keeps it. Before it replaces or creates a file (and before it repoints or removes a link) it takes the old record out of charge, or on a first run writes an `invalid` marker; if that cannot be written, the file is left alone and kept (a file to create is not created, a link is not changed), and if the new record cannot be written afterwards the run says so, exits 1, and keeps the file next time unless it equals the incoming copy. The installer only creates its own temporary and backup folders: a name that already exists is refused (the run fails closed) and never deleted or written through.

The first run after you get this version has no baselines. Copies equal to the committed bytes are adopted silently; an edited copy shows as `unknown baseline` and is kept.

## Not covered here

- Board data, agents and squads from another computer live in `~/.config/herdr-app/shared.json`. A new home starts empty.
- Using another machine (Linux or macOS) through `hc`: [Remote machines](guides/remote-machines.md).

## Remove

```sh
for m in ~/.config/herdr-app/mods/drover-*; do [ -L "$m" ] && rm "$m"; done
rm -f ~/.config/herdr-app/layouts/drover.json   # only if it is a symlink
```
