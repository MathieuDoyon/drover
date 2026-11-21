# Jira

A read-only list of Jira work from a saved JQL, with a button to add an issue to the Board as a linked card.

## What you see

A tab with the site and JQL line, a refresh state and a table of issues (key, summary, status, assignee, project, type). `+ Board` on a row makes a local card linked to the issue.

## How it behaves

- A search box of inline key:value tokens (project, status, assignee, reporter, type, label, priority, sprint, created, updated, order, raw `jql:`) builds the JQL; Enter runs it; it also refreshes every `refresh_minutes` (default 5, checked each minute).
- `pages` (x 50 issues, 1-20, default 4) caps a load.
- With no `site` set in Drover Config the screen asks for it and makes no request.
- A changed site or generation stops a running load and drops its result.

## Built from

- Mod `drover-jira`, `place: none`, `main.js` (about 130 lines), `mod.schema.json`.
- `herdr` imports: `shared`, `setShared`. Requests are in `_lib/io.js` (`jiraIssue`, `jiraKey` in `_lib/sources.js`), with Basic auth from `~/.config/drover-herdr/atlassian.json` (`email`, `apiToken`, mode 0600).
- Talks only to the site set in Drover Config (`drover-jira.site`).

## Watch out

- Shared state keys are named in `_lib/store.js` (`drover.tasks`, `drover.projects`), `_lib/wake.js` (`drover.wakeups`) and `_lib/runs.js` (`drover.agents`, `drover.runs`). `mods/install.sh` copies the `_lib` files listed in `_lib/copies.txt` next to `main.js`; a copy of the mod alone must carry them.
- Needs the credential file: see `docs/guides/jira-setup.md`. Never put its contents in a recipe or an issue.
- It reaches the network: tell the person before installing it.
- Optional: nothing else needs it; disable it in Drover Config.
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

- With no site, the screen asks for one and no request is made.
- With a site and credentials, the JQL list loads.
- `+ Board` adds one linked card.
- `herdr-app check` on the mod passes.
