# Reader

A read-only transcript of a Claude Code or Codex terminal, live, so you can follow an agent without focusing it.

## What you see

A tab with agent chips (one per live agent) at the top and the transcript below: your messages and the agent's replies, in order. When there is none it says why instead of guessing. A `Back to terminal` button returns to the agent.

## How it behaves

- Found by the terminal's `revive.session` label; it never sends input.
- Claude files live under the folder the agent started in (found with `find`); Codex files are found by session id.
- Refreshes every 5 seconds; `max_text` caps the text.
- Off: no timer, no read.

## Built from

- Mod `drover-reader`, `place: none`, `main.js` (about 120 lines).
- `herdr` imports: `agents`, `terminals`, `focused`, `props`, `run`, `exec`, `home`, `readTextFile`, `theme`, `shared`. Parsing is `_lib/transcript.js`.
- Runs `find` to locate a Claude transcript.

## Watch out

- Shared state keys are named in `_lib/store.js` (`drover.tasks`, `drover.projects`), `_lib/wake.js` (`drover.wakeups`) and `_lib/runs.js` (`drover.agents`, `drover.runs`). `mods/install.sh` copies the `_lib` files listed in `_lib/copies.txt` next to `main.js`; a copy of the mod alone must carry them.
- It reads files outside its own folder (the agent CLIs' transcript folders under the person's home): tell them first.
- Needs a Claude Code or Codex terminal that sets `revive.session`.
- Colors, borders and radii come from `theme()`; no hex value is hard coded. Every screen has an `enabled` switch in Drover Config (off hides the screen only; the data and the `drover` CLI stay).
- Preview coming: no preview.png yet (owner-waived for now); add one before listing on herdr.dev.

## Companion mods

<!-- companions:begin -->
**Before you finish, check the companion mods.** Drover is 17 `drover-*` mods and one layout that work together. This mod is one of them.

1. List what is installed: `ls <home>/mods | grep '^drover-'` (`<home>` is the Herdr home, `~/.config/herdr-app` by default). Compare it with this list and work out which are missing:
   `drover-agents`, `drover-board`, `drover-config`, `drover-github`, `drover-jira`, `drover-jump`, `drover-needs`, `drover-newtask`, `drover-projects`, `drover-reader`, `drover-room`, `drover-runs`, `drover-switch`, `drover-tabs`, `drover-tasks`, `drover-todos`, `drover-wakeups`. Also check `<home>/layouts/drover.json`.
2. Tell the person plainly: "installed X of 17, missing [...]". Count this mod as installed once it is in place. If this is the only one, say so.
3. If any are missing, recommend installing all of them: clone `github.com/MathieuDoyon/drover`, then run `mods/install.sh` (it also links the `drover` layout). Or install them one by one from herdr.dev. Ask before installing anything.
4. Then ask once, in one message: Work folder location (project default or the repo's `.drover/`); enable GitHub (y/n); enable Jira (y/n); a shortcut for the right sidebar (Tasks) (y/n); a shortcut to create a task (y/n). Apply the answers in Drover Config (Work folder, the GitHub and Jira switches). The two shortcuts go into `keys.json` under `layout:drover` (`cmd-alt-b` runs `layout.toggle` for the `drover` column) and `global` (`cmd-shift-c` runs `mod.open:drover-newtask`); Drover Config → Shortcuts writes them. Ask before replacing a key the person already uses.
<!-- companions:end -->

## Done when

- With no agent selected it says there is nothing to read.
- With a live Claude Code terminal it shows its messages and updates within 5 seconds.
- `herdr-app check` on the mod passes.
