# Development

## Layout

- `mods/drover-*/`: the Herdr mods (plain JavaScript). `mods/_layouts/`: the `drover` layout. `mods/_lib/`: the shared library, copied into every mod by `mods/install.sh` (list in `mods/_lib/copies.txt`). Edit `_lib` only.
- `mods/_test/` and `mods/_lib/*.test.js`: the tests. `mods/_recipe/`: the shared block of every `RECIPE.md`.
- `deploy/`: the permanent-install scripts for a Linux box.

## Tests

`cd mods && ./install.sh` runs every test file (`node --test _lib/*.test.js _test/*.test.js`), then links the mods into your Herdr home and checks them. To run only the tests: `node --test mods/_lib/*.test.js mods/_test/*.test.js`. Use `HERDR_APP_HOME=$(mktemp -d)` (with `mods` and `layouts` inside) to try the installer without touching your real home.

## Recipes

Each mod and the layout has a `RECIPE.md`. The "Companion mods" section is generated: edit `mods/_recipe/companions.md`, then run `node mods/_recipe/sync.js`. `mods/_test/recipe.test.js` fails when a file is out of date.

## Renaming the repository

The repository name lives in two places only: `mods/_recipe/repo.txt` (owner/name; used by `companions.md` and so by every `RECIPE.md`) and the clone command in `README.md`. To rename: edit `mods/_recipe/repo.txt`, run `node mods/_recipe/sync.js`, and update the clone command in `README.md`. `mods/_test/repo-name.test.js` fails if the name appears anywhere else.

## The shared library and the copies

Herdr refuses imports from outside a mod folder, so every `drover-*` mod carries its own copy of the shared files in `mods/_lib/copies.txt` (plus `drover-config/query.js`, a copy of the GitHub query parser). `mods/install.sh` refreshes the copies and they are tracked in git, so a mod folder copied alone runs. `mods/_test/selfcontained.test.js` checks that every copy is present and byte-equal to `_lib`.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md). Tests first; run `mods/install.sh` before a pull request.
