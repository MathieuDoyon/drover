# Lessons and the retro

A lesson is a short, generic note of what your org learned (for example "Run the full check before review"). Drover reads lessons at launch and passes them on as advice. After a drive, the **retro** proposes new ones; you decide each. The writer's reference is in [Agents and the herd](../agents.md#lessons-writer).

## Where lessons live

Three layers, each a plain Markdown file under `~/.config/drover-herdr`:

| Scope | File |
| --- | --- |
| org | `orgs/<slug>/lessons.md` |
| project | `projects/<id>/lessons.md` |
| agent | `agents/<id>.lessons.md` |

Precedence when two disagree: the herd rules (`_herd.md`) and the card, then agent, then project, then org. Lessons are **advisory only**: they never allow a push, a PR, a merge or a post, and there are no permission entries.

## When the retro runs

- When Drover brings the herd in (step 7b).
- When you type `retro` to Drover.
- In queue mode, once, after you say "all pass, close".

## What the retro does

1. Drover writes candidates from its own context, the plan file and the card notes, in its own words. It never reads or quotes agent transcripts or terminal screens.
2. Each candidate goes through `drover-lessons check` (on stdin) before you see it. A candidate that fails (a secret-shaped string, bad format) is dropped; you are told the count and the rule, never the text.
3. Drover compares the rest with the full files of every layer and labels each: **new**, **duplicate** (dropped), **refines L-nn**, or **contradicts L-nn**. A contradiction is your call; it is never applied on its own.
4. For each item you see the exact text, the scope and file, and the label. You choose **add**, **edit**, **remove**, **confirm** or **skip**, and you pick the scope (org, project or agent). Edit and remove show a before/after diff.
5. Nothing is written until you choose for that item. Skip, or no answer, writes nothing. Edit, remove and confirm carry the entry's token (`--expect`); if the entry changed meanwhile, the writer answers `stale: re-review` and Drover shows it again. Add takes no token.

Drover records only ids and counts in the plan file. Default agents, souls and squads are never edited by the retro.

## What a scan cannot do

The check fails closed on token prefixes, credentials in URLs, emails, long hex or base64 runs, code fences and over-long text. **A scan cannot prove an entry is clean**: read the exact text before you choose add.

## Edit by hand

The files are plain text; you can edit them yourself. Prefer `drover-lessons` (each verb except `check` needs one scope: `--org <slug>`, `--project <id>` or `--agent <id>`; for example `list --full --org <slug>`, `stale --days 90 --org <slug>`, `edit`, `rm`, `confirm`): it checks the format, keeps the old file as `.<file>.prev` and refuses links.

Mods reload only when the Herdr window is reopened, so a changed soul takes effect after that.
