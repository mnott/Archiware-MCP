---
name: setup
description: >
  Install, configure and verify Archiware MCP (archiware-mcp), the MCP server and CLI for Archiware P5 backup servers.
  USE WHEN user says "set up Archiware", "install archiware-mcp", "connect Claude to my Archiware / P5 server",
  "configure Archiware MCP", or asks whether the Archiware connection is healthy.
  Phase-based and idempotent: every phase checks its state first and only does what is missing.
---

# Archiware MCP setup

Work through the phases in order. Run the check of a phase first; if it already passes, say so and move on. Ask the user one question at a time. Prefer `archiware` commands over editing files by hand; `archiware setup --help` is the reference.

**Never ask for, accept or print the REST password in chat.** The user types it into the hidden prompt of `archiware setup` (or creates the password file themselves, see phase 4). Do not put it in a command line, an environment variable or a file you write.

This project is unofficial: not affiliated with or endorsed by Archiware GmbH. P5 is their trademark. There is no npm registry step: the install is the GitHub Release tarball. Never run `npm login` or `npm publish`.

## 1. Prerequisites

Check: `node --version` (needs 20 or newer), `claude --version`, `git --version`.

- Node missing or older than 20: install a current LTS (brew, nvm, or the system package manager).
- Claude Code missing: the user installs it from the official installer and runs `claude` once to log in. Setup still works without it; it then prints the registration command.
- Linux: use an npm prefix in the home directory so `npm i -g` needs no sudo: `npm config set prefix ~/.npm-global` and put `~/.npm-global/bin` on PATH.

Verify: all commands print a version.

## 2. Install the package

Check: `archiware version`.

Whether the user said "Clone https://github.com/mnott/Archiware-MCP and set it up for me" or started from scratch, install the released tarball (the clone is only where these instructions came from):

```
npm i -g https://github.com/mnott/Archiware-MCP/releases/latest/download/archiware-mcp.tgz
```

Fallback when no release exists yet or the user wants the clone itself (for development): inside the clone run

```
npm install && npm run build && npm link
```

Update later by re-running the install line, or `archiware update` (`archiware update --check` only reports).

Verify: `archiware version` prints a version. If `archiware` is not found, add `$(npm prefix -g)/bin` to PATH and open a new shell.

## 3. Ask where Archiware runs

Ask the user, one question at a time, and wait for each answer:

1. **Where does Archiware P5 run?**
   - `docker`: P5 runs in a container on a host the user reaches with ssh.
   - `ssh`: P5 is installed natively on a remote host reached with ssh.
   - `local`: P5 is on this machine.
2. docker and ssh: **the ssh host** (as in `ssh <host>`). It must work without a password prompt: check `ssh -o BatchMode=yes <host> true`. If it fails, help the user set up key login (`ssh-copy-id <host>` or an entry in `~/.ssh/config`) before going on.
3. docker only: **the container name** (the user can find it with `ssh <host> docker ps`), **the container IP** (`ssh <host> docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <container>`), **the docker compose directory** on the host, and **a backup directory** on the host with enough free space for a cold copy of the container (used by `container_backup`).
4. ssh and local: **the P5 install directory** (default `/usr/local/aw`; nsdchat is `<dir>/bin/nsdchat`).
5. **The REST user** (default `admin`). The password is entered by the user in phase 4, never in chat.
6. Optional, tape library: **the changer device** (`/dev/sgN`, `lsscsi -g` on the P5 host shows it). Setup tries to detect it; skip when there is no library. Host-side tape operations use `sudo -n mtx` / `mt` on the P5 host, so passwordless sudo for those is needed there.

You may suggest values from the commands above (read-only), but let the user confirm every answer.

## 4. Run setup

The REST password needs a terminal. Two ways, pick one with the user:

- **Setup prompts for it** (preferred): the user runs setup themselves in this session with the `!` prefix so it gets their terminal, for example
  `! archiware setup --mode docker --ssh-host <host> --container <name> --container-ip <ip> --compose-dir <dir> --backup-dir <dir> --rest-user admin`
  and types the password at the hidden prompt.
- **The user creates the password file first**, then Claude runs setup non-interactively:
  `! umask 077; mkdir -p ~/.config/archiware-mcp; read -rs PW && printf '%s\n' "$PW" > ~/.config/archiware-mcp/rest.password; unset PW`
  then `archiware setup --yes --rest-password-file ~/.config/archiware-mcp/rest.password <the other flags>`.

Setup checks prerequisites, detects the changer, writes `~/.config/archiware-mcp/config.json`, keeps the password file at mode 600, registers the MCP server with Claude Code (`claude mcp add ... -s user`; if the `claude` CLI is missing it prints the exact command) and ends with the doctor list. It is idempotent: re-running only changes what is missing or wrong, so use it again after fixing a failure.

Tape drives (`element`, `gen`, `nst`, `p5`) cannot be guessed. If the user wants `tape_load`, `tape_erase` or `clean_drive`, help them add a `drives` array to the config (see the README).

## 5. Verify

```
archiware doctor
```

Report the pass/fail list to the user line by line. Every `fail` has a fix hint; fix it with the user and re-run `archiware doctor`. Exit code 0 means no fail (warnings are allowed, explain them).

Then tell the user to restart Claude Code (or run `/mcp`) so the `archiware` MCP server is loaded, and offer a first read-only call: `archiware status`.

## Safety reminder

Mutating tools only act with `confirm: true` (CLI: `--yes`); without it they print what would run. Never confirm `label_tapes`, `tape_erase`, `container_*` or `restore` on the user's behalf without them asking for exactly that.
