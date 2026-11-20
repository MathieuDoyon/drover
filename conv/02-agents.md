# Agents

- Read the relevant files and preserve unrelated work. Distinguish verified behavior, user requirements, proposals, and historical evidence.
- Live connector or auth setup, service installation, changes to the user's Herdr app or core, and outward actions (push, PR, comments) need their own approved scope.
- Use `hc` for grooming-agent orchestration. Discover installed command syntax and available models before launching.
- Assign non-overlapping output ownership. Review combined results and reconcile contradictions before presenting an approved plan.
- Stop on permission or authentication dialogs and report the blocker. Never bypass them with forced input.
- Report evidence, missing checks, and remaining decisions. A model listing or successful process launch does not prove a completed task.
- Chain grant: a card that passes the low-risk checklist in [the Drover soul](../mods/drover-agents/souls/drover.md) may be given with "GO + whole chain": the Drover then runs the written chain (PR, checks, pinned merge on green, install, main CI, public-sync dry run then push, public CI, card done with issue sync, squad close) without another owner word. Each step stops on its own failure and revokes the grant; the leak check, the pre-PR gate and the native UI check are unchanged.
