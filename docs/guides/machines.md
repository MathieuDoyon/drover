# Machines: install the Drover CLI on a linked machine

`drover machines` copies the `drover` command-line tool and its helpers from this computer to any machine in `hc machine ls`, checks them there, and switches to them in one atomic step. Nothing of Drover runs on the other machine except short scripts the laptop sends through `hc`; there is no ssh, no key and no new connection of ours.

```
drover machines install <machine> [--force] [--node <dir>] [--json]
drover machines check   <machine> [--node <dir>] [--json]
drover machines doctor  <machine> [--node <dir>] [--json]
drover machines hold clear --reason <text>
```

Start with [Remote machines](remote-machines.md) for the whole path. A machine is linked by you, with `hc machine add`; `drover machines` never adds one. Linux and macOS machines both work.

## What the machine needs

- **node.** Found in this order: `PATH`, the folder you pass with `--node`, the common install locations, then version managers (nvm, fnm, asdf, volta, mise; none is assumed, and the newest version wins inside that last step). No node: the install stops with `E_NODE_NOT_FOUND` before it writes anything.
  Each candidate must answer `--version` within 5 seconds (`DROVER_FIND_TIMEOUT_S` changes the bound); one that hangs is killed and the next tier is tried. Without a safe temporary file (`mktemp` failing) nothing is probed and the finder says `E_TEMP_FAILED`.
- **python3**, for the small switch and check scripts. Missing: `E_PYTHON_NOT_FOUND`, again before any write.
- **bash**, which `drover` already needs.

## What an install does

