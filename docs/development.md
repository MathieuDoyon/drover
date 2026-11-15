# Development

## Layout

- `mods/drover-*/`: the Herdr mods (plain JavaScript). `mods/_layouts/`: the `drover` layout. `mods/_lib/`: the shared library, copied into every mod by `mods/install.sh` (list in `mods/_lib/copies.txt`). Edit `_lib` only.
- `mods/_test/` and `mods/_lib/*.test.js`: the tests. `mods/_recipe/`: the shared block of every `RECIPE.md`.
- `deploy/`: the permanent-install scripts for a Linux box.

## Tests

`cd mods && ./install.sh` runs every test file (`node --test _lib/*.test.js _test/*.test.js`), then links the mods into your Herdr home and checks them. To run only the tests: `node --test mods/_lib/*.test.js mods/_test/*.test.js`. Use `HERDR_APP_HOME=$(mktemp -d)` (with `mods` and `layouts` inside) to try the installer without touching your real home.

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

## Recipes

Each mod and the layout has a `RECIPE.md`. The "Companion mods" section is generated: edit `mods/_recipe/companions.md`, then run `node mods/_recipe/sync.js`. `mods/_test/recipe.test.js` fails when a file is out of date.

## Renaming the repository

The repository name lives in two places only: `mods/_recipe/repo.txt` (owner/name; used by `companions.md` and so by every `RECIPE.md`) and the clone command in `README.md`. To rename: edit `mods/_recipe/repo.txt`, run `node mods/_recipe/sync.js`, and update the clone command in `README.md`. `mods/_test/repo-name.test.js` fails if the name appears anywhere else.

## The shared library and the copies

Herdr refuses imports from outside a mod folder, so every `drover-*` mod carries its own copy of the shared files in `mods/_lib/copies.txt` (plus `drover-config/query.js`, a copy of the GitHub query parser). `mods/install.sh` refreshes the copies and they are tracked in git, so a mod folder copied alone runs. `mods/_test/selfcontained.test.js` checks that every copy is present and byte-equal to `_lib`.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md). Tests first; run `mods/install.sh` before a pull request.
