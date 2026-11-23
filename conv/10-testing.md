# Verification

- Report executed commands separately from supplied logs, documentation, and proposed tests. Unrun, blocked, and partial checks are not passes.
- Planning reports need evidence for capability claims and testable acceptance criteria for stories.
- Validate relative Markdown links and inspect every changed document before handing off.
- For future mod work, use both `herdr-app check` and an actual native UI check. A browser mockup cannot prove native behavior.
- Scheduler and orchestration stories must cover restart, retries, duplicate attempts, cancellation races, offline machines, and blocked agents.
- Slow tests live in `mods/_test/install/` (install and machines-install tests). CI and `mods/install.sh` run the globs `mods/_lib/*.test.js mods/_test/*.test.js`, which do not recurse, so those tests never run there. After any change to `mods/install.sh`, the machines install code, or code they run, run them by hand: `node --test --test-concurrency=4 mods/_test/install/*.test.js`, and report the result. An unrun install suite is "not checked", not a pass.
- Tests never wait for an async result with a tick count, a fixed sleep or a time budget. Use `until(cond, label)` from `mods/_test/stubs/until.js` (a 1 ms timer poll; its cap is a hang guard only) or await the real promise. `drain()` in the same file is only for "nothing happened" asserts. `FS_DELAY_MS=<n>` slows the fs stub to reproduce a slow runner.

## Test standards

- A test must be able to fail. No `assert.ok(x || true)`, no `>= 0` on a counter that only grows, no re-assert of a condition the test just waited on, no echo of a constant it just set.
- Assert behavior through a public seam (the exported function, the CLI, the op, the rendered output), not call order, internal state or source wording. Name the seams and the critical paths before writing tests.
- Contract tests stay as source or file-content tests on purpose: `copies.txt` equality, docs links, leak and security prohibitions, reader no-write/no-follow, packaging and self-containment.
- Removing or rewriting a test needs, per assertion, the retained test (file and name) that asserts it, and a representative fault that still fails that test. A tautology needs a one-line proof instead. Uncertain means keep.
- Never weaken, skip or delete a test to get green. Fix the code, or say the test is wrong and why.
- A mutation survivor is a lead, not a verdict. Call a check weak only after a valid mutant, loaded by the mapped tests, gives a wrong observable result that the kept assertions miss.
- Locking test files during agent runs: proposed, not implemented. Nothing in the repo stops an agent from editing a test; the review and the rules above are the only guard until a follow-up builds it.
