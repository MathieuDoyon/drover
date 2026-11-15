# Verification

- Report executed commands separately from supplied logs, documentation, and proposed tests. Unrun, blocked, and partial checks are not passes.
- Planning reports need evidence for capability claims and testable acceptance criteria for stories.
- Validate relative Markdown links and inspect every changed document before handing off.
- For future mod work, use both `herdr-app check` and an actual native UI check. A browser mockup cannot prove native behavior.
- Scheduler and orchestration stories must cover restart, retries, duplicate attempts, cancellation races, offline machines, and blocked agents.
- Tests never wait for an async result with a tick count, a fixed sleep or a time budget. Use `until(cond, label)` from `mods/_test/stubs/until.js` (a 1 ms timer poll; its cap is a hang guard only) or await the real promise. `drain()` in the same file is only for "nothing happened" asserts. `FS_DELAY_MS=<n>` slows the fs stub to reproduce a slow runner.
