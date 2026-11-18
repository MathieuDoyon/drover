# Drover Config

One dialog to change what the Drover mods let you set: settings per mod, the work folder and the keyboard shortcuts.

## What you see

An 860x620 dialog. Left: the list of mods plus `General` and `Shortcuts`. Right: one row per setting with its title, a help line, a field (switch, number with -/+ buttons, text, or a comma list), `Reset`, and an "applies when the screen reopens" note for timers. An invalid value is explained under its row and never written. Footer: `Close`.

## How it behaves

- Writes only the shared key `drover.config` (`{ "<mod>": { "<key>": value } }`), and only the values you changed; `Reset` puts the default back. A draft stays while another copy saves.
- One setting is also writable by an agent on the owner's request: `drover-runs.max_parallel` (`drover config max-parallel <n>`, inbox op `config-set`, protocol 5). It writes the same override in `drover.config` as the dialog, and the dialog shows it as changed with `Reset`. Every other setting stays dialog-only.
- `General` holds the Work folder (`project` or `repo`) with a two-step "Move existing .drover files here": the button asks, the Move click does it.
- `Shortcuts` reads and writes `keys.json` (read again after every write): sidebar toggle `cmd-alt-b` in `layout:drover`, create task `cmd-shift-c` in `global`.
- Settings include each screen's `enabled`, Board `visible_columns`, Jira `site` / `jql` / `pages`, GitHub scopes and `limit`, Room `refresh_minutes`, Runs `max_parallel`, Wakeups `min_repeat_minutes` / `expiry_hours`.

## Built from

- Mod `drover-config`, `place: none`, overlay `{ "width": 860, "height": 620 }` in `mod.json`, files `main.js` (the dialog), `model.js` (pure dialog model) and the shared libraries below, written as these modules: `config-schema.js` (the schema, `validate`), `config.js` (the layers, `cfg`, `gate`, `isEnabled`, `setOverride`, `resetOverride`, `bind`, `load`), `keys.js` (the shortcuts) and `query.js` (the GitHub query parser, `parseQuery`, used to validate `drover-github.query`).
- `herdr` imports: `shared`, `setShared`, `theme`, `props`, `closeOverlay`.

**Storage.** One shared key `drover.config` = `{ "<mod>": { "<key>": value } }`, holding only the values the person changed. Three layers, the first valid one wins; an invalid or out-of-range value falls through: (1) `drover.config`, read live on each call; (2) the mod's own `mod.json` `settings` block (only after that mod's settings load); (3) the schema default. `cfg(mod, key)` throws on an unknown mod or key. `gate(mod)` is `on`, `off` or `loading`; `isEnabled(mod)` is true only when decided on. A mod with no `enabled` field (`drover-config`, `drover-tabs`, `drover-newtask`) is always on. Resetting a field removes its override (never writes the default); an override equal to the default is still stored and then beats an inherited `mod.json` value. `drover-config.work_folder` accepts the alias `run` as `project`.

**Value rules** (`validate`): boolean must be true/false. Int must be a whole number within the range. Text is trimmed, no control characters or line breaks, at most 2000 characters, empty only when the field allows it, and must match its pattern when it has one (`default_squad`: `^[A-Za-z0-9][A-Za-z0-9._-]*$`; `site`: `^[A-Za-z0-9][A-Za-z0-9.-]*$`, a bare host only, no scheme or slash). Enum must be one of the values. A list is a list of such texts; a closed list (`visible_columns`, from `backlog, todo, doing, review, blocked, done`) keeps known members only, in that order, without duplicates, and needs at least one. In the dialog, int and list fields are typed as text and parsed first (an int must match `-?\d+`; a list is comma separated); the GitHub default query must also parse to at least one term ("Not a usable GitHub query…").

**Settings schema** (every setting; `live` applies at once, `on reopen` applies when the screen reopens because the host fixes a timer when it starts). `enabled` exists for the 11 screens `agents, board, github, jira, projects, reader, room, runs, tasks, todos, wakeups`, default on:

