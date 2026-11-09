# Archiware MCP

MCP server and CLI to manage an **Archiware P5** backup server from Claude Code or a terminal, without the P5 web UI: status, pools, volumes, plans, jobs, restores, tape library operations and, for container installs, cold backup and update of the P5 container.

> **Unofficial.** This project is not affiliated with, authorized or endorsed by Archiware GmbH. Archiware and P5 are trademarks of Archiware GmbH.

P5's scripting interface is `nsdchat`; since P5 8 there is also a REST API. This tool uses both (REST first, nsdchat as fallback and for what REST lacks) on the machine where P5 runs, reached over ssh or locally.

## Install

Prerequisites: [Claude Code](https://claude.com/claude-code) and Node.js 20 or newer.

The easy way: tell Claude Code

> Clone https://github.com/mnott/Archiware-MCP and set it up for me

Claude reads this repository, finds the setup skill (`skills/setup`) and walks you through it: it asks where Archiware runs and for the connection details one question at a time, runs `archiware setup`, then `archiware doctor`, and reports a pass/fail list. It never asks you to paste the REST password into chat: you type it at a hidden prompt.

Or by hand. There is no npm registry; the install is the GitHub Release tarball:

```
npm i -g https://github.com/mnott/Archiware-MCP/releases/latest/download/archiware-mcp.tgz
archiware setup
archiware doctor
```

Update by re-running the install line, or `archiware update` (`archiware update --check` only reports). From a clone instead: `npm install && npm run build && npm link`.

The same repository is also a Claude Code plugin (skill only): `claude plugin marketplace add mnott/Archiware-MCP`, `claude plugin install archiware@archiware`, then say "set up Archiware".

## Modes: where Archiware runs

Set once by `archiware setup` as the config key `mode`:

| mode | P5 runs | nsdchat runs as | REST | needs |
|---|---|---|---|---|
| `docker` | in a container on an ssh host | `ssh <sshHost> docker exec <container> nsdchat -c ...` | `https://<containerIp>:8443`, curl on the host | ssh key login, `docker` without sudo on the host |
| `ssh` | natively on a remote host | `ssh <sshHost> <p5Home>/bin/nsdchat -c ...` | `restUrl` (default `https://localhost:8443`), curl on that host | ssh key login |
| `local` | on this machine | `<p5Home>/bin/nsdchat -c ...` | `restUrl` (default `https://localhost:8443`), curl locally | permission to run nsdchat |

All tools work in every mode. The `container_*` tools exist only for docker mode and answer "not applicable" otherwise. Host-side tape operations (`mtx`, `mt`, `dd`) run on the P5 host in every mode (locally in local mode) and need passwordless `sudo -n` for them there.

## Configuration

`~/.config/archiware-mcp/config.json` (override the path with `ARCHIWARE_CONFIG`). `archiware setup` writes it; example for docker mode:

```json
{
  "mode": "docker",
  "sshHost": "backup-host.example",
  "container": "p5",
  "containerIp": "192.0.2.10",
  "composeDir": "/srv/archiware",
  "backupDir": "/srv/backup",
  "restUser": "admin",
  "restPasswordFile": "~/.config/archiware-mcp/rest.password",
  "changer": "/dev/sg3",
  "drives": [{ "element": 0, "gen": "L6", "nst": "/dev/nst0", "p5": "sg4" }],
  "cleaningSlot": 24
}
```

| key | mode | meaning |
|---|---|---|
| `mode` | all | `docker`, `ssh` or `local` |
| `sshHost` | docker, ssh | host reachable with plain `ssh <sshHost>` (key login) |
| `container` | docker | container name |
| `containerIp` | docker | container IP, reachable from the host (REST) |
| `composeDir` | docker | host dir of the compose project (cold copy source) |
| `backupDir` | docker | host dir where `container_backup` creates `archiware-update-<date>` |
| `p5Home` | ssh, local | P5 install dir, default `/usr/local/aw` (nsdchat = `<p5Home>/bin/nsdchat`) |
| `nsdchat` | all | override the nsdchat path |
| `restUrl` | ssh, local | REST base URL, default `https://localhost:8443` |
| `restUser` | all | REST user, default `admin` |
| `restPasswordFile` | all | file (mode 600) holding the REST password; read at call time only |
| `restTimeoutMs` | all | default 20000 |
| `changer` | all | tape changer device on the P5 host (`sudo -n mtx -f <changer> status`) |
| `drives` | all | tape drives, see below |
| `cleaningSlot` | all | slot holding the `CLN*` cleaning tape |
| `logPath` | all | lexxsrv log on the P5 host (job report blocks, health). Default `<p5Home>/log/lexxsrv.log` outside docker mode |
| `healthPaths` | all | paths whose free space `health` checks (`df -P`) |
| `timeoutMs` | all | command timeout, default 60000 |

`drives` maps each mtx Data Transfer Element to a tape generation (`L6` = LTO-6, `L9` = LTO-9), its `nst` device on the P5 host (mt/dd talk to it) and its P5 device name. The barcode suffix (`...L6` / `...L9`) selects the drive; a generation mismatch is refused. Drives cannot be detected reliably, so setup reports how many the changer has and you add them.

Environment overrides: `ARCHIWARE_CONFIG`, `ARCHIWARE_MODE`, `ARCHIWARE_SSH_HOST`, `ARCHIWARE_CONTAINER`, `ARCHIWARE_CONTAINER_IP`, `ARCHIWARE_REST_URL`, `ARCHIWARE_REST_USER`, `ARCHIWARE_REST_PASSWORD_FILE`, `ARCHIWARE_BACKUP_DIR`. The REST password is never read from the environment or argv.

## CLI

```
archiware setup [--mode docker|ssh|local] [flags]   configure + register with Claude Code (see setup --help)
archiware doctor                 configuration + connectivity report, fix hint per line, exit 1 on fail
archiware update [--check]       update to the latest GitHub Release
archiware version

archiware status                 devices, jukeboxes, pools with usage, running/scheduled jobs
archiware slots                  per-slot barcode (mtx) + P5 volume info + drive state
archiware volumes                all volumes with label, barcode, pool, sizes, expiry
archiware pools                  pools with mediatype, usage, volumes
archiware plans                  backup plans with enabled, events, tasks
archiware plan <id>              one plan: settings, events, tasks
archiware jobs [--all]           jobs with label, status, last report lines
archiware job <id>               one job: status, full report, protocol
archiware dryrun_plan <id>       dry-run job (safe, no confirmation needed)
archiware start_plan <id> --yes  start a backup now
archiware enable_plan <id> --yes / disable_plan <id> --yes
archiware stop_job <id> --yes    stop a scheduled job
archiware job_cancel <id> --yes  cancel a running or waiting job (REST)
archiware job-history [--plan <name|id>] [--status s] [--since YYYY-MM-DD] [--limit N]   past jobs (newest first): task, status, start, size, files, source line
archiware find-tasks <substring>                        plans/tasks whose directories contain the substring, with enabled flags
archiware task enable|disable <task> --yes              enable/disable one backup task (read back, before/after)
archiware task set-dirs <task> <dir...> --yes           replace a task's directories (read back; old value restored if P5 stored something else)
archiware run-once <plan> <task...> [--pool P] [--level full|incr] --yes   back up chosen tasks once via a temporary plan
archiware run-once-cleanup <temp plan> --yes            delete a temporary run-once plan after its job finished
archiware create_plan / delete_plan / set_plan_retention / plan_event / add_plan_folder(s)   plan editing (--yes)
archiware volume_enable <volume> on|off --yes
archiware restore_lookup <volume|job> [--job]            what a backup volume holds
archiware restore <volume> <path> <target-dir> --yes     restore to an ALTERNATE dir, never in place
archiware label_tapes <jukebox> <pool> <slot...> --yes   DESTRUCTIVE: label EMPTY tapes
archiware inventory <jukebox> [--barcode] --yes          schedule inventory job
archiware set_cleaning <device> <0|1> --yes
archiware tape_load <slot> --yes                         load tape into the drive matching its generation
archiware tape_unload <slot> --yes                       rewind + unload back to the slot
archiware tape_read_header <slot>                        read first block, always unloads after
archiware tape_erase <slot...> --yes                     DESTRUCTIVE: destroy tape contents
archiware clean_drive <p5 device|gen> --yes              clean a drive with the CLN* tape
archiware health                 P5 health checks (part of doctor), exit 1 on any fail
archiware rest_resources / rest <path> [--method M --body J]   REST passthrough (GET free; others need --yes)
archiware nsdchat <args...>      raw nsdchat passthrough
archiware container_status | container_backup | container_stop | container_start | container_update <file.deb>   docker mode only
```

`--json` prints JSON instead of a table; `--force` overrides the "library busy" check on `tape_*` / `clean_drive`.

## MCP tools

Same names as the CLI subcommands (`status`, `slots`, `volumes`, `pools`, `plans`, `plan`, `jobs`, `job`, `dryrun_plan`, `start_plan`, `enable_plan`, `disable_plan`, `stop_job`, `job_cancel`, `job_history`, `find_tasks`, `task_enable`, `task_disable`, `task_set_directories`, `run_tasks_once`, `run_tasks_once_cleanup`, plan editing tools, `volume_enable`, `restore_lookup`, `restore`, `label_tapes`, `inventory`, `set_cleaning`, `tape_*`, `clean_drive`, `health`, `rest_resources`, `rest`, `nsdchat`, `container_*`). `archiware setup` registers the server with `claude mcp add` (user scope); by hand: `claude mcp add archiware -s user -- archiware-mcp`.

## Notes on the newer tools

- `job-history`: P5's job listing returns only scheduled jobs, so history is enumerated by walking job ids downward from the newest known id (100 ids per nsdchat call, using one Tcl foreach) until 60 consecutive ids are unknown. Scheduled jobs are skipped unless `--status scheduled`. The start time is the "Client time" line of the job protocol (server-local time); index jobs have none.
- `run-once`: P5 has no call that submits a subset of a plan's tasks, so the tasks are copied into a temporary plan `mcp-once-<timestamp>` with one event into the pool and that plan is started. The temporary plan is kept while the job runs; delete it with `run-once-cleanup <plan>` once the job finished (only `mcp-once-*` plans, refused while a job of it is active).
- `task set-dirs`: P5's `dirlist` setter stores several arguments as ONE list element on tested versions; the tool reads the value back, restores the old one and reports an error if it differs from the request. One directory per task always works.
- All nsdchat calls take an exclusive `flock` on the P5 host (`/tmp/archiware-mcp-nsdchat.lock`, 120 s wait), because two simultaneous nsdchat calls collide ("can't create communication pipes", exit 10). Separate CLI/MCP processes therefore serialise; exit 10 is retried with backoff. Hosts without `flock` run unlocked.

## Safety model

- Mutating MCP tools require an explicit `confirm: true`; the CLI requires `--yes`. Without confirmation they only report the exact commands that WOULD run and change nothing.
- `label_tapes` and `tape_erase` are destructive. `restore` never restores in place. `dryrun_plan` is safe.
- The `nsdchat` passthrough runs read-only methods directly; anything else needs confirmation. `rest` GETs run directly; POST/PUT/DELETE need confirmation.
- `container_*` refuse while a P5 job runs (unless forced); `container_update` also refuses without a backup younger than 24 h.
- Credentials: the REST password lives in a mode-600 file, is read at call time and handed to curl on stdin, never in argv, environment or logs.
- Sizes reported by P5 are in KB and converted to human units.

## Host-side tape operations

`tape_load`, `tape_unload`, `tape_read_header`, `tape_erase` and `clean_drive` bypass P5 and drive the library directly with `mtx`/`mt` on the P5 host (locally in local mode): P5's CLI cannot erase or clean. The drive is chosen by the tape's generation (barcode suffix), and every operation unloads the tape in a finally block so a failure never leaves a tape in a drive. Before touching the library they refuse if P5 has a running job or a drive is loaded, unless `--force`. They need `sudo -n mtx`, `mt` and `dd` without a password on the P5 host.

## REST notes

P5 8 serves a REST API on port 8443 (self-signed certificate, not verified: the hop is a LAN/loopback one). Findings are in [REST.md](REST.md). `status`, `jobs` and `job` prefer REST with nsdchat fallback; `pools` and `volumes` stay on nsdchat because REST lacks the pool/volume relation. Not possible via the P5 CLI: pool creation with usage Backup, pool drive pinning, removing events.

## Development

`npm install && npm run build` (`npm run typecheck` for types only). `package.json` is `private`: releases are GitHub Release tarballs (`npm pack` gives the `.tgz` to attach as `archiware-mcp.tgz`), never an npm registry publish.

## License

MIT, see [LICENSE](LICENSE).
