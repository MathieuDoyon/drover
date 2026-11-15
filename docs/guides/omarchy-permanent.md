# Runbook: permanent Drover on omarchy

Run `herdr-app` (Linux) with the Drover mods on omarchy for good, so the queue, inbox, wakeups and reconcile keep working while the laptop sleeps. It is a second, independent board (its own `shared.json`); there is no sync with the laptop. Background: spike T-MWGP3AAGBT6 (`spike-A.md` in the work folder), task T-MWGP3AJ0M46.

## Paths

Persistent writes (each printed as `WRITE <path>` by the installer):

| Path | What |
|---|---|
| `~/.local/share/herdr-app/releases/0.1.15/` | the extracted release (sha256 checked); `current` links to it |
| `~/.local/share/herdr-app/current` | symlink to the active release |
| `~/.local/share/herdr-app/checkout/` | rsync of the repo from the laptop (no push needed); the installer reads it |
| `~/.local/share/herdr-app/src/` | copy of the repo's `mods/`; the mods installer runs from it, so its library copies land here and your checkout is never written |
| `~/.local/bin/herdr-app` | symlink to `current/herdr-app` (must be on the app's `PATH`: the mods exec it) |
| `~/.config/herdr-app/` | `HERDR_APP_HOME`: mods and layout symlinks (into `src/mods`), board data |
| `~/.config/herdr-app/service.env` | only if `HC_SESSION` is set (mode 600, one line) |
| `~/.config/systemd/user/drover-herdr.service` | only with `--with-service` |
| `~/.config/systemd/user/default.target.wants/drover-herdr.service` | the enable symlink, made by `systemctl --user enable` (only with `--with-service`) |

Scratch exception: the installer makes one `mktemp -d` under `$TMPDIR` (default `/tmp`) for the download and the unpacking, and removes it on exit (also on an error). Nothing else is written by the installer. Not by the installer, but changing anyway: herdr-core's runtime state (`~/.local/state/herdr-core/default`), because the app runs on the default core. The `drover` CLI is put on `PATH` by `deploy/omarchy/bootstrap-agents.sh` (see "Agents on the remote" below): a symlink `~/.local/bin/drover` to `~/.local/share/herdr-app/src/mods/drover-tasks/bin/drover`, because `hc exec` runs `sh -c` (non-login, no rc file) and `~/.local/bin` is already on its `PATH`. The script refuses (exit 1, nothing changed) if a regular file or another symlink is already there.

```sh
DROVER=~/.local/share/herdr-app/src/mods/drover-tasks/bin/drover
```

## Install

From the laptop, copy the repo to omarchy, then run the installer there **in a login shell**: `node` comes from mise and is only on the login `PATH`.

```sh
rsync -a --exclude .git ./ omarchy:.local/share/herdr-app/checkout/     # one more path in the table above
ssh omarchy 'bash -lc "~/.local/share/herdr-app/checkout/deploy/omarchy/install.sh --dry-run"'   # prints every path, touches nothing
ssh omarchy 'bash -lc "~/.local/share/herdr-app/checkout/deploy/omarchy/install.sh"'             # app + mods + layout, no service yet
```


The script reads `https://releases.herdr.dev/app/latest.json`, requires version 0.1.15 (`--version X` to accept another), downloads the `linux-x86_64` archive to a temp folder and **verifies its sha256 before extracting**; on a mismatch it stops and writes nothing. It prints each path as `WRITE <path>`. The Jira and GitHub mods are never installed (`DROVER_SKIP_MODS`). The mods installer's node test stage is skipped on the remote (`DROVER_SKIP_TESTS=1`; it is a dev-time gate and has timing-sensitive tests); every mod is still checked with `herdr-app check`. Without the skip, a failing node test stops the installer and prints the failing test. Needs `curl`, `tar`, `node`.

Optional isolated core (the app does not see omarchy's other terminals): set `HC_SESSION=drover-omarchy` in the installer's environment.

## Supervise (needs the owner's OK)

```sh
ssh omarchy 'bash -lc "~/.local/share/herdr-app/checkout/deploy/omarchy/install.sh --with-service"'   # copies the unit, daemon-reload, enable --now
ssh omarchy 'loginctl enable-linger "$USER"'     # start at boot with nobody logged in (already on here)
```

The unit (`deploy/omarchy/drover-herdr.service`): `Restart=always`, `RestartSec=5`, no start limit, `PATH` with `~/.local/bin`, `HERDR_APP_HOME`, and `WAYLAND_DISPLAY DISPLAY XDG_SESSION_TYPE` unset. After each start it switches to the `drover` layout (the mods only run under that layout). Logs: `journalctl --user -u drover-herdr -f`.

## Verify

Save the command and its raw output to the work folder for each check.

```sh
herdr-app --version                              # herdr-app 0.1.15
herdr-app status                                 # "layout":"drover", "errors":[]
HERDR_APP_HOME=~/.config/herdr-app "$DROVER" next   # see "drover next" below: a fresh home answers "not bound to a project"
systemctl --user status drover-herdr             # active (running)
# supervisor: kill it, it is back within 60 s, state intact
pkill -x herdr-app; sleep 10; systemctl --user is-active drover-herdr; "$DROVER" tasks
# wakeup: a 2-minute wake reaches a live terminal, with the laptop asleep
"$DROVER" wake <terminal> 2m "WAKE-TEST"; hc read <terminal> --lines 20
```

Over ssh, `systemd-analyze --user verify` and `systemctl --user` need `XDG_RUNTIME_DIR=/run/user/$(id -u)`.

`drover next` needs a Drover agent started with a project (queue mode). On a fresh remote home it answers `error: you are not bound to a project`; that is the expected answer, and `drover add`, `drover tasks` and `drover wake` work without it.

Throwaway agent for the lid-closed and wake tests: `drover.agents` in `shared.json` needs BOTH an `agents` and a `squads` array, or the app falls back to the defaults. **Never run `drover start` with a real squad** (for example the default Wrangler/Inspector): it opens real agents in real folders. Check `"$DROVER" squads` first and start only your own throwaway squad.

Lid-closed reconcile: start a throwaway run (`"$DROVER" start - <throwaway squad>`), close the lid, end its terminal (`hc kill <t>`), reopen, and check `"$DROVER" tasks` shows the run ended. No-login start: reboot with linger on and log in nowhere, then `systemctl --user is-active drover-herdr` from ssh (see Verified for what the 2026-11-14 reboot did and did not prove).

`deploy/omarchy/test.sh` is validated on the laptop. On omarchy the mise shims break its fake `HOME`, so do not rely on it there; run it before the rsync.

## Agents on the remote

`deploy/omarchy/bootstrap-agents.sh [--dry-run]` (user-level, no sudo) makes `hc` and `drover` resolvable for agents: it links `~/.local/bin/drover` (printed as `LINK`), appends one marked block to the rc files the login shells read (backup `<rc>.drover-bak.<UTC>` first; a second run adds nothing), and creates `~/.config/drover-herdr/agents` (mode 700, empty). It refuses, changing nothing, on a symlinked or out-of-HOME target or a damaged block. The script header says which shell reads which rc file.

## Update

Refresh the checkout from the laptop (omarchy has no git copy: there is no `git pull` there), then rerun the installer in a login shell:

```sh
rsync -a --exclude .git ./ omarchy:.local/share/herdr-app/checkout/
ssh omarchy 'bash -lc "~/.local/share/herdr-app/checkout/deploy/omarchy/install.sh --version <new>"'   # new release; re-copies src, re-links mods
ssh omarchy 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart drover-herdr'
```

## Update the mods

Use this when only the Drover mods or the `drover` CLI changed (for example a new verb), not the app release. It stops the unit around the redeploy so no mod is mid-write while `src/` is replaced. **The owner approves each live redeploy first.**

1. The owner approves the redeploy.
2. Stop the unit:

   ```sh
   ssh omarchy 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop drover-herdr'
   ```

3. Refresh the checkout and rerun the installer (no `--version`: the release stays; no `--with-service`: the unit is already there):

   ```sh
   rsync -a --exclude .git ./ omarchy:.local/share/herdr-app/checkout/
   ssh omarchy 'bash -lc "~/.local/share/herdr-app/checkout/deploy/omarchy/install.sh"'
   ```

4. Start the unit and look at it:

   ```sh
   ssh omarchy 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user start drover-herdr'
   ssh omarchy 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active drover-herdr; bash -lc "herdr-app status"'   # active; "layout":"drover", "errors":[]
   ```

5. Version-aware check for the `drover project add` verb (the only check defined so far). On omarchy, pick any git repository there (`<repo>`, an absolute path):

   ```sh
   ssh omarchy 'bash -lc "drover project add zz-probe --repo <repo>"'   # answers "ok: P-… project zz-probe" (a second run: "ok: P-… exists")
   ssh omarchy 'bash -lc "drover projects"'                             # lists zz-probe
   ```

   Then the owner either removes `zz-probe` through the Projects data (there is no remove verb) or leaves it named `zz-probe`.

Not covered yet: there are no protocol, stale-request or expiry checks. The protocol card defines them in this section when it lands, and the card that turns on laptop writes runs them live on omarchy and requires them. This redeploy is not approval for laptop writes: the laptop does not send `project-add`, or any other write, to omarchy. Keep every command's raw output in the work folder; never print an rc file or the environment (`service.env`, `env`, `printenv`).

## Uninstall

```sh
systemctl --user disable --now drover-herdr
rm ~/.config/systemd/user/drover-herdr.service && systemctl --user daemon-reload
rm ~/.local/bin/herdr-app && rm -r ~/.local/share/herdr-app   # release + src copy
# the board and mods live in ~/.config/herdr-app: keep it, or remove it to drop the board
```

## Limits (from the spike)

- F1: `drover start` needs a space in the app and a coordinator terminal that is on screen. A headless app has no space until one is made (`space.new`); launching squads from a background terminal fails with "Coordinator … is not on screen".
- F2: `herdr-app` must be on the app process's `PATH` (the unit sets it).
- F3: mods run only under the `drover` layout; a fresh home opens `main` with a welcome overlay.
- F4: the app is a single point of failure; the unit restarts it, but an outage still pauses wakeups and reconcile until it is back.
- F5: a fresh home has an empty board and no squads (open Squads once, "Add default herd").
- No screenshots (`shot` is unsupported with no display). Observe with `herdr-app status`.
- Jira/GitHub mods and tokens are not installed on omarchy.
- Default core, on purpose (owner decision 2026-11-14): no `HC_SESSION`, so the laptop app and the omarchy app see the same omarchy terminals.
- Shared layout document: both apps edit omarchy's layout (`~/.config/herdr-app/AGENTS.md`, lines 96-100: the newest accepted document wins, no merging). Two structural edits (space, tab, split) at the same moment drop one of them; the terminals keep running.
  - Mitigation: the omarchy app makes structural edits only on `drover start`.
  - Recovery of a dropped space or tab: `hc ls` still lists the live terminal; give it a pane again with `herdr-app do terminal.keep '{"terminal":"<t>","place":"tab"}'`. The command exists in 0.1.15 (`herdr-app commands`); it has not been tried on a dropped tab, so confirm with `herdr-app commands` first.

## Verified 2026-11-14 (live install on omarchy; raw output in the work folder `omarchy-permanent/evidence/`)

- Install: 0.1.15, sha256 ok, unit verify ok, service enabled. Write inventory (AC1) is a filtered observation, not exhaustive: files newer than a marker under `$HOME`, with browser, cache and state paths excluded. It showed nothing outside the approved paths except unrelated processes and the default `herdr-core` runtime state; it does not prove nothing else was touched.
- `drover next` (AC2) is PARTIAL: the layout is `drover` with no errors and `drover add`/`tasks` work, but `next` answered "not bound to a project" (no project-bound Drover on the remote yet).
- Supervisor (AC5): `kill` -> app back after 8 s, board state intact.
- Lid-closed reconcile (AC3): a throwaway run's terminal was killed while the laptop slept; the app stamped the run ended at 14:19:31, inside the sleep window.
- 2-minute wake (AC6): set 14:18:16, due 14:20:16 while the laptop slept, delivered 14:20:31 by omarchy's own 15 s tick, 5 s after the laptop's DarkWake began (14:20:26). The delivery is omarchy-local; the DarkWake is a caveat.
- After a reboot with nobody typing a login (AC4, owner reboot 2026-11-14 14:35; `evidence/14-ac4-after-reboot.txt`, `14b-session-timing.txt`): the unit was enabled and active since 14:35:17 (linger on), `herdr-app status` showed layout `drover`, `errors: []`, the board state was kept, and the app's environment had no `WAYLAND_DISPLAY`/`DISPLAY`. **Caveat: a start with no desktop session at all is NOT proven.** omarchy autologs in through `sddm-autologin`: the user manager (linger) session opened at 14:35:04.3 and a Wayland desktop session at 14:35:04.9, before the unit started (journal 14:35:15). What is proven: no person logged in, and the app runs without display variables. An earlier reboot where the owner did log in does not count.
- AC4 limit: omarchy autologs in (`sddm-autologin`), so a Wayland session exists at every boot. A start with no desktop session at all (autologin off, nobody logged in) has not been tried; it would need the owner to change the display manager setup.
