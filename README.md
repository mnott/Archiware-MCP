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
| `longTimeoutMs` | all | timeout of "long" nsdchat calls (volume inventories), default 600000 |
| `lockWaitS` | all | seconds a call waits for the host-side nsdchat lock, default 120 |
| `slotLayout` | all | pool name -> slot range or list, e.g. `{"Yearly": "9-12", "Daily": "14-22"}` or `{"Daily": [14, 15]}`; a slot belongs to one pool; the cleaning slot is never used |
| `mailSlots` | all | import/export (mail slot) element ids; added to those mtx flags as `IMPORT/EXPORT` |

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
archiware restore --at "<start>" <path> <target-dir> --yes  restore the version chosen from restore_options
archiware governance_report | governance_apply <item> | schedule_check [--days N] | ensure_done [--since T] [--rerun] [--mail] | notify_status | notify_set | notify_test
archiware library_layout | library_arrange | tape_export <tape> | tape_import [mail slot] | restore_options <path> | offsite_status [--path p]
archiware library_plan arrange|export <tape>|import [slot] [--simulate] | library_step <session> | library_status <session> | library_abort <session> | library_reconcile
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

Same names as the CLI subcommands (`status`, `slots`, `volumes`, `pools`, `plans`, `plan`, `jobs`, `job`, `dryrun_plan`, `start_plan`, `enable_plan`, `disable_plan`, `stop_job`, `job_cancel`, `job_history`, `find_tasks`, `task_enable`, `task_disable`, `task_set_directories`, `run_tasks_once`, `run_tasks_once_cleanup`, plan editing tools, `volume_enable`, `restore_lookup`, `restore`, `library_layout`, `library_arrange`, `tape_export`, `tape_import`, `restore_options`, `governance_report`, `governance_apply`, `schedule_check`, `ensure_done`, `notify_status`, `notify_set`, `notify_test`, `offsite_status`, `library_plan`, `library_step`, `library_status`, `library_abort`, `library_reconcile`, `label_tapes`, `inventory`, `set_cleaning`, `tape_*`, `clean_drive`, `health`, `rest_resources`, `rest`, `nsdchat`, `container_*`). `archiware setup` registers the server with `claude mcp add` (user scope); by hand: `claude mcp add archiware -s user -- archiware-mcp`.

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

## Library and restores

archiware-mcp is meant as the primary interface to the tape library and to restores; data and indexes stay in P5.

**Slot layout.** Set `slotLayout` (pool -> slots) in the config, e.g. `"slotLayout": {"Yearly": "9-12", "Daily": "14-22"}`, and optionally `mailSlots`. `library_layout` lists every slot with barcode, P5 label/pool, the target pool and a status: `ok`, `misplaced` (tape of another pool), `foreign` (barcode unknown to P5), `empty`; drives and mail slots too. `library_arrange` computes the minimal list of `mtx transfer` moves (ordered so each lands on an empty slot; cycles are broken through a free slot, last resort an empty mail slot). It refuses while a drive is loaded or a P5 job runs, and is confirm-gated.

**Mail slot.** `tape_export <barcode|label>` moves a tape to the first free mail slot; `tape_import [mail slot]` moves the tape in a mail slot to a free slot of its pool per `slotLayout` (else the first free slot). Both are confirm-gated, refuse like the other tape tools and finish with a P5 inventory.

**Restore finder.** `restore_options <path>` lists every backed-up version of a file or folder, newest first, from P5's own per-client backup index (`<P5 config>/index/backup/bsx_<client>`, SQLite, opened read-only on the P5 host with `sqlite3`, so the host needs `sqlite3`): backup time, file modification time, size, plan, level, and **every volume holding a copy** (label, pool, barcode, and where the tape is now: drive / library slot n / mail slot / not in the library = offsite), plus a fetch list of tapes to bring back when no copy is in the library. A folder's versions are the runs that saved the folder entry; its files have versions of their own. It never dumps a volume inventory. Why the index is read directly: P5 8.0 `RestoreSelection findentry` only takes archive indexes or archive plans (`no such index or plan` for a backup index or backup plan), `addentry` needs an archive entry handle (`ArchiveEntry handle` knows only archive databases), and REST `POST restore/restoreselections` answers `Missing Client ID` for every body shape tried, so no single backup entry can be put into a selection through the supported interfaces. `restore --at "<start>" <path> <target-dir>` picks a copy of that version that is in the library (refusing, naming the tape to fetch, if none is) and submits through `RestoreSelection addfromvolume`, which restores a whole backup volume, so the confirmed run still refuses when the volume holds data outside `path`; its content check is a long call (see below).