| Mod | Key | Type | Range / values | Default | Applies | Meaning |
|---|---|---|---|---|---|---|
| `drover-config` | `work_folder` | enum | repo \\| project | `project` | live | Where agents write plans, scouts, reviews and lane logs |
| `drover-agents` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-board` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-github` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-jira` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-projects` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-reader` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-room` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-runs` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-tasks` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-todos` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-wakeups` | `enabled` | boolean | on/off | `true` | live | Show this screen |
| `drover-agents` | `default_squad` | text | pattern /^[A-Za-z0-9][A-Za-z0-9._-]*$/, may be empty | `""` | live | Squad the start dialog selects when nothing was used before |
| `drover-agents` | `default_worktree` | boolean | on/off | `false` | live | Start the dialog with Own git worktree ticked |
| `drover-agents` | `default_report` | boolean | on/off | `false` | live | Start the dialog with Report to Drover ticked (it needs a running Drover) |
| `drover-board` | `visible_columns` | list | subset of backlog, todo, doing, review, blocked, done, at least 1 | `backlog, todo, doing, review, blocked, done` | live | Columns the board and its list view show, from: backlog, todo, doing, review, blocked, done |
| `drover-board` | `default_sort` | enum | manual \\| priority \\| newest | `manual` | live | How each column sorts its cards |
| `drover-github` | `query` | text | text | `is:issue state:open` | live | Search used when no filter was committed, and by Reset filter |
| `drover-github` | `scopes` | list | list of text | `[]` | live | Orgs or owner/repo shown when none were added |
| `drover-github` | `limit` | int | 1-1000 | `100` | live | Most issues and PRs fetched for each scope |
| `drover-jira` | `jql` | text | text | `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` | live | Query used when you have not run one |
| `drover-jira` | `pages` | int | 1-20 | `4` | live | Pages of 50 issues fetched before the list is marked partial |
| `drover-jira` | `refresh_minutes` | int | 1-1440 | `5` | live | How often the list reloads |
| `drover-jira` | `site` | text | pattern /^[A-Za-z0-9][A-Za-z0-9.-]*$/, may be empty | `""` | live | Your Jira host, for example acme.atlassian.net |
| `drover-room` | `refresh_minutes` | int | 1-1440 | `5` | live | Minimum age before a run's context reloads |
| `drover-room` | `pr_cap` | int | 1-100 | `10` | live | Most pull requests linked from the issue that the Room loads for a run |
| `drover-room` | `kept_contexts` | int | 1-1000 | `30` | live | Runs whose loaded issue and PR context the Room remembers |
| `drover-runs` | `max_parallel` | int | 1-10 | `2` | live | Squad runs active at once for each project. A card in Review or Blocked keeps its slot while its run is active. An agent can change this on the owner's request (drover config max-parallel) |
| `drover-runs` | `kept` | int | 10-5000 | `200` | live | Ended runs remembered in the list |
| `drover-wakeups` | `min_repeat_minutes` | int | 1-1440 | `5` | live | A repeating wakeup may not fire more often than this |
| `drover-wakeups` | `expiry_hours` | int | 1-168 | `2` | live | A wakeup not delivered this long after its time expires |
| `drover-wakeups` | `ui_tick_seconds` | int | 1-3600 | `30` | on reopen | How often the countdowns repaint |
| `drover-todos` | `context_refresh_seconds` | int | 5-3600 | `60` | on reopen | How often an open task reloads its run and PR context |
| `drover-todos` | `pr_cap` | int | 1-100 | `10` | live | Most pull requests listed under a task |
| `drover-todos` | `run_history_cap` | int | 1-100 | `10` | live | Most past runs listed under a task |
| `drover-todos` | `wake_cap` | int | 1-200 | `20` | live | Most open wakeups, and most ended wakeups, listed under a task |
| `drover-reader` | `max_text` | int | 200-100000 | `4000` | live | Longer transcript entries are cut here and end with an ellipsis |

**The dialog.** Left: the mods that have settings (titles: `General` for `drover-config`, `GitHub`, else the capitalised name) and `Shortcuts`. Right: one row per setting: title, help (the full description), a control (switch for boolean, buttons for enum, `-`/`+` and a field for int, field for text and list), `Reset`, and a dim note "applies when the screen reopens" for non-live fields. A field saves on Enter or when it loses focus, and only when its text changed; an invalid draft stays in the field with its error under the row and nothing is written. A field that is not being edited follows the stored value. `Close` closes the overlay.

