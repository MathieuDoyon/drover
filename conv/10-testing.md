# Verification

- Report executed commands separately from supplied logs, documentation, and proposed tests. Unrun, blocked, and partial checks are not passes.
- Planning reports need evidence for capability claims and testable acceptance criteria for stories.
- Validate relative Markdown links and inspect every changed document before handing off.
- For future mod work, use both `herdr-app check` and an actual native UI check. A browser mockup cannot prove native behavior.
- Scheduler and orchestration stories must cover restart, retries, duplicate attempts, cancellation races, offline machines, and blocked agents.
