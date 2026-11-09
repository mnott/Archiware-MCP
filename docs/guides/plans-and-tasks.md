# Guide: plans, jobs and tasks

## Why

A P5 backup plan holds events (when, which pool, which level) and tasks (which folders). Day to day you want to see what exists, add a folder, check that the new folder works without writing to tape, run just one task now, and stop a job that hangs. You can do all of that without the P5 web UI.

## What you do

1. Look: `plans` (all plans with enabled flag, events, tasks), `plan <id>` (one plan in detail), `jobs` (running and scheduled), `job-history --plan <name|id> --limit 5` (past runs), `find-tasks <substring>` (which plan backs up a folder).
2. Add a folder: `add_plan_folder <plan> <path>` (preview), then with `--yes`. The new task is enabled.
3. Dry run: `dryrun_plan <id>` starts a P5 dry-run job. It is safe and needs no `--yes`.
4. Run chosen tasks once: `run-once <plan> <task...> [--pool P] [--level full|incr]` (preview), then `--yes`. P5 cannot submit a subset of a plan, so the tool copies the tasks into a temporary plan `mcp-once-<timestamp>` and starts it. When the job is finished, `run-once-cleanup <temp plan> --yes`.
5. Start a whole plan now: `start_plan <id> --yes`.
6. Switch on or off: `enable_plan <id>` / `disable_plan <id>` / `task enable <task>` / `task disable <task>`, each with `--yes`.
7. Stop: `stop_job <id> --yes` for a scheduled job, `job_cancel <id> --yes` for a running or waiting one.

## Example

```
$ archiware plans
ID     DESCRIBE  ENABLED  EVENTNAMES                    TASKNAMES
10024  Daily     true     Backup_10024_...:812877,...   10079,10080,10081,...
10027  Weekly    true     Backup_10027_...:919253,...   10096,10097
...
```

MCP: `plans {}`, `plan {"id":"10024"}`.

```
$ archiware job-history --limit 4
ID     PLAN                  TASK   STATUS     COMPLETION  START  SIZE  FILES  SOURCE
13012  Daily - 'client1'     10100  stopped    failure     -      0 B   0      -
...
4 job(s); 100 ids scanned in 3 ssh round trips
```

Add a folder, dry run, then run its task once:

```
archiware add_plan_folder 10024 /data/projects/new
archiware add_plan_folder 10024 /data/projects/new --yes
archiware dryrun_plan 10024
archiware run-once 10024 10099 --pool Daily --level full --yes
archiware run-once-cleanup mcp-once-1762680000 --yes
```

```
add_plan_folder {"plan":"10024","path":"/data/projects/new","confirm":true}
dryrun_plan {"id":"10024"}
run_tasks_once {"plan":"10024","tasks":["10099"],"pool":"Daily","level":"full","confirm":true}
run_tasks_once_cleanup {"plan":"mcp-once-1762680000","confirm":true}
stop_job {"id":"13001","confirm":true}
```

Paths are as the P5 container sees them (docker mode).

## Watch out

- Every mutating command only prints what it would do until `--yes` / `confirm: true`.
- `run-once` writes to tape. `run-once-cleanup` only deletes plans named `mcp-once-*` and refuses while a job of it is active.
- `delete_plan` and `task set-dirs` exist too; `task set-dirs` reads the value back and reports an error if P5 stored it differently. One directory per task always works.
- A dry run job shows up as a job; it is safe, but wait for it before starting the real one.

## See also

[CLI reference](../cli.md) | [Operations: notes on the newer tools](../operations.md) | [Daily checks guide](daily-checks.md)
