# Planning

- Use distinct models matched to the work. Gemini is excluded by the user's explicit instruction.
- For future sessions, launch the native `claude` and `codex` CLIs through `hc`, not `cursor-agent` or Cursor's `agent` CLI. Use `codex --no-daemon` so execution stays inside hc. This does not require restarting existing rooms.
- State a bounded slice, dependencies, non-goals, source references, and completion criteria in each room brief.
- Each task includes user outcome, acceptance criteria, failure cases, dependencies, and verification. Do not estimate precision unsupported by evidence.
- Each room returns recommendations and unresolved product decisions. Cross-room disagreements require synthesis, not majority voting.
- Keep initial independent scoping separate from later cross-review and final approval.
