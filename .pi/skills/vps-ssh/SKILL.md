---
name: vps-ssh
description: Use when you need to connect to a VPS or remote Linux server over SSH, safely handle passphrase-protected keys via temporary copies, run remote shell commands, inspect server state, or transfer files with scp. Keywords: ssh, scp, vps, server, remote, deploy, passphrase, key, linux.
allowed-tools: Bash
---

# VPS SSH Skill

Use this skill for routine work on remote servers reachable via SSH config or explicit host/user/key values.

## Rules

- Never remove a passphrase from the original private key.
- If non-interactive SSH/SCP is needed, create a temporary key copy and remove the passphrase only from that copy.
- Delete the temporary key after work unless the user explicitly asks to keep it for the current session.
- Prefer `BatchMode=yes` for deterministic auth checks.
- Do not print private key contents.

Project rule from `CLAUDE.md`:

> Create a temporary copy of a passphrase-protected key, remove the passphrase only from the temporary copy with `ssh-keygen -p -P <old> -N "" -f <temp_key>`, use that copy for `ssh`/`scp`, then delete it.

## Workflow

### 1) Inspect SSH config

```bash
python - <<'PY'
print(open(r'C:\Users\Asus\.ssh\config', 'r', encoding='utf-8').read())
PY
```

### 2) Prepare temporary key copy

```bash
python - <<'PY'
import shutil, subprocess
src = r'C:\Users\Asus\.ssh\my_key'
tmp = r'C:\Users\Asus\.ssh\temp_vps_key'
shutil.copyfile(src, tmp)
subprocess.run(['ssh-keygen', '-p', '-P', '<PASSPHRASE>', '-N', '', '-f', tmp], check=True)
print(tmp)
PY
```

### 3) Verify access

With SSH alias:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 my-vps "echo connected && hostname && whoami"
```

With explicit temp key in bash-style environments:

```bash
ssh -i /c/Users/Asus/.ssh/temp_vps_key -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 root@203.0.113.10 "echo connected && hostname && whoami"
```

### 4) Run remote command

```bash
ssh -i /c/Users/Asus/.ssh/temp_vps_key -o IdentitiesOnly=yes root@203.0.113.10 "pwd && uname -a"
```

### 5) Transfer files

```bash
scp -i /c/Users/Asus/.ssh/temp_vps_key ./local.file root@203.0.113.10:/root/
scp -i /c/Users/Asus/.ssh/temp_vps_key root@203.0.113.10:/root/remote.file ./
```

### 6) Cleanup temp key

```bash
python - <<'PY'
from pathlib import Path
p = Path(r'C:\Users\Asus\.ssh\temp_vps_key')
p.unlink(missing_ok=True)
p.with_name(p.name + '.pub').unlink(missing_ok=True)
print('deleted', p)
PY
```

## Tips

- In bash on Windows, prefer `/c/Users/...` in `ssh -i` and `scp -i`.
- If auth fails with `Permission denied (publickey,password)`, check host, user, key, and whether the public key is installed on the server.
- Use aliases from `~/.ssh/config` when possible.

## Response Pattern

State briefly:
1. host/alias
2. auth result
3. command run
4. temp key status
