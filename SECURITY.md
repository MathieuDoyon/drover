# Security

## Reporting a vulnerability

Report it privately with a GitHub security advisory: open this repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for a vulnerability.

Include what you found, how to reproduce it and the version or commit. You will get an answer as soon as the maintainer can read it.

## Never post secrets

Do not put tokens, API keys, passwords, the contents of `~/.config/drover-herdr/atlassian.json`, or private logs in an issue, PR or advisory. If you posted one by mistake, revoke it first, then tell us.

## Scope

Drover runs agents and shell commands on your machine and reads credentials from files you create (see [Jira setup](docs/guides/jira-setup.md) and [agent identity](docs/guides/agent-identity.md)). Reports about credential handling, command execution and file permissions are especially welcome.
