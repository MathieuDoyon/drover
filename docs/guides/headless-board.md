# Headless board writer

`drover-headless` is the board of one machine, without a Herdr window. It is installed with `drover machines install` (see [Machines](machines.md)) and run over `hc exec`. Any machine listed by `hc machine ls` works, Linux or macOS. Node must be on the machine: the launcher looks in `PATH`, then `DROVER_NODE_DIR` (or the node `install` recorded), then the common install folders, then version managers (nvm, fnm, asdf, volta, mise and others). With none found it prints `E_NODE_NOT_FOUND` on stderr and exits 69.

## Files

The board lives in `$DROVER_BOARD_DIR`, else `~/.local/share/drover-herdr/`, as `board.<gen>.json` (`<gen>` is a whole number). The newest number is the board; no file means an empty board. A generation holds only `schema`, `gen`, `writer`, `tasks`, `projects`, `agents` (ids and names), `nonces` and, after `migrate-in`, `migrated`. Layout, runs, wakeups and configuration are never stored here.

**Generations are never deleted or overwritten, and nothing prunes them in this version.** Each write adds one full generation, so the folder grows until a later compaction step exists. A writer writes a temp file in the same folder, fsyncs it, then hard-links it to the next name; if that name exists it re-reads and tries again (up to 20 times, then `busy`). It answers only after the link and a successful folder fsync; a replayed answer crosses the same folder fsync first. A filesystem that cannot fsync a folder is refused (`E_SYNC`), not tolerated. A killed process leaves the old board or the whole new one. This is a process-kill guarantee, not a power-loss proof. Temp files older than one hour are removed; nothing else is.

## Verbs

| Verb | Input | Answer |
| --- | --- | --- |
| `version --json` | none | `{cli, schema, ops}` |
| `rev --json` | none | `{gen, tasks, bytes}` (`tasks` is a hash of the task list) |
| `tasks --json`, `projects --json` | none | `{gen, rev, tasks}`, `{gen, projects}` |
| `add`, `edit`, `note`, `move`, `archive` | JSON on stdin | `{ok, gen, replayed, attempts, result}` |
| `project add` | JSON on stdin | the same (`project-add` is the internal op name, not a verb) |
| `import`, `move-out` | JSON on stdin | the same |
| `migrate-in --from <old shared.json>` | a path | `{ok, copied, skipped}` |

The payload is never an argument. Fields are those of the Drover inbox (`add`: `title`, `desc`, `tags`, `priority`, `column`, `project`, `parent`, `assignee`; `move`: `id`, `column`; and so on), plus an envelope: `nonce` (8-128 characters of letters, digits, `_`, `-`), `issuedAt` (milliseconds), `ttlMs` (1 to 600000) and optionally `ifRev`. The verb sets `op`.

## Retry, expiry, refusals

Send the same payload again to retry: a nonce seen in the last 24 hours with the same payload answers its stored result (`replayed: true`) and changes nothing; with another payload it is refused `nonce-reused`. An op older than its `ttlMs`, or issued more than 30 seconds ahead, is refused `expired` (checked again just before the commit), and so is any replay after the 24 hour retention. A refusal commits nothing. A card of a project bound to another machine, or a move into one, is refused (read-only here, as in the inbox). A stale `ifRev` is refused `stale`. Invalid ops get the inbox's own error text.

Exit status: 0 ok, 1 refused (`{ok:false, code, error}`), 2 usage, 69 no node. Codes: `bad-envelope`, `nonce-reused`, `expired`, `stale`, `refused`, `unknown-op`, `busy`, `board-corrupt`, `board-schema`, `no-link` (the folder's filesystem cannot hard-link), `E_SYNC` (the file or the folder could not be fsynced: nothing is acknowledged, and a retry of the same payload syncs the folder again before it answers), `io`.

## Used from the laptop

A remote project set to the `exec` transport reads this board with `version`, `rev`, `tasks` and `projects`, and writes it with the verbs above, one envelope on stdin per call (see [the exec transport](remote-machines.md#the-exec-transport-and-the-cutover)). The `ops` of `version` decide which controls the laptop turns on. `drover machines migrate-in <machine>` fills this board from the machine's old `shared.json` ([Machines](machines.md#migrate-in)).

## import, move-out, migrate-in

`import` creates a card from `{movedFrom, task}` with its notes; the same `movedFrom` again answers the existing card (and records its nonce in a generation that changes no card). `move-out` needs `ifRev`, refuses an archived card or one in progress with an agent attached, and archives the card with `movedOut: true`. Both are **minimal**: the pointer, closing note and destination checks of a safe machine move belong to the Local adapters (T-MWI9FEOTDFE), which must upgrade both ends before they are used.

`migrate-in` copies tasks and projects, and the ids and names of agents and squads, from an old `shared.json` (nothing else is read, and a task's `claimToken` is dropped). Existing ids are never overwritten. It writes the `migrated` marker last and can be run again.