**Governance.** `governance_report` explains the whole setup in plain words: per plan enabled/disabled, events (pool, level, frequency as words such as "every month on the first Sunday at 03:00", next run), tasks and folders, last run per task with result (from `job_history`), retention; then flags with a reason and a recommendation (keep / merge / disable / delete): plans that never ran or only failed in the last `governanceMonths` months, plans disabled longer than `disabledDays`, folders backed up by several plans, tasks on folders that do not exist in the P5 container (`test -e` there), pools without (appendable) volumes, events whose pool has no tape in the library. It also prints server-wide settings: the maintenance restart window (see below), plan stop/cancel times and the mail setup. `governance_apply <item>` applies exactly one recommendation (`disable-plan:<id>`, `delete-plan:<id>`, `disable-task:<id>`; the `apply` field of a flag), confirm-gated, refuses a plan with active jobs, reads the result back.

**Maintenance restart.** P5 restarts its server in a daily window (on this server Mon-Sun 04:00-07:00, printed in the log at each start as `Attempt restart on <day>, 04:00 - 07:00`). From the window start it attempts a graceful restart every 10 minutes and restarts only when no session or job is active (`Can't restart: have active sessions`, `Next restart attempt in 10 minutes`); at the window end it gives up for the day (`Unable to perform graceful restart`) and does not interrupt running jobs. The setting itself is not exposed by nsdchat or REST and is not in a readable file (it is stored inside P5); change it in the P5 GUI.

**Schedule check.** `schedule_check [--days N]` lists every run of every enabled event in the next N days with expected duration (median of the event's past runs, read from the backup index snapshot table; 60 minutes assumed without history), pool and the drive generation the pool needs (from its tapes' barcodes), and warns about overlaps per drive generation (more runs than drives of that generation in `drives`) and per pool, runs reaching into the restart window, and pools without an appendable tape in the library.

**Ensure done.** `ensure_done [--since T] [--rerun] [--mail]` checks that every scheduled run since T produced a successful job for every enabled task of its plan and lists failed, stopped, missing and still-waiting tasks (exit code 3 when something is wrong). `--rerun --yes` re-runs exactly those tasks once through `run_tasks_once` into the same pool and reports the temporary plan and job ids; it never cancels anything. `--mail` sends the result to `operatorMail` through the host's own MTA (`mail`), independent of P5's mail. Run it after the nightly window, read-only, from cron or launchd:

```
# cron: 07:30 every day; archiware must be on PATH of the cron job
30 7 * * *  archiware ensure_done --since "$(date -d yesterday +\%F)" --mail >/dev/null 2>&1
```

```
<!-- launchd ~/Library/LaunchAgents/org.example.archiware-ensure-done.plist (macOS: date -v-1d; use a wrapper script) -->
<plist version="1.0"><dict>
  <key>Label</key><string>org.example.archiware-ensure-done</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/archiware</string><string>ensure_done</string><string>--mail</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
</dict></plist>
```

