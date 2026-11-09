# Changelog

## Unreleased

- New file catalogue for D2D2T packs (MySQL `archive_catalog` on the P5 host): `catalog_init`, `pack` (plan, then resumable tar writing with sha256, listing and per-tar transactional rows), `catalog_sets`, `catalog_search` (with tape location per tar), `catalog_restore` (from disk or via tape), `catalog_drop`; config keys `catalogMysqlContainer`, `catalogDbCnf`, `packRoot`, `packRootP5`, `packMBps`.

- Fixed `restore_options` / `restore`: versions now come from P5's per-client backup index (read-only, via sqlite3 on the host) instead of job roots, so a path's real versions with every volume copy are listed; `restore --at "<start>"` replaces `--job`. P5's nsdchat/REST cannot put a single backup entry into a restore selection (documented in the README).
- New `governance_report`, `governance_apply`, `schedule_check`, `ensure_done` (with `--rerun`, `--mail`), `notify_status`, `notify_set`, `notify_test`; `doctor`/`health` get a `mail` silence check; new config keys `operatorMail`, `mailSilenceDays`, `governanceMonths`, `disabledDays`, `p5ConfigDir`.
- Restart guard now also counts waiting jobs.

- New config keys `slotLayout` (pool -> slot range/list), `mailSlots`, `longTimeoutMs`, `lockWaitS`.
- New `library_layout`, `library_arrange`: slot layout per pool with ok/misplaced/foreign/empty status, and the minimal confirm-gated `mtx transfer` plan (refused while a drive is loaded or a job runs).
- New `tape_export` / `tape_import`: move a tape to and from the mail slot, confirm-gated, with a P5 inventory after.
- New `restore_options <path>`: every backed-up version of a path with job, plan, pool, volume, barcode and current tape location, plus a fetch list. `restore --job <job>` restores a chosen version into a separate directory and refuses when the tape is not in the library.
- New `offsite_status`: per pool volumes in library / mail slot / out, warning when nothing is out of the house.
- New `library_reconcile`: P5 locations vs mtx, `cleaningSlot` fix, enabled plan events whose pool has no appendable volume in the library.
- New persisted conversational sessions: `library_plan`, `library_step`, `library_status`, `library_abort` (human steps, per-step re-checks, `--simulate`).
- Transport: a separate "long" nsdchat mode (`longTimeoutMs`) for volume inventories, configurable lock wait (`lockWaitS`); README documents that one long call blocks the others by design.

- New `job_history` / `job-history`: past jobs with plan, task, status, completion, start, size, files and the protocol's source line; filters plan, status, since, limit. Walks job ids downward in batched calls (P5 lists only scheduled jobs).
- New `find_tasks` / `find-tasks <substring>`: plans and tasks whose directories contain the substring, with plan and task enabled flags.
- New `task_enable`, `task_disable`, `task_set_directories` / `task enable|disable|set-dirs`: confirm-gated, read back before/after.
- New `run_tasks_once` / `run-once` and `run_tasks_once_cleanup`: one-off backup of chosen tasks through a temporary plan.
- Every nsdchat call now runs under an exclusive `flock` on the P5 host and retries on P5's pipe-collision error, so concurrent sessions no longer break each other.
- `job_cancel`: see REST.md for what was found live.

## 0.2.0

- Three deployment modes, set with the config key `mode`: `docker` (P5 in a container on an ssh host, the previous behaviour), `ssh` (P5 installed natively on an ssh host) and `local` (P5 on the machine running the tool). All tools work in each mode; `container_*` tools report "not applicable" outside docker mode.
- New `archiware setup`: checks prerequisites, detects the tape changer, writes the config, creates the REST password file (mode 600, hidden prompt, never argv), registers the MCP server with Claude Code. Idempotent; usable non-interactively through flags.
- New `archiware doctor`: configuration and connectivity report with a fix hint per line, non-zero exit on fail. `health` keeps working.
- New `archiware update [--check]` and `archiware version`. Distribution is the GitHub Release tarball only (no npm registry); `package.json` is `private`.
- Claude Code setup skill (`skills/setup`) and plugin manifest.
- No site-specific defaults any more: host, container, container IP, compose dir and backup dir are required keys that setup fills in.
- Tests are no longer shipped in the repository.
- README rewritten; LICENSE added; not affiliated with Archiware GmbH.

## 0.1.0

- Initial version: MCP server and CLI for Archiware P5 over ssh + docker exec: REST-first status, jobs, plans, volumes, restore, tape operations, container backup/update.
