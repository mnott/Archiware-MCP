# Guide: daily checks

## Why

Backups fail quietly: a mail setup breaks, a plan stops running, two jobs fight for one drive. A few read-only commands tell you every morning whether last night did what it should, and one of them (`ensure_done`) can run from cron and mail you only the result.

## What you do

1. `health` for a one-call state (container, REST, jobs, drives, cleaning, log, mail). Exit code 1 on a failed check. `doctor` adds the config and connectivity checks, each with a fix hint.
2. `ensure_done` after the nightly window: did every scheduled run produce a successful job for every task? Exit code 3 when something is missing.
3. `schedule_check --days 7` before you change schedules: overlaps per drive generation or pool, runs reaching into the P5 maintenance restart window, pools without an appendable tape.
4. `governance_report` now and then: plans that never ran, folders in several plans, tasks on missing folders. Apply one recommendation with `governance_apply <item>`.
5. `notify_status` when mail seems silent; `notify_test` checks the SMTP path.
6. Put `ensure_done --mail` into cron.

## Example

```
$ archiware health
OK    container      running since 2026-11-08T15:38:45Z
OK    rest           REST answers at https://p5.example.lan:8443
OK    version        P5 8.0.6, uptime 19h52m
OK    jobs           0 running, 0 waiting, 51 scheduled
OK    drives         3 devices, 1 jukebox, library 2 drives/24 slots, loaded: 0
OK    cleaning       no drive flagged for cleaning
WARN  log            1 Error line(s) in last 500, latest: ...
OK    mail           smtp.example.lan:587, last mail sent 2026-11-09 06:43

Overall: WARN
```

```
$ archiware schedule_check --days 2
START             END               PLAN   EVENT                POOL   DRIVEGENERATION  EXPECTEDMINUTES  DURATIONFROMHISTORY
2026-11-10 03:00  2026-11-10 03:16  Daily  incremental to Daily Daily  L6               16               true
2026-11-11 03:00  2026-11-11 03:16  Daily  incremental to Daily Daily  L6               16               true

2 run(s), 0 warning(s). ...
```

MCP: `health {}`, `schedule_check {"days":2}`, `ensure_done {"since":"2026-11-08"}`, `governance_report {}`.

Governance and re-run (mutating, confirm-gated):

```
archiware governance_report
archiware governance_apply disable-plan:10017 --yes
archiware ensure_done --since 2026-11-08 --rerun --yes
```

```
governance_apply {"item":"disable-plan:10017","confirm":true}
ensure_done {"since":"2026-11-08","rerun":true,"confirm":true}
```

Mail:

```
archiware notify_status
archiware notify_test
archiware notify_test --yes
```

MCP: `notify_status {}`, `notify_test {"confirm":true}`. `notify_set` only prints why P5 mail settings cannot be changed through any API and the GUI steps.

Cron (07:30 daily; `archiware` must be on the cron PATH; `operatorMail` set in the config):

```
30 7 * * *  archiware ensure_done --since "$(date -d yesterday +\%F)" --mail >/dev/null 2>&1
```

## Watch out

- `health`, `doctor`, `schedule_check`, `governance_report`, `notify_status` and `ensure_done` (without `--rerun`) are read-only.
- `--rerun --yes` re-runs exactly the failed, stopped or missing tasks once through a temporary plan `mcp-once-*`; it never cancels anything. `governance_apply` refuses a plan with active jobs.
- `notify_test --yes` sends one real test mail to `operatorMail` through the host MTA, which proves the host path, not P5's.

## See also

[Operations: governance, schedule check, ensure done, mail](../operations.md) | [Configuration](../configuration.md) | [CLI reference](../cli.md) | [Plans and tasks guide](plans-and-tasks.md)