1. Reads only: finds node and python3, reads what is installed (a stamp, `MANIFEST.json`, inside the installed generation).
2. Decides each file: `current` (same bytes, skipped), `update`, `new`, `missing`, `edited-remote` (changed on the machine: kept unless `--force`), `newer-remote` (the machine's copy came from a newer source: an older source never replaces it unless `--force`). The source time is the file's modified time on this computer; `--force` is the escape when a checkout's times are unreliable.
3. **Takes the sync hold** (below), only when something will be written. Then reads the machine again and decides from that second read.
4. Builds a **complete generation** in `~/.local/share/drover-herdr/gen/.stage-<nonce>/`: each file is sent with `hc file write --on`, kept files are copied on the machine, modes are set, and `MANIFEST.json` is written last.
5. **Verifies** it there: the sha256 and mode of every file, then each file's own test argv (`bash -n` for scripts, `node --check` or an import for the JavaScript). Any failure stops here: the running CLI is untouched.
6. Publishes the stage to `gen/<id>/` with ONE rename (an id that already exists is refused, so a generation directory is never seen without its `MANIFEST.json`; a published generation is never written again, and an old one is reused only when its stamp also matches what this install intends, otherwise a fresh suffixed one is built) and **switches** `current` to it with one atomic rename. The previous generation stays.
7. Makes sure the launcher `~/.local/bin/drover` exists. It reads `current` once and runs that generation's CLI by absolute path, so a `drover` call that started before the switch finishes on the generation it started with, and a call during an update always finds a complete one.
8. Runs **doctor**. Only a passing doctor clears the hold.

An install that is already whole (every file `current`, modes right, the tests pass, the launcher in place, no hold for this machine) is a no-op: no write, no hold. `check` is read-only and exits 1 on any drift. If a file was edited on the machine and you do not use `--force`, the install keeps the edit and records it as kept in the stamp, so `doctor` stays green.

A file that is installed unchanged keeps the source time it was installed with, so an older checkout can never lower it and then slip a downgrade through on a later run. An install whose `current` link exists but whose `MANIFEST.json` is missing or not whole is never treated as a fresh machine: `install` refuses (`E_STAMP_INVALID`) and changes nothing until you look at it with `doctor` or pass `--force` (a machine with no `current` link is fresh). `doctor` refuses a stamp that is empty, malformed or missing a shipped file, and an unreachable machine gives FAIL lines in the same format, not an error.

**Known limit.** If a first install is killed after it published its generation and before the first switch, and you then edit a file by hand inside that generation, the edit is not carried over: nothing was ever active, so the retry builds a new generation from the laptop's files. The edit stays on disk in the orphan generation, unused, and is never deleted.

Old generations are not pruned in this version, and a stage left by a killed install is not removed (it is named by its nonce and never used).

## The sync hold

While an install or update is unfinished, **nothing is pushed to any machine**. The laptop keeps the hold in `<app home>/data/drover-sync-hold/` as numbered records `hold.<n>.json` that are only ever appended (the newest number wins; `hold.10` is newer than `hold.9`). Each record is `held` or `cleared` and names the machine, the target generation, the owner's pid and host, and the time. A record is published whole with an exclusive link, so it is never half written and a second installer can never replace it.

- `install` writes `held` first (before any write on a machine) and a passing `doctor` appends `cleared`, but only when the machine's `current` is the hold's target and nobody else appended a record in the meantime.
- A second installer, or an install for another machine, stops with `held: … since …` and sends nothing, not even a read.
- A killed install leaves the hold. Re-run `drover machines install <machine>`: the owner is gone, so the same machine resumes and finishes (the previous generation kept running the whole time).
- A hold from another host, or a record that cannot be read, is never taken over by itself. Once you know no install is running, release it by hand: `drover machines hold clear --reason "<why>"`. That appends a `cleared` record with the reason `manual`; nothing is deleted.

### For code that pushes to a machine (board writes, anything later)

Call `pushGuard(hold)` from `machines.js` to ask whether anything is held, **and acquire the hold** when the push must not run next to an install. Checking and then acting is not exclusion: an install can start between the two. The directory holding the hold files is not fsynced; after a power loss the newest record can be missing, which means the hold behaves as the older state. That is an accepted limit.

The machine health read (below) is **exempt** from the hold: it runs a fixed script that only reads, writes nothing on the machine and never touches `gen/`, so it can run while an install is unfinished.

## Machine health

`bin/drover-health.py` (shipped by `install`, python3 standard library only) prints one JSON object and exits 0 even when a field cannot be read. Run it by hand on a machine: `python3 ~/.local/share/drover-herdr/current/bin/drover-health.py`. Shape:

```
{"v":1,"os":"linux|darwin|other","cores":4,"load":{"one":1.6,"five":1.0,"fifteen":0.8},"loadPerCore":0.4,
 "mem":{"totalMb":16000,"usedMb":9760,"pct":61},
 "disks":{"home":{"totalMb":100000,"freeMb":60000,"pct":40},"tmp":{"totalMb":50000,"freeMb":45000,"pct":10}}}
```

A field it cannot read is `null`, never a guess. Linux reads `/proc/loadavg` and `/proc/meminfo` (used = total minus `MemAvailable`); macOS has no `/proc`, so it uses `sysctl hw.memsize` and `vm_stat` (free + inactive + speculative pages are available; the page size comes from the `vm_stat` header). `tmp` is the literal `/tmp`, not `$TMPDIR`. The output holds no name, path or environment value.

The Tasks sidebar (setting `machine_polling`, off by default, see [Tasks](../mods/tasks.md#machines)) runs the same text from the laptop with no install needed: `hc exec --on <machine> --timeout 20 -- python3 -c <script text>`. **Deviation from the "payload never in argv" rule:** the script is passed as one argv item because the mod host has no stdin. That rule is about card data; this text is fixed, about 5 KB and carries nothing from the machine or the card. `_lib/health.js` embeds the file's exact text and a test keeps them byte-equal.

The same numbers feed the [load hold](../mods/runs.md#load-hold): a new start on this computer is held when it is over a limit. A machine's health that is unknown or older than 15 minutes never holds a start; it allows it with a warning. A linked machine named `local` is warned about by `doctor`, because `local` is this computer's name in `drover-runs.hold_machines`.

## doctor

```
<ok|FAIL|WARN|skip>  <machine>:<check-id>  <detail>
doctor: N ok, N warn, N fail
```

Checks: `name` (WARN only, when the machine is named `local`), `link` (the machine is connected; WARN when it may stop while nobody is logged in), `node`, `python3`, `current` (the link resolves to a generation with a `MANIFEST.json`), `files` (every sha256 and mode matches the stamp; an edit kept on purpose is checked against what was recorded), `tests` (each file's test argv, run on the machine), `entry` (the launcher), `hold`. Exit status 1 only on FAIL. `--json` prints `{ok, machine, checks[], summary}`. Doctor writes nothing on the machine.

## Live check (owner present)

Not part of the tests: they use a fake runner on this computer. A live run needs the owner: a machine with node only from a version manager and not on the non-login `PATH` (which is why the finder exists), then `install`, `check`, `doctor`, a kill in the middle with the link up, and the re-run.
