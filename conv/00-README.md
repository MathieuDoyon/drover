# Agent conventions

This directory contains reusable working rules for AI agents contributing to Drover. User-facing documentation (install, guides, per-mod pages) belongs in `docs/`.

## Read order

1. Read [agents](02-agents.md), [Git](05-git.md), and [verification](10-testing.md) for every task.
2. Load the other topics when their triggers apply. Numbering is navigation, not a requirement to load every file.
3. Verify runtime facts against current code, installed CLI help, and generated Herdr types.

These conventions do not expand user authorization or override higher-priority instructions. Surface conflicts instead of silently changing policy.

| Topic | Read when |
| --- | --- |
| [Organisation](01-organisation.md) | Adding directories, moving files, or assigning document ownership |
| [Agents](02-agents.md) | Every task, including delegation and handoff |
| [Git](05-git.md) | Every task, especially initialization, branches, or worktrees |
| [Verification](10-testing.md) | Every task and completion report |
| [Security](11-security.md) | Credentials, networking, external content, or execution permissions |
| [Herdr](12-herdr.md) | Mods, layouts, hc, machines, or native UI |
| [Planning](13-grooming.md) | Scoping, task breakdown, model routing, or review |

## Maintenance

Keep one authoritative home per rule and use relative links. Add topics only when they have distinct task triggers. Do not create empty policy templates or copy command inventories. Architecture proposals are not approved decisions.
