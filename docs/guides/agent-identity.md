# Owner setup: GitHub bot identity for an agent

Status: procedure for the owner (C6 of #13 Agent Identities). Run every step yourself in a normal Terminal, **not through an agent or tool**. No agent creates, reads or handles the real token. Enter it only in the hidden prompt. Do not paste the token, `hosts.yml` or an Authorization header into chat, a note or a card.

Owner decisions this follows: separate bot account (D1), standing approval permission for the identity (D2), private 0600 file storage (D4), no spikes first (D11). Scope: `.drover/agent-identities/scope.md` section 7 (C6).

## Why a separate account

GitHub blocks approving your own PR. The reviewer agent can approve PRs that your agents opened only as a different account. Dev agents never get this identity.

## 1. Create the machine account

1. Create a new GitHub account for the bot (for example `<you>-drover-reviewer`), with its own email address. Do not reuse your own account.
2. Enable two-factor authentication on it and store its recovery codes outside this machine's agent-readable files.
3. Check GitHub's terms for machine accounts before you rely on it. This was not checked by the scope.
4. Make the bot a **member of the organization** that owns the repositories, with **Write** access to each repo it reviews. A fine-grained token cannot act as an outside collaborator on another person's personal repository (GitHub limitation). For a **personal repository** (for example `owner/repo`), add the bot as a collaborator with **Write**, try a fine-grained token first (step 2), and if `gh` cannot see the repo (step 4d fails), use the classic-token fallback in step 2b. Do not move repositories on your own. Read-only access can leave a review, but GitHub does not count it toward required approvals. Whether an approval counts depends on your branch protection; do not change those rules for this.

## 2. Create a fine-grained token with minimum scope

Log in as the **bot**, then open <https://github.com/settings/personal-access-tokens/new>.

| Field | Value |
| --- | --- |
| Token name | `drover-reviewer` |
| Expiration | 30 to 90 days. Put the expiry date in your calendar. |
| Resource owner | The organization that owns the repositories (the bot must be a member) |
| Repository access | **Only select repositories**: the ones the bot reviews. Never "All repositories". |
| Repository permission: Pull requests | **Read and write** (needed to submit a review) |
| Repository permission: Contents | Read-only (only if the bot must read files or diffs of private repos) |
| Repository permission: Metadata | Read-only (added automatically) |
| Everything else | No access |
| Account permissions | None |

Limit to know: GitHub has no approve-only token. Pull requests: write also allows comments, edits and closing a PR. The token is the bot's whole power; keep it narrow and short-lived. An organization may require owner approval of the token before it works.

Copy the token once. Keep the page open until step 3 is done, then close it.

## 2b. Fallback: classic token (personal repos only)

Owner-approved fallback, only when step 2 cannot reach a personal repository. Log in as the **bot**, then open <https://github.com/settings/tokens/new> (classic).

- Scopes: **`repo` and `read:org`**, nothing else. `read:org` is needed because `gh` requires it at login; it is read-only and only covers organizations the bot belongs to.
- Expiration: 30 to 90 days. Put the expiry date in your calendar.
- Store it with the step 3 block, unchanged (hidden prompt, its own `GH_CONFIG_DIR`). Its prompt says "fine-grained"; paste the classic token there.
- Retry after a failed fine-grained attempt: the step 3 block refuses an existing directory. Revoke that token as the bot, delete that dedicated directory yourself (or choose a new `BOT` name).
- Trade-off: a classic token reaches **every** repository the bot can see. Make the bot a collaborator only on Drover repositories and never add it anywhere else.
- Classic `repo` also allows writes beyond a review (comments, pushes, merges where permitted). The Inspector soul's approve-only rule and your standing permission are the controls, not the token.
- Revoke it at <https://github.com/settings/tokens> as the bot, then delete the directory (see step 5).

## 3. Store it in a private `gh` config directory

The bot gets its own `gh` config directory so `gh` never falls back to your login. The token is stored in plain text in `hosts.yml` inside that directory (`--insecure-storage`), mode 0600, as with the Jira file in [the Jira setup guide](jira-setup.md). This avoids the macOS Keychain, whose behavior from a headless pane was not checked.

- Directory: `~/.config/drover-herdr/identities/<bot>/gh`, owner-only mode 0700 (the parents too).
- File: `hosts.yml` inside it, owner-only mode 0600, written by `gh`.
- Plain text can be read by other processes running as your user. Permissions do not defend against malicious same-user code. Do not put the directory on synced or shared storage.

Set `BOT` to a short name first (no spaces, letters, digits and `-` only), then run the block. The token prompt is hidden, so it stays out of shell history. The block refuses to overwrite an existing directory.

```sh
BOT=reviewer python3 - <<'PY'
import getpass, os, re, subprocess, sys
from pathlib import Path
if not sys.stderr.isatty():
    raise SystemExit('Run this yourself in an interactive Terminal.')
bot = os.environ.get('BOT', '')
if not re.fullmatch(r'[A-Za-z0-9-]{1,40}', bot):
    raise SystemExit('Invalid BOT name; nothing changed.')
base = Path.home() / '.config' / 'drover-herdr'
for d in (base, base / 'identities', base / 'identities' / bot):
    d.mkdir(mode=0o700, exist_ok=True)
    st = d.lstat()
    if d.is_symlink() or st.st_uid != os.getuid() or (st.st_mode & 0o077):
        raise SystemExit('Unsafe directory %s: stop and review its owner/permissions.' % d)
cfg = base / 'identities' / bot / 'gh'
if cfg.exists() or cfg.is_symlink():
    raise SystemExit('Config directory already exists; nothing changed. Do not overwrite blindly.')
cfg.mkdir(mode=0o700)
token = getpass.getpass('Bot fine-grained token (hidden): ')
if not token or re.search(r'[\x00-\x20\x7f]', token):
    raise SystemExit('Invalid token formatting; nothing stored.')
env = {k: v for k, v in os.environ.items() if k not in ('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN')}
env['GH_CONFIG_DIR'] = str(cfg)
r = subprocess.run(['gh', 'auth', 'login', '--hostname', 'github.com', '--with-token', '--insecure-storage'],
                   input=token.encode(), env=env)
if r.returncode != 0:
    raise SystemExit('gh login failed; review %s, no values printed.' % cfg)
os.chmod(cfg / 'hosts.yml', 0o600)
print('Stored. No credential values printed. Config dir:', cfg)
PY
```

After saving, reply only **identity saved**. If `gh` rejects a fine-grained token at login, or step 4d later fails on a personal repo, stop and report the exact error text (it holds no secret). Step 2b (classic token) is the owner-approved fallback for personal repos only.

## 4. Read-only identity check

Run this yourself. It only reads. Every command sets `GH_CONFIG_DIR`, pins `github.com` and clears the token and host variables so the result cannot come from your own login.

```sh
BOT=reviewer
export CFG="$HOME/.config/drover-herdr/identities/$BOT/gh"

# 4a. Permissions: expect 700 on the directory and 600 on hosts.yml.
stat -f '%Lp %N' "$CFG" "$CFG/hosts.yml"

# 4b. The bot login. Expect the bot's login, NOT yours.
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN -u GH_HOST GH_CONFIG_DIR="$CFG" gh api --hostname github.com user --jq .login

# 4c. Status (the token is masked by gh).
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN -u GH_HOST GH_CONFIG_DIR="$CFG" gh auth status --hostname github.com

# 4d. Reach one reviewed repo, read-only. Replace owner/repo.
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN -u GH_HOST GH_CONFIG_DIR="$CFG" gh api --hostname github.com repos/owner/repo --jq .full_name

# 4e. Fail-closed control: an empty config dir must FAIL, not use your login.
EMPTY="$(mktemp -d)"; env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN -u GH_HOST GH_CONFIG_DIR="$EMPTY" gh api --hostname github.com user --jq .login; echo "exit=$?"; rmdir "$EMPTY"
```

Pass when all hold:
- 4a prints `700` and `600`.
- 4b prints the bot login, different from yours.
- 4c shows `github.com` logged in as the bot.
- 4d prints the repository name.
- 4e exits non-zero with an authentication error. If it prints your login, `gh` fell back to another credential: stop and do not use this identity.

Never run `gh auth token`, `gh auth status --show-token` or `env`/`printenv` in an agent pane for this check. Do not run a write command (`gh pr review`, `gh pr comment`) as a test. A real approval proof needs separate permission.

## 5. Use it (Phase 0, by hand)

Give the reviewer pane the path, never the token: the agent command becomes `env GH_CONFIG_DIR=/home/user/.config/drover-herdr/identities/<bot>/gh <agent command>`. Write the full absolute path. Do not use `$HOME` or `~`: Drover splits the command on spaces and runs no shell, so they are not expanded. Only a path shows in the command. Also keep `GH_TOKEN` and `GITHUB_TOKEN` unset in that pane.

Honest limits (from the scope threat model):
- Environment variables and a 0600 file are not a sandbox. The agent, its children and other same-user code can read `hosts.yml`.
- A prompt injection in a PR can make an agent leak the credential or approve. Standing approval permission is your decision (D2); the token's narrow scope and expiry are the controls.
- Deleting the directory does not revoke the token. Rotation and cleanup: revoke the token as the bot (fine-grained: <https://github.com/settings/personal-access-tokens>; classic from step 2b: <https://github.com/settings/tokens>), then delete the directory yourself. A running agent keeps its old credential until it restarts.
- Not checked: Codex filtering of `*TOKEN*` variables (S1), `gh` behavior from a headless pane with a custom config dir (S2), GitHub machine-account terms, GitHub App reviews, fine-grained token acceptance by `gh auth login --with-token` on your `gh` version, and a fine-grained token against a real account. The classic-token path (step 2b) was tested once (owner, 2026-11-13): the bot login check (step 4b) passed. That is one test, not a broad proof.

## 6. The agent env file (built)

Drover now reads a private env file per agent (cards C1 to C4, #13). The shape is fixed in `.drover/agent-identities/scope.md` section 4.

How to set it up, no hand-written JSON:

1. Open the agent in the agent editor and go to its **Environment** section.
2. Add the variable `GH_CONFIG_DIR`. Its value is the **full absolute path** of the `gh` directory from step 3, for example `/home/user/.config/drover-herdr/identities/<bot>/gh`. Do not use `$HOME` or `~`. It is a path, not a token (the editor still masks every value, and stores it with `secret: true`; that is fine).
3. Save. The editor writes the file for you (directory 0700, file 0600).

From then on, `drover-env` starts that agent with the variables from its file, so the agent runs as the bot. You no longer wrap the command in `env GH_CONFIG_DIR=...` by hand (step 5 is the manual fallback). If the file exists but cannot be read or is invalid, the agent does not start: it never falls back to your own login.

- Path: `~/.config/drover-herdr/agents/<agent-id>.json`. Directory 0700, file 0600, at most 8 KiB.
- Profiles and run records hold names only, never values.
- Prefer a path over a token. Use a raw `GH_TOKEN` only when no store exists, and then **`GH_TOKEN` requires `GH_CONFIG_DIR`**: the editor, `drover-env-write` and `drover-env` all refuse a `GH_TOKEN` without it, because `gh` could otherwise act as your own login.
- Names match `^[A-Z_][A-Z0-9_]*$`. `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TERM`, `HC_*`, `HERDR_*`, `LD_*`, `DYLD_*` and `PYTHON*` are refused.

Example file with fake values only:

```json
{
  "version": 1,
  "env": {
    "GH_CONFIG_DIR": { "value": "/home/user/.config/drover-herdr/identities/reviewer/gh", "secret": false },
    "EXAMPLE_API_KEY": { "value": "fake-not-a-real-value", "secret": true }
  }
}
```