**Work folder move.** In `project` mode the General page lists existing `<repo>/.drover` folders of projects that could be moved into `~/.config/drover-herdr/work/<project id>/`; the button only asks, and the Move click inside the confirm row does it by running the `drover-workfolder move` helper (never overwrites, lists names that already exist). Reading never moves anything.

**Shortcuts** (`keys.js`). Two entries: `sidebar` (section `layout:drover`, key `cmd-alt-b`, binding `{ "command": "layout.toggle", "args": { "id": "drover" } }`) and `newtask` (section `global`, key `cmd-shift-c`, binding `"mod.open:drover-newtask"`). `keys.json` is read from the Herdr home on open, on selecting Shortcuts and after every write. It is touched only if it parses to an object **and** equals `JSON.stringify(parsed, null, 2) + "\n"` exactly; otherwise the page says so and writes nothing. Enabling adds only that one binding. If the combo is already bound to something else in the target section or in a section that would mask it (for `newtask`: every other section; for `sidebar`: `global`, `terminal`, `layout:drover` and every `mod:*`), it refuses with "<key> is already bound in keys.json (section S) to X; free that key first": it never replaces a key. If Drover's own binding is installed but another section also binds the combo, the state is on with a warning that the other binding takes over there. Disabling removes only Drover's exact binding and refuses to touch a key bound to something else.

## Watch out

- The schema, the layers and `keys.js` are given above in full: a build must match those keys, types, ranges and defaults exactly, or the other mods read settings differently (they call `cfg("<mod>", "<key>")` and throw on an unknown key).
- Opened from the `Drover ▾` menu of `drover-tabs` (Settings → Config); it has no tab entry of its own.
- A mod that is not installed still lists, but its rows have no effect.
- Timer settings (`ui_tick_seconds`, `context_refresh_seconds`) apply on reopen; everything else is live.
- Shortcuts refuse a bound key and a `keys.json` that is not in the standard 2-space format; nothing else in the file is ever reformatted.
- `drover-newtask` and `drover-tabs` have no `enabled` switch.
- Colors, borders and radii come from `theme()`; no hex value is hard coded.
- Preview coming: no preview.png yet (owner-waived for now); add one before listing on herdr.dev.

## Companion mods

<!-- companions:begin -->
**Before you finish, check the companion mods.** Drover is 14 `drover-*` mods and one layout that work together. This mod is one of them.

1. List what is installed: `ls <home>/mods | grep '^drover-'` (`<home>` is the Herdr home, `~/.config/herdr-app` by default). Compare it with this list and work out which are missing:
   `drover-agents`, `drover-board`, `drover-config`, `drover-github`, `drover-jira`, `drover-newtask`, `drover-projects`, `drover-reader`, `drover-room`, `drover-runs`, `drover-tabs`, `drover-tasks`, `drover-todos`, `drover-wakeups`. Also check `<home>/layouts/drover.json`.
2. Tell the person plainly: "installed X of 14, missing [...]". Count this mod as installed once it is in place. If this is the only one, say so.
3. If any are missing, recommend installing all of them: clone `github.com/MathieuDoyon/drover`, then run `mods/install.sh` (it also links the `drover` layout). Or install them one by one from herdr.dev. Ask before installing anything.
4. Then ask once, in one message: Work folder location (project default or the repo's `.drover/`); enable GitHub (y/n); enable Jira (y/n); a shortcut for the right sidebar (Tasks) (y/n); a shortcut to create a task (y/n). Apply the answers in Drover Config (Work folder, the GitHub and Jira switches). The two shortcuts go into `keys.json` under `layout:drover` (`cmd-alt-b` runs `layout.toggle` for the `drover` column) and `global` (`cmd-shift-c` runs `mod.open:drover-newtask`); Drover Config → Shortcuts writes them. Ask before replacing a key the person already uses.
<!-- companions:end -->

## Done when

- Changing Board `visible_columns` hides a column live.
- An out-of-range number is explained and not saved.
- Enabling the shortcuts writes both keys to `keys.json` and keeps the rest of the file.
- `herdr-app check` on the mod passes.
