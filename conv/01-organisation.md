# Organisation

- Keep reusable agent working rules in `conv/` and user documentation in `docs/` (install, guides, mods).
- Mods are plain JavaScript under `mods/`. The shared library is edited only in `mods/_lib`; `mods/install.sh` copies it into each mod.
- Keep runtime databases, caches, credentials, and private tracker payloads outside source control.
- Link to authoritative rules rather than repeating them. Treat dated evidence as revision-specific.
