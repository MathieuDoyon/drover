# GitHub

A read-only list of every open issue and pull request in the orgs and repos you add, using your `gh` login.

## What you see

A tab with a scope row (chips like `example-org` you can click to remove), a filter box and a table of issues and PRs: repo#number, title, state, assignee, labels and type (Issue / Pull request). Each row has `+ Board` to make a local card.

## How it behaves

- Type an org or `org/repo` and Enter to add a scope chip; a click on a chip removes it. Saved scopes win, even an empty list.
- Focusing the filter box opens a key/value menu (Up/Down, Enter, Esc): Is, State, Label, Assignee, Author, Involves, Mentions, Commenter, Milestone, Review requested, Draft, Project, In, Repo, Created, Updated, Comments. `Reset filter` restores `is:issue state:open`. The menu assumes the caret is at the END of the text.
- Not supported by `gh search issues`: Parent issue, Blocking, Blocked by, Relates to, Sub-issue, Has author.
- Loads on a timer; a failure keeps the last good data.

## Built from

- Mod `drover-github`, `place: none`, `main.js` (about 300 lines), `filter.js`, `menu.js`, `values.js`, `query.js`, `mod.schema.json`.
- `herdr` imports: `exec`, `shared`, `setShared`, `theme`. Runs `gh search issues` and `gh api` through `exec("gh", …)`.
- Setting: `limit` (per org or repo, 1-1000, default 100).

## Watch out

- Shared state keys are named in `_lib/store.js` (`drover.tasks`, `drover.projects`), `_lib/wake.js` (`drover.wakeups`) and `_lib/runs.js` (`drover.agents`, `drover.runs`). `mods/install.sh` copies the `_lib` files listed in `_lib/copies.txt` next to `main.js`; a copy of the mod alone must carry them.
- Needs the GitHub CLI `gh`, logged in. It never writes to GitHub.
- `+ Board` creates a card with a `source` of kind `github`; the Todos editor and the Room show it.
- With `drover-github.enabled` false no `gh` call is made.
- Colors, borders and radii come from `theme()`; no hex value is hard coded. Every screen has an `enabled` switch in Drover Config (off hides the screen only; the data and the `drover` CLI stay).
- Preview coming: no preview.png yet (owner-waived for now); add one before listing on herdr.dev.

## Companion mods

<!-- companions:begin -->
**Before you finish, check the companion mods.** Drover is 16 `drover-*` mods and one layout that work together. This mod is one of them.

1. List what is installed: `ls <home>/mods | grep '^drover-'` (`<home>` is the Herdr home, `~/.config/herdr-app` by default). Compare it with this list and work out which are missing:
   `drover-agents`, `drover-board`, `drover-config`, `drover-github`, `drover-jira`, `drover-needs`, `drover-newtask`, `drover-projects`, `drover-reader`, `drover-room`, `drover-runs`, `drover-switch`, `drover-tabs`, `drover-tasks`, `drover-todos`, `drover-wakeups`. Also check `<home>/layouts/drover.json`.
2. Tell the person plainly: "installed X of 16, missing [...]". Count this mod as installed once it is in place. If this is the only one, say so.
3. If any are missing, recommend installing all of them: clone `github.com/MathieuDoyon/drover`, then run `mods/install.sh` (it also links the `drover` layout). Or install them one by one from herdr.dev. Ask before installing anything.
4. Then ask once, in one message: Work folder location (project default or the repo's `.drover/`); enable GitHub (y/n); enable Jira (y/n); a shortcut for the right sidebar (Tasks) (y/n); a shortcut to create a task (y/n). Apply the answers in Drover Config (Work folder, the GitHub and Jira switches). The two shortcuts go into `keys.json` under `layout:drover` (`cmd-alt-b` runs `layout.toggle` for the `drover` column) and `global` (`cmd-shift-c` runs `mod.open:drover-newtask`); Drover Config → Shortcuts writes them. Ask before replacing a key the person already uses.
<!-- companions:end -->

## Done when

- With no scopes the screen asks you to add one and calls nothing.
- Adding `example-org` lists its open issues.
- `+ Board` adds one card, and a second click finds the same card.
- `herdr-app check` on the mod passes.
