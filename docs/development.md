# Development

## Layout

- `mods/drover-*/`: the Herdr mods (plain JavaScript). `mods/_layouts/`: the `drover` layout. `mods/_lib/`: the shared library, copied into every mod by `mods/install.sh` (list in `mods/_lib/copies.txt`). Edit `_lib` only.
- `mods/_test/` and `mods/_lib/*.test.js`: the tests. `mods/_recipe/`: the shared block of every `RECIPE.md`.
- `deploy/`: the permanent-install scripts for a Linux box.

## Tests

`cd mods && ./install.sh` runs no tests: it copies the shared library, links the mods into your Herdr home and checks them (seconds, not minutes). To run the tests: `node --test mods/_lib/*.test.js mods/_test/*.test.js`. CI runs the same globs. The globs do not recurse into subfolders: that is the whole rule.

The slow install tests live in `mods/_test/install/` (`install-1..8`, `install-sweep`, `machines-install-1..3`, and the fake remote-machine harness tests `machine-rt` and `machines-fixture-children` with their helpers `machines-install-fixture.js` and `stubs/`): neither CI nor the pre-PR gate runs them. Run them by hand after any change to `mods/install.sh`, the machines install code (`mods/_lib/machines.js` and what it ships), the fake remote-machine harness (`mods/_test/install/machines-install-fixture.js`, `install/stubs/`), or code they run, and before you hand such a change over: `node --test --test-concurrency=4 mods/_test/install/*.test.js`. Put a new slow test in that folder; every other test goes in `mods/_test/`. Use `HERDR_APP_HOME=$(mktemp -d)` (with `mods` and `layouts` inside) to try the installer without touching your real home.

## Syncing the public repo

The public repository is a separate history: one commit per change, with the exact tree of private `main`, authored and committed by the noreply identity. `scripts/public-sync.sh` makes that commit.

**When:** after a change has merged to private `main` and its CI is green. One sync per change, so the public history reads one commit per card.

**How:** use an export clone whose `origin` is the public repository (`mods/_recipe/repo.txt`), and a private clone on an up-to-date `main`.

```
scripts/public-sync.sh --export <export clone> --private <private clone> --message "<msg>"           # dry run
scripts/public-sync.sh --export <export clone> --private <private clone> --message "<msg>" --push    # really push
```

The dry run prints the parent, the tree, the diff stat and the leak check, and commits nothing. Read it, then repeat with `--push`. The author and committer come from `PUBLIC_SYNC_NAME` and `PUBLIC_SYNC_EMAIL` (default: the maintainer's noreply identity; a fork sets its own).

**What it checks (it refuses, and prints why):** the export clone is clean; its `origin` fetch URL and every push URL are on github.com and name the repository in `mods/_recipe/repo.txt`; private `main` equals the private `origin/main`; the trees differ (otherwise there is nothing to sync); the added lines (binary files included) hold no leak: a home-folder path of a real person, the employer name, a Tailscale address (the 100.64/10 range), a GitHub personal or fine-grained token prefix, an Anthropic key prefix, a private-key header, or an API key, token or secret variable set to a value (the exact patterns are in the script). A hit is shown as `file:line` only, never the value.

**Recover:** the push is a plain push, never forced. If it is rejected, public `main` moved: re-run the dry run, which fetches again. A leak hit: fix it in private `main` (merge the fix), then sync. A dirty export clone: `git -C <export> status`, then clean it. A wrong commit already public: do not rewrite history; sync a corrective commit. Tests: `scripts/public-sync.test.sh` (temp repos and a local bare remote only).

## Pre-PR gate

`scripts/pre-pr-gate.sh [--base <ref>] [--all]` is the local check an agent runs on its final commit before it reports ready for a PR. It scans the added lines of `git diff <base>...HEAD` (default `origin/main`) and prints `file:line  rule`, never the matched text. Exit 0 is clean, exit 1 a hit, exit 2 "could not check" (bad base, no `node`, a failing or malformed `hc machine ls --json`, a broken private-words helper): 1 and 2 both block the PR. `--all` is not the gate but an inventory: it reads the whole tree at `HEAD` and prints counts per rule and per file (no values, no line numbers), and exits 1 while the tree has hits. Today those are the linked machine's name, used as a fixture and in the Linux-box docs; a later card makes those lines generic.

Rules: `leak` (the public-sync rules, shared in `scripts/leak-rules.awk`); `name` (a private word, whole word: this user, this host, the linked machines, plus `DROVER_PRIVATE_WORDS`, all read at run time from `mods/_test/private-words.js`); `name-split` (the same words once punctuation is stripped, over up to 3 consecutive added lines: a name split across literals or lines); `generic-name` (a test reads the account or host name itself instead of `runtimePrivateWords()`, which skips CI-generic names such as a runner's); `secret-fixture` (a secret-looking literal in a test file: build it by concatenation).

Limits: a name built from one unchanged and one added fragment, a reversed or encoded name, and pieces more than 3 lines apart are not caught; words under 4 characters are ignored. A hit that is legitimately in the tree goes in `scripts/pre-pr-gate.allow` as `path<TAB>rule<TAB>sha256 of the trimmed line`: one exact line under one rule, never a path; a `name-split` hit that spans lines can never be allowed (fix the code). A scanner that fails is exit 2, never clean. Tests: `scripts/pre-pr-gate.test.sh` (temp repos and `hc` stubs only).

## Recipes

Each mod and the layout has a `RECIPE.md`. The "Companion mods" section is generated: edit `mods/_recipe/companions.md`, then run `node mods/_recipe/sync.js`. `mods/_test/recipe.test.js` fails when a file is out of date.

## Renaming the repository

The repository name lives in two places only: `mods/_recipe/repo.txt` (owner/name; used by `companions.md` and so by every `RECIPE.md`) and the clone command in `README.md`. To rename: edit `mods/_recipe/repo.txt`, run `node mods/_recipe/sync.js`, and update the clone command in `README.md`. `mods/_test/repo-name.test.js` fails if the name appears anywhere else.

## The shared library and the copies

Herdr refuses imports from outside a mod folder, so every `drover-*` mod carries its own copy of the shared files in `mods/_lib/copies.txt` (plus `drover-config/query.js`, a copy of the GitHub query parser). `mods/install.sh` refreshes the copies and they are tracked in git, so a mod folder copied alone runs. `mods/_test/selfcontained.test.js` checks that every copy is present and byte-equal to `_lib`.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md). Tests first; run `mods/install.sh` before a pull request.
