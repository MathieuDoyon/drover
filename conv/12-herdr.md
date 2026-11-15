# Herdr

- Use `hc` for terminals and agent coordination; use `herdr-app` only for requested visible room/layout operations. The older `herdr` CLI is a different interface.
- Start with installed `--skill` and command help. Use returned terminal, space, and tab IDs; never derive them from examples.
- Give every grooming room an explicit name and this project's working directory. Check the actual folder instead of trusting a space's display name.
- Use `hc wait`, not sleep/poll loops, to wait for agents. Inspect blocked/error states and ask the user when approval is needed.
- Do not restart cores, change machines, or close unrelated terminals. Keep requested grooming rooms available for follow-up.
- Record model, harness, room address, scope, and evidence limitations for each session. Report requested versus verified model identity separately if verification is incomplete.

- Preserve a first-class right mod sidebar when adding reading views or floating top tabs. Center-view changes must not silently hide or replace it; collapsing remains an explicit user action with restore access.
