# Contributing

Thanks for helping. Drover is a set of Herdr mods (plain JavaScript) plus a small CLI.

## Setup

- Node 22 or newer, and Herdr (`herdr-app`) installed (see the Install section of the README).
- Clone, then run `cd mods && ./install.sh`. It runs the node tests, links the mods into your Herdr home and checks each one with `herdr-app check`.
- To try changes without touching your real data, point `HERDR_APP_HOME` at a scratch folder.

## Rules

- Edit the shared library only in `mods/_lib`. `install.sh` copies it into every `drover-*` mod; never edit the copies.
- Tests first: a behaviour change needs a test that fails on the old code and passes on the new. Tests live in `mods/_lib/*.test.js` and `mods/_test/`; a new `*.test.js` file there is picked up by the glob in `mods/install.sh` and CI. The slow install tests and the fake remote-machine harness tests live in `mods/_test/install/` and are run by hand after changes to the machines install code or that harness; see `docs/development.md`.
- Keep changes small and in the style of the code around them. No new dependencies without a reason.
- Never commit credentials, tokens, runtime data or private logs.

## Pull requests

1. Fork and branch from `main`.
2. Use conventional commit messages (`feat(tasks): …`, `fix(board): …`, `docs: …`).
3. Run `cd mods && ./install.sh` and make sure it ends green.
4. Open a PR that says what changed and how you checked it. Link the issue if there is one.
