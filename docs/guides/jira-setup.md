# Jira setup: private credential file

The `drover-jira` mod is optional. It reads one credential file that lives outside Git. **Run the setup below yourself in a normal Terminal**, not through an agent, and enter the credentials only in the hidden prompts.

- Directory: `~/.config/drover-herdr`, owner-only mode 0700.
- File: `~/.config/drover-herdr/atlassian.json`, owner-only mode 0600.
- Exact JSON fields: `email` and `apiToken` (a personal API token, Basic auth). No shell sourcing or environment export.
- Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
- Plain text can be read by other processes running as your user. Permissions do not give you Keychain-style encryption or defend against malicious code running as you. Follow your organisation's credential policy and do not put the file on shared or synced storage.

## Create the file without exposing values in shell history

The block refuses an existing file and an unsafe directory rather than overwriting or silently changing permissions. Both prompts are hidden. Never paste the values, the file contents or the Authorization header into a chat or an issue.

```sh
python3 - <<'PY'
import getpass, json, os, re, stat, sys
from pathlib import Path
if not sys.stderr.isatty():
    raise SystemExit('Run this yourself in an interactive Terminal.')
directory = Path.home() / '.config' / 'drover-herdr'
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
info = directory.lstat()
if directory.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('Unsafe directory: stop and review its owner/permissions.')
path = directory / 'atlassian.json'
if path.exists() or path.is_symlink():
    raise SystemExit('File already exists; nothing changed. Do not overwrite blindly.')
email = getpass.getpass('Atlassian email (hidden): ')
token = getpass.getpass('Personal API token (hidden): ')
if not re.fullmatch(r'[^\s:@]+@[^\s:@]+\.[^\s:@]+', email) or re.search(r'[\x00-\x20\x7f]', email) or len(email) > 254:
    raise SystemExit('Invalid email; file not created.')
if not token or re.search(r'[\x00-\x20\x7f]', token):
    raise SystemExit('Invalid token formatting; file not created.')
body = json.dumps({'email': email, 'apiToken': token}) + '\n'
if len(body.encode('utf8')) > 8192:
    raise SystemExit('Credential JSON too large; file not created.')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w', encoding='utf8') as output:
    output.write(body)
print('Saved owner-only credential file. No credential values printed.')
PY
```

After saving, the Jira screen reads the file on its next refresh. To rotate the token, create a new one in Atlassian, delete the old file yourself and run the block again. The block never overwrites.
