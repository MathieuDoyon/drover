# Share a herd, or move it to a new machine

Your agents and squads (the herd) can be exported to one JSON file and imported on another machine. The reference is in [Agents and the herd](../agents.md#share-a-herd-and-move-it-to-a-new-machine); this guide is the short walk-through.

## Export

1. Squads → **Export…**. Everything is ticked; untick what you do not want to share. A ticked squad keeps its leader and members ticked.
2. Read the scan line and the text. A secret-shaped hit blocks the export and names the agent, field and rule (never the value). Edit the agent, then export again.
3. **Copy JSON**, or **Save to exports folder** (`~/.config/drover-herdr/exports/drover-herdr-agents-<date>.json`).

Headless or in a script: `drover agents export --out herd.json` (add `--agent <id>` or `--squad <id>` to pick).

## Import

1. On the new machine, Squads → **Import…**. Paste the JSON, or give a path to the file on that machine.
2. Read the preview. Each row says `add`, `skip`, `copy` or `overwrite`, with the full `command` and `instructions`. Nothing is written until you press **Apply**. **Read the commands**: an imported agent runs that command on your machine.
3. Apply, then re-add environment variables (see below) and check the souls.

Headless: `drover agents import herd.json` prints the plan and a token and writes nothing. `drover agents import herd.json --confirm <token>` applies it. The CLI only adds new ids and skips identical ones; a clash keeps yours. For copy or overwrite, use the Squads screen.

## After moving to a new machine

- Install the harnesses the commands use (`claude`, `codex`) and sign in.
- Re-add each agent's environment variables in its editor. Nothing secret travelled.
- Check that your souls match the sender's (a warning tells you when they differ).
- Projects, tasks and wakeups are not part of the file. Re-create projects with `drover project add`; cards come back from GitHub or Jira.

## Headless machine over `hc`

A machine with no screen (a Linux box running Drover as a service) has no Squads dialog. Use the CLI there, and carry the file with `hc`. Paths are relative to that machine's home, as `hc file` takes them.

> **Status:** a headless machine needs Drover mods with **protocol 4** for `agents import`, and `agents export` falls back to an open mod when it has no `node`. The permanent omarchy box is not on protocol 4 yet (follow-up card T-MWJUBIAKUB7), so this recipe is not verified there and has no live steps yet. To check a machine, run the dry run on it with a real file (`drover agents import herd-in.json`): an old Drover mod answers "too old … protocol 4 needed" and changes nothing. An old `drover` script without the verb only prints usage.

Read the herd of the remote machine (read-only):

```sh
hc exec --on omarchy sh -c 'bash -lc "drover agents export --out herd.json"'
hc file read --on omarchy herd.json > herd-omarchy.json
```

Put a file on the remote machine and dry-run the import there:

```sh
hc file write --on omarchy herd-in.json < herd.json
hc exec --on omarchy sh -c 'bash -lc "drover agents import herd-in.json"'          # dry run: plan + token, writes nothing
hc exec --on omarchy sh -c 'bash -lc "drover agents import herd-in.json --confirm <token>"'
```

A remote write is yours to do explicitly; Drover never pushes a herd to another machine by itself.

`queued` is not restored. With no Tasks, Board or Wakeups mod open, `drover agents import … --confirm` answers `queued:` and waits in `data/drover-inbox`. It applies when a mod opens, and it is void after 1 hour. A confirm is `stale` (nothing written) when the file changed since the dry run or the machine's herd changed before it applies. Once queued, the request carries a copy of the file: editing or deleting `herd-in.json` afterwards does not change it. Read the answer, then run `drover squads` to see the herd.