**Mail and silence detection.** P5 reports by mail, and a broken P5 mail setup goes unnoticed because the backup itself still succeeds. `notify_status` reads P5's mail setup (SMTP server, port, TLS, sender, login yes/no, recipients) and what its log says (last `MAIL SENT`, recent `MAIL NOT SENT`). P5 keeps the settings in its resource database (`customerconfig/resources.db`: `Client` row `localhost` mail columns, `UserPref` notification columns); neither nsdchat nor REST exposes them, so they are read read-only on the host. P5 mails every finished job's report to the users with notifications on (filtered by the user's severity/subsystem settings); there are no per-plan or per-event recipients. `notify_set` therefore cannot change anything (no API; editing the live database behind the server is unsafe) and returns the current values plus the GUI steps; a password is only ever accepted as a file path. `notify_test` has no P5 test-mail command to call: it checks that P5's SMTP server accepts a connection from the P5 container, shows the log evidence and, with `--yes`, sends one test mail through the host MTA to `operatorMail`. `doctor` and `health` get a `mail` check that warns when P5 mail is not configured, when mail failed and none was sent in `mailSilenceDays` days (default 3), or when jobs finished and no mail went out. Config keys: `operatorMail`, `mailSilenceDays`, `governanceMonths`, `disabledDays`, `p5ConfigDir` (host path of P5's config folder; default derived from `logPath` or `<p5Home>/config`).

**Restart guard.** `container_stop`, `container_backup` (it stops the container) and `container_update` refuse while any P5 job is running or waiting (scheduled future runs do not count) unless `--force`; `container_start` only starts a stopped container and needs no guard. P5's own maintenance restart is separate and waits for idle by itself.

**Offsite view.** `offsite_status` shows per tape pool the volumes in the library, in a mail slot or out, and warns for pools with no volume out of the house; `--path` adds the fetch list for a restore_options result.

**After moves (P5 consistency).** P5 addresses media by label/barcode; its volume locations (slots) are refreshed by a jukebox inventory. After real moves the last step of a session runs that inventory and `library_reconcile`: it compares every volume's P5 location with mtx, moves `cleaningSlot` in the config if the `CLN*` tape moved (`--yes` / `confirm`), and warns about every enabled plan whose event pool has no appendable volume in the library, with the plan's next scheduled run. `slotLayout` is yours and is never rewritten. The CLI and REST expose no jukebox setting for cleaning, reserved or mail slots (REST jukebox detail has `slotcount` only); if the P5 GUI has such settings, `library_reconcile` reports them as a manual step.

**Conversational execution.** Rearranging and import/export run as a dialog, state in `library_session.json` next to the config. `library_plan arrange|export <tape>|import [slot]` proposes the steps and returns a session id; `library_step <session>` executes exactly one step (confirm-gated) and returns what happened plus the next instruction, including human steps ("put the tape into mail slot 24, then call library_step again", "take tape X out of the mail slot"), which are verified rather than executed; `library_status` shows done/next/remaining; `library_abort` stops cleanly and checks that no tape is in a drive (transfers only move slot to slot). Each step re-checks drives, running jobs and the expected slot contents, and stops with a clear message when reality differs from the plan. `--simulate` walks a session on a virtual copy of the library without touching hardware.

**One long call blocks the others, by design.** P5's CLI cannot run in parallel, so every nsdchat call takes an exclusive host lock (`lockWaitS`). Normal calls are short (`timeoutMs`); the few calls that legitimately take minutes (a volume inventory) use the separate "long" mode with `longTimeoutMs`. While one runs, every other nsdchat call (other sessions, the MCP) waits and may time out. Avoid whole-volume inventories on large volumes.

## REST notes

P5 8 serves a REST API on port 8443 (self-signed certificate, not verified: the hop is a LAN/loopback one). Findings are in [REST.md](REST.md). `status`, `jobs` and `job` prefer REST with nsdchat fallback; `pools` and `volumes` stay on nsdchat because REST lacks the pool/volume relation. Not possible via the P5 CLI: pool creation with usage Backup, pool drive pinning, removing events.

## Development

`npm install && npm run build` (`npm run typecheck` for types only). `package.json` is `private`: releases are GitHub Release tarballs (`npm pack` gives the `.tgz` to attach as `archiware-mcp.tgz`), never an npm registry publish.

## License

MIT, see [LICENSE](LICENSE).
