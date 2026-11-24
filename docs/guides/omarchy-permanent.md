# Retired: permanent Drover on a Linux test machine

**Retired 2026-11-24 (T-MWO2V65MUSX).** The second, independent board that ran `herdr-app` with the Drover mods on a Linux machine (the test machine) is gone. Its old install, update, rollback and inbox protocol runbook is deleted. For the current way to use a remote machine, read [Remote machines](remote-machines.md) (the exec transport and `drover-headless`) and [Machines](machines.md).

## Removed on the test machine

- the systemd user service `drover-herdr` (stopped, disabled, unit file and enable symlink removed);
- the `herdr-app` release, `src/` copy of the mods, `checkout/` and the `current` and `~/.local/bin/herdr-app` symlinks under `~/.local/share/herdr-app`;
- `~/.config/herdr-app` (the old board `shared.json`, mod and layout symlinks, `service.env`);
- the `drover-herdr agents PATH` block in `~/.bashrc`, `~/.zshrc` and `~/.zshenv`.

The list and the raw output of each step are in the T-MWO2V65MUSX work folder (`retire-T-MWO2V65MUSX/step-*.txt`).

## Kept

- user lingering (`loginctl enable-linger`), so the machine keeps running without a login;
- `herdr-core serve` and its holder;
- `~/.local/share/drover-herdr` (the A2 install, `drover-headless`) and the headless board.

## No way back

There is no rollback to the inbox. The laptop no longer reads a machine's `shared.json` or writes its inbox (see [Remote machines](remote-machines.md#no-rollback-to-the-inbox)). To bring a machine back, install it the current way: `drover machines install`, then `migrate-in` if it has an old board.
