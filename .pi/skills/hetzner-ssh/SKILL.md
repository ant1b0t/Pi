---
name: hetzner-ssh
description: Use when you need to connect to configured Hetzner/VPS servers over SSH, handle passphrase-protected keys safely via temporary key copies, run remote shell commands, inspect server state, or transfer files with scp. Keywords: ssh, scp, server, hetzner, vps, remote shell, deploy, passphrase, key, root.
allowed-tools: Bash
---

# Hetzner SSH Skill

## Purpose

Use this skill for recurring work on remote servers reachable via local SSH config, especially Hetzner hosts such as `hetzner` and `hetzner2`.

This skill standardizes:
- safe use of passphrase-protected SSH keys
- temporary key copy workflow for non-interactive sessions
- remote command execution over SSH
- file transfer with `scp`
- cleanup of temporary unencrypted keys after work is finished

## Safety Rules

1. **Never modify the original private key** to remove a passphrase.
2. **Always create a temporary copy** if non-interactive SSH or SCP is needed.
3. **Remove the passphrase only from the temporary copy**.
4. **Delete the temporary key immediately after the server work is complete** unless the user explicitly says to keep it temporarily.
5. Prefer `BatchMode=yes` for connectivity/auth checks when you need deterministic success/failure.
6. Prefer aliases from `~/.ssh/config` when available.
7. Do not print private key contents.
8. Before destructive remote actions, restate the exact command and intent.

Project convention from `CLAUDE.md`:

> For SSH keys protected with a passphrase, do not rely on interactive passphrase entry. Create a temporary copy of the key, remove the passphrase only from the temporary copy with `ssh-keygen -p -P <old> -N "" -f <temp_key>`, use that copy for `ssh`/`scp`, then delete it immediately after use. Do not modify the original key unless explicitly required.

## Known Host Pattern

If `~/.ssh/config` contains aliases like:

```ssh-config
Host hetzner
    HostName 178.104.47.116
    User root
    IdentityFile C:\Users\Asus\.ssh\hetzner_key

Host hetzner2
    HostName 46.225.150.255
    User root
    IdentityFile C:\Users\Asus\.ssh\hetzner_key
```

prefer:

```bash
ssh hetzner2
```

For explicit non-interactive runs with a temporary key on Windows/Git Bash style environments, prefer a Unix-style path like `/c/Users/Asus/.ssh/<temp_key>` when invoking `ssh` from bash.

## Standard Workflow

### 1. Inspect SSH config

Check aliases and key paths:

```bash
python - <<'PY'
import os
p = r'C:\Users\Asus\.ssh\config'
print(open(p, 'r', encoding='utf-8').read())
PY
```

### 2. Create a temporary key copy

Windows/Python-safe example:

```bash
python - <<'PY'
import shutil, subprocess
src = r'C:\Users\Asus\.ssh\hetzner_key'
tmp = r'C:\Users\Asus\.ssh\hetzner2_temp_key'
shutil.copyfile(src, tmp)
subprocess.run(['ssh-keygen', '-p', '-P', '<PASSPHRASE>', '-N', '', '-f', tmp], check=True)
print(tmp)
PY
```

### 3. Verify remote access non-interactively

```bash
python - <<'PY'
import subprocess
key = '/c/Users/Asus/.ssh/hetzner2_temp_key'
cmd = [
    'ssh',
    '-i', key,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    'root@46.225.150.255',
    'echo connected && hostname && whoami'
]
res = subprocess.run(cmd, capture_output=True, text=True)
print(res.stdout)
print(res.stderr)
print('RC=', res.returncode)
PY
```

### 4. Run remote commands

```bash
python - <<'PY'
import subprocess
key = '/c/Users/Asus/.ssh/hetzner2_temp_key'
remote_cmd = 'pwd && uname -a && docker ps --format "table {{.Names}}\\t{{.Status}}"'
cmd = ['ssh', '-i', key, '-o', 'IdentitiesOnly=yes', 'root@46.225.150.255', remote_cmd]
res = subprocess.run(cmd, capture_output=True, text=True)
print(res.stdout)
print(res.stderr)
print('RC=', res.returncode)
PY
```

### 5. Copy files with SCP

Upload:

```bash
scp -i /c/Users/Asus/.ssh/hetzner2_temp_key ./local.file root@46.225.150.255:/root/
```

Download:

```bash
scp -i /c/Users/Asus/.ssh/hetzner2_temp_key root@46.225.150.255:/root/remote.file ./
```

### 6. Cleanup temporary key

```bash
python - <<'PY'
from pathlib import Path
p = Path(r'C:\Users\Asus\.ssh\hetzner2_temp_key')
p.unlink(missing_ok=True)
p.with_name(p.name + '.pub').unlink(missing_ok=True)
print('deleted', p)
PY
```

## When To Use

Use this skill when the user asks to:
- connect to Hetzner or other known VPS hosts
- run commands on a remote Linux server
- inspect processes, Docker, systemd, logs, disk, or network state remotely
- upload or download deployment artifacts
- work around passphrase-protected SSH keys in a safe non-interactive way

## Tips

- On Windows with bash-based tool execution, `ssh -i C:\...` may be parsed badly; prefer `/c/Users/...` path form.
- If auth fails with `Permission denied (publickey,password)`, verify:
  - the correct host alias
  - the correct private key
  - whether the public key is installed on the server
  - whether you are connecting as the right user
- Use `BatchMode=yes` for checks, but remove it if the user explicitly wants an interactive session.
- If the user says not to delete the temporary key yet, keep it only for the active working window and remind them later.

## Response Pattern

When using this skill, respond briefly with:
1. which host/alias you used
2. whether auth succeeded
3. exact command run
4. key cleanup state
