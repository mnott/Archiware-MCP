# CLI reference

The same operations are MCP tools (see [README](../README.md#mcp-tools)). This is the output of `archiware help`, copied from `src/cli.ts`.

```
Commands:
  setup [--mode ...]     configure, create the REST password file, register with Claude Code (setup --help)
  doctor                 configuration + connectivity report with fix hints (exit 1 on fail)
  update [--check]       update to the latest GitHub Release (or only report)
  version                print the version
  status                 devices, jukeboxes, pools with usage, running/scheduled jobs
  slots                  per-slot barcode (mtx) + P5 volume info, drive loaded state
  volumes                all volumes: label, barcode, type, location, mode, state, pool, sizes
  pools                  pools with mediatype, usage, volumes
  plans                  backup plans (and archive plans) with enabled, events, tasks
  plan <id>              one plan in detail: settings, events, tasks
  jobs [--all]           jobs with label, status, last report lines (--all = +7 days completed)
  job <id>               one job: status, report, protocol
  dryrun_plan <id>       start a dry-run job (safe, no --yes needed)
  start_plan <id>        start a backup now          (needs --yes)
  enable_plan <id>       enable a plan               (needs --yes)
  disable_plan <id>      disable a plan              (needs --yes)
  stop_job <id>          stop a scheduled job        (needs --yes)
  label_tapes <jukebox> <pool> <slot...> [--drive <device>]
                         DESTRUCTIVE: label EMPTY tapes; --drive forces that drive (needs --yes)
  restore_lookup <volume|job> [--job]               list what a backup volume (or job's volumes) holds
  restore --at "<start>" <path> [--to <dir>] [--client C]   plan for one path at the version chosen from restore_options: full preview + P5 GUI steps (P5 CLI cannot restore a single backup path); --yes --plan <id> prepares the folder
  restore_archive <path> [--index I] [--to <dir>]   restore one ARCHIVE entry (RestoreSelection addentry); preview, then --yes --plan <id>
  restore_volume <volume> [--to <dir>]              EXPLICIT whole-volume restore (everything on the volume); preview, then --yes --plan <id>
  add_plan_folder <plan> <path>                   add one folder as a new enabled task (needs --yes)
  add_plan_folders <plan> <path...> [--filter <f>]  add folders as enabled tasks (needs --yes)
  create_plan <name> [--retention <days>]         create a plan (needs --yes)
  set_plan_retention <plan> <days>                set plan retention (needs --yes)
  delete_plan <plan>                              delete a plan (needs --yes)
  volume_enable <volume> on|off                   enable/disable a volume (needs --yes)
  plan_event <plan> <pool> <level> <frequency...> <firstrun YYYY-MM-DDTHH:MM> [--exception "<spec>"]
                         add an event; level 1 full, 0 incr, -1 synthetic; time is the local time zone (needs --yes)
  set_cleaning <device> <0|1>                       set a drive's cleaning flag (needs --yes)
  inventory <jukebox> [--barcode]                   schedule inventory job (needs --yes)
  tape_load <slot>                                  load tape into matching drive, leave loaded (needs --yes)
  tape_unload <slot>                                rewind + unload back to slot    (needs --yes)
  tape_read_header <slot>                           read first block (256k then 1M), always unloads after
  tape_erase <slot...>                              DESTRUCTIVE: destroy tape contents (rewind + mt erase 0) (needs --yes)
  clean_drive <p5 device|gen>                       clean drive with CLN* tape, reset P5 cleaning flag (needs --yes)
  job_cancel <id>        cancel a running or waiting job via REST (needs --yes)
  job-history [--plan <name|id>] [--status <s>] [--since YYYY-MM-DD] [--limit N]
                         past jobs (newest first): plan, task, status, start, size, files, source line
  find-tasks <substring> plans and tasks whose directories contain the substring (+ enabled flags)
  task enable|disable <task>                      enable/disable a backup task, read back (needs --yes)
  task set-dirs <task> <dir...>                   replace a task's directories, read back (needs --yes)
  run-once <plan> <task...> [--pool P] [--level full|incr]
                         back up chosen tasks once via a temporary plan (needs --yes)
  run-once-cleanup <temp plan>                    delete a temporary run-once plan (needs --yes)
  governance_report      per plan: schedule in words, folders, last run per task, retention; flags with keep/merge/disable/delete; pools; server settings (restart window, mail)
  governance_apply <item>  apply ONE recommendation: disable-plan:<id> | delete-plan:<id> | disable-task:<id> (needs --yes, read back)
  schedule_check [--days N]  timeline of enabled events with expected duration, drive generation, pool; overlaps, restart window, pools without appendable tape
  ensure_done [--since T] [--rerun] [--mail]  every scheduled run since T: did every task produce a successful job? --rerun re-runs the failed/missing tasks once (needs --yes); --mail sends the result to operatorMail through the host MTA
  notify_status          P5 mail setup in words (SMTP server, port, TLS, sender, auth, recipients) + what its log says
  notify_set [--server S --port N --tls T --sender A --user U --password-file F --recipients a,b]   P5 offers no API for this: prints why and the GUI steps
  notify_test [--yes]    SMTP reachability from P5, log evidence; with --yes also a test mail via the host MTA to operatorMail
  library_layout         per slot: barcode, P5 label/pool, target pool (config slotLayout), ok/misplaced/foreign/empty; drives, mail slots
  library_arrange        minimal mtx move list to reach the slotLayout (dry plan; --yes runs it, refused while busy)
  tape_export <barcode|label>                     slot -> first free mail slot (dry plan; --yes)
  tape_import [mail slot]                         mail slot -> its pool's slot per slotLayout (dry plan; --yes)
  restore_options <path> [--since YYYY-MM-DD] [--client C]   every backed-up version of a file/folder from P5's backup index, newest first, with the volumes (copies) holding it, barcode, location, fetch list
  offsite_status [--path <p>]                     per pool: volumes in library / mail slot / out; pools with nothing out; fetch list for a path
  library_plan arrange | export <tape> | import [mail slot] [--simulate]    start a step-by-step session
  library_step <session> [--yes]                  execute exactly one next step (human steps are verified)
  library_status <session> / library_abort <session>
  library_reconcile [--yes]                       compare P5 volume locations with mtx, cleaningSlot, plan events (--yes fixes cleaningSlot in the config)
  catalog_init           create the file catalogue schema (MySQL archive_catalog) idempotently
  pack <source dir> --set NAME [--max 50G] [--into <pack root>] [--replan] [--detach]   cut a folder into tars and catalogue every file (plan without --yes; --yes writes, resumable; --detach runs it on the host)
  pack_status --set NAME   detached pack: tars done/total, bytes, current tar, rate, ETA, log tail
  pack_stop --set NAME     stop a detached pack after the current tar (needs --yes)
  catalog_sets           sets with tars, files, bytes, status
  index_sync [--client C] [--full] [--detach] [--no-dtime]   copy P5's backup index (names, dirs, versions) into the catalogue db; incremental unless --full
  index_status   index_sync state per client (last id/btime, rows), table sizes, detached runs with rows/s
  find_file <name|glob> [--client C] [--since YYYY-MM-DD] [--under /path] [--limit N]   every backed-up version of every matching file, each with all places to fetch it from, cheapest first
  restore_version <path> <versionKey> [--to original|<dir>] [--on-conflict refuse|rename|overwrite] [--force-sync] [--from <location id>] [--client C]   restore one version from its cheapest place; no --yes = preview with planId, then --yes --plan <id>
  catalog_search <pattern> [--set NAME] [--limit N]   find files (glob or substring) with tar, on-disk and tape location
  catalog_restore <path> --set NAME [--to original|<dir>] [--on-conflict ...]   extract one file from its tar (preview, then --yes --plan <id>)
  catalog_drop --set NAME                         delete a set's catalogue rows, not its tars (needs --yes)
  viewer_deploy --network N --catalog-ip IP --db-ip IP [--host H] [--dir D] [--data-dir D] [--p5-index D] [--pack-root D] [--subpath S] [--viewer-user U] [--p5-base-url URL] [--tz Z]
                         deploy the catalogue viewer (web page + its own MariaDB + nightly dump) on a docker host (plan without --yes)
  viewer_status          viewer containers, health, database size, last dump, cache entries
  catalog_migrate --from <host[:port]> --user U --password-file F [--source-tls verify|skip-verify|off] [--force]   copy archive_catalog from an existing MySQL into the viewer's database; F is read on THIS machine; skip-verify for a self-signed source cert (plan without --yes)
  health                 one-call P5 health check (exit code 1 on any fail; part of doctor)
  rest_resources         list the REST API resources
  rest <path> [--method GET|POST|PUT|DELETE] [--body <json>]
                         REST passthrough under /rest/v1 (non-GET needs --yes)
  container_status       state, image, version, newest backup of the P5 container
  container_backup [--restart] [--force]            cold backup, STOPS the container (needs --yes)
  container_stop [--force]                          docker stop -t 120 (needs --yes)
  container_start                                   docker start, wait for srvinfo (needs --yes)
  container_update <file.deb> [--skip-backup-check] [--force]   install a .deb in the container (needs --yes)
  nsdchat <args...>      raw nsdchat passthrough (non-read-only methods need --yes)

Options:
  --json   print JSON instead of a table
  --yes    confirm mutating commands
  --force  override the "library busy" check on tape_* / clean_drive
```

`--json` prints JSON instead of a table. Mutating commands print what they would do and change nothing until you add `--yes`. `--force` overrides the "library busy" check on `tape_*` / `clean_drive` and the running-job guard of `container_*`. `--config <file>` selects another config file (same as `ARCHIWARE_CONFIG`).

Exit codes: `doctor` and `health` exit 1 on a failed check; `ensure_done` exits 3 when a scheduled run is incomplete; any error exits 1; an unknown command exits 2.

Task walkthroughs with examples: [guides](guides/) (listed in the [README](../README.md#guides)).
