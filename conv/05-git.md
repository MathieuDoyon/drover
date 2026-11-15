# Git

- Work on a branch, or one separate worktree per task. No remote push, PR or merge without the user's permission.
- Once Git exists, inspect branch and worktree state before edits; preserve unrelated changes.
- Create branches or worktrees only within the requested topology. Never rewrite history or push without authorization.
- Keep credentials, runtime databases, and private raw logs out of commits.
- Public repo sync: after a merge to `main`, run `scripts/public-sync.sh` (dry run first); see [development](../docs/development.md#syncing-the-public-repo).
