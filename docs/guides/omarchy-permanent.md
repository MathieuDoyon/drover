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

6. Protocol 2 checks, run from the laptop the way the laptop sender delivers a request (see [Remote writes from the laptop](#remote-writes-from-the-laptop)). A request file may carry `ifRev` (the card rev the sender saw: another rev is answered `error: stale: …` and changes nothing) and `ttlMs` (a request that arrived longer ago than that is dropped, `error: expired: …`). A Drover that predates protocol 2 **ignores both fields and applies the request**, so a sender first probes and sends them only after `ok: protocol 2`. The owner approves the throwaway card first: **T-MWHY5II1Q7J** in project **P-MWHWCPE3514** on omarchy. Nothing below prints an rc file or the environment.

   ```sh
   D=.config/herdr-app/data/drover-inbox                       # relative to omarchy's home, as `hc file read` takes it
   send() {                                                    # send '<json>' -> prints the answer (the result file) or "no answer"
     n="Lprobe-$(printf '%012d' $RANDOM$RANDOM)"                # nonce: L + origin + - + 12 characters, [A-Za-z0-9-] only
     printf '%s' "$1" | hc file write --on omarchy "$D/.$n.tmp" || return 1      # step 1: staged under a dot name, the consumer ignores it
     f=$(hc exec --on omarchy sh -c 'd=$HOME/.config/herdr-app/data/drover-inbox; f=$(date +%s)-$0; mv "$d/.$0.tmp" "$d/$f.json" && echo "$f.json"' "$n") || return 1   # step 2: omarchy stamps the name
     for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; hc file read --on omarchy "$D/${f%.json}.result" 2>/dev/null && return; done; echo "no answer"
     hc exec --on omarchy sh -c 'rm -- "$HOME/.config/herdr-app/data/drover-inbox/$0"' "${f%.json}.result" 2>/dev/null   # best effort: the 24 h cleanup gets the rest
   }
   send '{"op":"protocol","ttlMs":30000}'      # protocol 3: "ok: protocol 3"; a protocol 2 Drover: "ok: protocol 2"; an older Drover: "error: Unknown drover command"
   ```

   Protocol 3 adds fields to `edit` (`priority`, `tags`, `assignee`, `parent`, `project`) and to `add` (`assignee`, `parent`). Rollout precondition: every Drover mod copy on omarchy that watches the inbox must run the same build, because any one of them may take a request. After the update, reload all of them (restart the app, or the unit) before turning laptop writes on; the probe answers for the copy that happened to take it, and a protocol 2 copy would answer `ok` to a field edit and ignore the fields. Check once, with a harmless edit that sets the card's own priority, that the answer is `ok: … edited`.

   After a mods update, restart Herdr on every laptop too: the app keeps running the old mod code it loaded (a hot reload can fail), and a laptop still on the older code reads `ok: protocol 3` as "omarchy needs the update" and keeps writes off until it is restarted.

   Then the negative probe: a move with an `ifRev` that is not the card's current rev must be refused and change nothing. Read only the card's rev (this prints one number, not the board):

   ```sh
   REV=$(hc file read --on omarchy .config/herdr-app/shared.json | python3 -c 'import json,sys; t=[x for x in json.load(sys.stdin)["drover.tasks"] if x["id"]=="T-MWHY5II1Q7J"][0]; print(t.get("rev",0))')
   BAD=$(( REV > 0 ? REV - 1 : 999999 ))                      # lower than the card's rev (a card never written since protocol 2 has no rev and counts as 0)
   send "{\"op\":\"move\",\"id\":\"T-MWHY5II1Q7J\",\"column\":\"todo\",\"ifRev\":$BAD,\"ttlMs\":120000}"   # "error: stale: card T-MWHY5II1Q7J is at rev <REV>, request saw <BAD> …"
   hc file read --on omarchy .config/herdr-app/shared.json | python3 -c 'import json,sys; t=[x for x in json.load(sys.stdin)["drover.tasks"] if x["id"]=="T-MWHY5II1Q7J"][0]; print(t["column"], t.get("rev",0))'   # unchanged
   ```

   The owner archives or leaves the throwaway card. Keep every command's raw output in the work folder.

This redeploy is not approval for laptop writes: the laptop turns them on only after its own probe answers `ok: protocol 2` (see below).

## Rollback

Go back to the previous mods only in this order. A protocol 2 consumer is the only one that expires or rejects a request: time passing on disk does not drop a file, and a Drover that predates protocol 2 would **apply** an old `ifRev`/`ttlMs` request unconditionally. So the protected requests must be drained while v2 is still running.

1. **Freeze the senders.** On the laptop, open each remote project in the Projects editor and press **Turn writes off**. Wait until it says **frozen**: that shows only when no send from any Drover mod is still travelling (every send has finished or hit its 10 s deadline). New sends are refused from the first click. If this step is skipped, the laptop still stops writing within 60 s of step 5, because its protocol probe answer ages out.
2. **Drain check**, with the v2 unit still running. The script fails closed: exit 0 only if the inbox was listed, there is no `.*.tmp` staging file (a delivery in flight) and no `*.json` request contains `ifRev` or `ttlMs`. Anything else, including an unreadable or missing folder, is non-zero:

   ```sh
   ssh omarchy 'bash -lc "~/.local/share/herdr-app/checkout/deploy/omarchy/drain-check.sh"'; echo "exit=$?"   # one line; exit=0 or stop here
   ```

   Non-zero: wait for the v2 consumer to answer the queued requests (each is applied, or answered `stale`/`expired`), then run it again. Never stop the unit with a non-zero result.
3. Stop the unit (as in Update the mods, step 2).
4. **Restore the previous mods.** Check out the previous commit on the laptop (a separate worktree), then rsync that tree and rerun the installer exactly as in step 3 of Update the mods. Start the unit (step 4).
5. **Re-probe.** The v1 consumer answers the protocol probe `error: Unknown drover command`:

   ```sh
   send '{"op":"protocol","ttlMs":30000}'    # the send() function from Update the mods, step 6
   ```

   The laptop's own probe gets the same answer, so its write controls show "omarchy needs the update" (hc stays connected through a rollback, so this is the 60 s freshness rule at work). Leave **Turn writes off** on until the owner redeploys v2.

Residual risk: a send whose owner died is counted as in flight for 240 s only, so "frozen" can show before a rename that was already on its way; that rename would then land an already-expired file.

`drain-check.sh` (exit 0 required) is the authoritative gate, not the "frozen" label: never skip step 2.

### Test of the rollback on a disposable copy

Nothing here touches omarchy or the real inbox; both run on any machine with `node`/`bash`:

- [`mods/_test/inbox-expired-add.test.js`](../../mods/_test/inbox-expired-add.test.js): an `add` whose TTL passed while the consumer was stopped creates no card and is answered `error: expired`; and the rollback order itself: with an expired `add` and an expired `move` left on disk, the drain check fails (protected requests queued), the v2 drain then drops both with `error: expired` (files gone, board byte-equal), and the drain check passes. This is the v2-before-v1 ordering: v1 never sees a file to apply.
- [`deploy/omarchy/drain-check.test.sh`](../../deploy/omarchy/drain-check.test.sh): each case runs on its own temp inbox: a `.tmp` present fails; a missing, unreadable or non-directory inbox fails; an unreadable request file fails; a request with `ifRev` or `ttlMs` fails; an empty inbox and one with only CLI files pass.

Run them with `node --test mods/_test/inbox-expired-add.test.js` and `deploy/omarchy/drain-check.test.sh`. For a hands-on copy, use a throwaway `HERDR_APP_HOME=$(mktemp -d)` and point `drain-check.sh <dir>` at its `data/drover-inbox`.

## Remote writes from the laptop

A project bound to omarchy (Projects editor → Remote) shows omarchy's board on the laptop. With writes on, the laptop can move, edit, note, add and archive cards there; it never starts agents, wakes or `next` on omarchy (those controls stay off: "not available for omarchy projects yet"). The project must already exist on omarchy.

- **Gate.** Writes are on only while the board copy is fresh, the binding's **Writes to omarchy** setting is on, and the last protocol probe answered `ok: protocol 2` or higher less than 60 s ago. Otherwise every write control is off and says why ("omarchy needs the update", "omarchy unreachable", "Checking omarchy…", "writes frozen"). Nothing is sent and nothing is queued for later.
- **Each request** carries the card's version (`ifRev`, the cached card's `rev`) and a 120 s `ttlMs` (the `add` too). omarchy applies it or answers `error: stale` (the card changed there: the laptop reloads and shows "card changed on omarchy") or `error: expired` ("not applied, too old"). No answer in 10 s shows "sent, may still apply"; the late result is picked up later, and an entry older than the TTL plus 1 h shows "outcome unknown". The laptop never resends.
- **Transport.** The mod API has no stdin, so the JSON travels as an argument of a local `sh`, which pipes it into `hc file write --on omarchy` to a dot-named `.<nonce>.tmp` in `data/drover-inbox` (the consumer ignores dot files). A second call, `hc exec --on omarchy sh -c '… mv …' <nonce>`, renames it to `<epoch>-<nonce>.json`, the epoch coming from **omarchy's** `date +%s` (that name is the arrival time the TTL is measured from). The payload is never in a remote argument or script; the nonce is `$0` only. If the second call's reply is lost the laptop finds the file by its nonce and never resends.
- **Cleanup.** Results that nobody read and staging files from a failed rename stay on omarchy. At each reconnect the laptop removes its own (`-L<origin>-` results, `.L<origin>-*.tmp` files) once older than 24 h; other origins' files are never touched.
- **Creating from any create modal.** The Project chip of the create modal lists local projects and omarchy-bound ones (labelled with the machine). Picking an omarchy project sends an `add` to omarchy's inbox (never a local card), and the route follows the project picked at the moment of Create. 
- **Fields (protocol 3).** When the probe answers `ok: protocol 3` the card's sidebar edits Priority, Labels, Assignee, Parent and Project, and the create modal sets the Assignee. At protocol 2 those controls stay off ("omarchy needs the update for priority, labels, assignee, parent and project") and the sender refuses to send those fields, because a protocol 2 consumer would ignore them and still answer `ok`. Each pick in the sidebar (Status, Priority, Labels, Assignee, Parent, Project) saves at once, like the local editor: one request per pick, one in flight at a time (the rows read "saving…" and the dialog cannot be closed until it settles), each naming the card's current version (`ifRev`, rebased after every saved request), so a card changed on omarchy meanwhile answers `stale`, the banner says "card changed on omarchy" and the row goes back to omarchy's value. A project pick reloads both boards and the editor continues on the destination card. Title and description autosave like the local editor (500 ms after the last keystroke, and on close, expand and archive): one edit request with only the changed fields, queued behind a pick in flight; if it is stale the typed text is kept and the next autosave retries. The bottom button (**Send**) sends the note.
  - **Assignee** is `{kind, id}`: `agent` or `squad` and an id from **omarchy's** herd (its Drover Config, not the laptop's); an unknown id is refused. It records the assignment only, nothing is started on omarchy. `none` clears it.
  - **Labels** replace the whole set. **Parent** must be a card of the same project and may not close a cycle; `none` clears it.
  - **Project** moves the card to another project **bound to the same machine** only; moving between machines stays refused.
- **Freeze.** **Turn writes off** in the Projects editor is the switch used by the rollback above.

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
