# Changelog

## Unreleased

**Important: single-path restores in 0.2.0 were wrong and are fixed.** In 0.2.0, `restore --at` / `restore --job` restored one path by selecting the whole backup volume (`RestoreSelection addfromvolume`), so a request for one file restored everything on the tape. This no longer happens. P5's CLI and REST cannot select one path of a backup version, so `restore --at` (and `restore_version` for a version on a tape in the library) now prints a full plan and the exact P5 GUI steps and starts no P5 job. Whole volumes are restored only by the explicit `restore_volume`. See `docs/restore.md`.

### Safety
- `tape_erase` now checks P5's volume list before loading: a tape whose barcode P5 still knows as a volume (or whose barcode is unknown) is refused with slot, barcode, volume id and pool, unless the new `--erase-known` (MCP `eraseKnown`) is given. The preview lists the targets that would be refused.

### Restore
- `restore --at "<start>" <path>`: no longer uses `addfromvolume`. Prints the plan (version, volumes, barcode, location, destination, bytes, free space, tree, conflicts, policy, planId) and the P5 GUI steps; `--yes --plan <id>` only creates the destination folder. The CLI prints every plan field. `--to` replaces the mandatory target. Lookups of one version fetch only that version's volumes (about 5 s instead of 45 s).
- New `restore_archive <path> [--index I]` (RestoreSelection `addentry` with the archive handle) and the explicit `restore_volume <volume>`; both preview, then run with `--yes --plan <id>` and return the P5 job id.
- Restore safety on every restore path (`restore`, `restore_archive`, `restore_volume`, `restore_version`, `catalog_restore`): default destination is a restore folder `<restoreRoot>/<YYYYMMDD-HHMMSS>/<original path>` (config `restoreRoot`, default `<packRoot>/restore`); the original location needs `--to original`, and P5 restores refuse it. The plan shows host, destination, source, bytes, free space, a tree preview and every existing destination file with size and mtime now vs restored. `--on-conflict refuse|rename|overwrite` (default refuse; rename writes `<name>.restored-YYYYMMDD`; not available for P5 restores). Config `syncRoots`: warning for destinations below a sync root, `--to original` there refused without `--force-sync`. The plan carries a `planId`; the execute call must pass `--plan <planId>` (MCP `planId`) and is refused with the new plan if destination or conflicts changed.
- The restore preview reads the catalogue copy of P5's backup index when it covers the chosen version, else P5's SQLite index; a folder shows its direct entries (first 50, totals from one aggregate query). No volume inventory is run for a preview.
- `catalog_restore` of a tar that is only on tape no longer restores the tar through a volume restore; it stops with the P5 GUI steps.

### File index and search (optional)
- `index_sync [--client C] [--full] [--detach] [--no-dtime]` copies P5's backup index into the catalogue database (tables `names`, `dirs`, `p5_dirs`, `p5_files`, `index_state`; set-based path rebuild, streamed batches, incremental, resumable, read-only on P5). `index_status` shows state, table sizes and detached runs with rows/s.
- `find_file <name|glob> [--client] [--since] [--under] [--limit]`: every version of every matching file with all places to fetch it from, cheapest first (disk tar, tape in library, tape offline). `restore_version <path> <versionKey>` restores one version from the cheapest place (or `--from <location id>`), confirm-gated.
- The web page uses the same search.

### Catalogue viewer (optional)
- `web/` is a self-contained compose project: the page (`catalog`), its own MariaDB 11.4 (`catalog-db`, users `catalog` read/write and `catalog_ro` SELECT plus the cache table) and a nightly dump service (`catalog-dump`, last 14 kept). New `viewer_deploy` (also offered by `archiware setup`; keeps existing secrets, creates the database users idempotently, `--subpath` prints a reverse-proxy example), `viewer_status`, `catalog_migrate` (`--source-tls verify|skip-verify|off`, `--force`); config keys `viewerHost`, `viewerDir`. `viewer_deploy` copies `web/` without the local owner and group.
- Web page: form login with a signed session cookie (`sessionSecret`), relative links for sub-path proxying, login form layout fixed.
- Slow P5 lookups (volume label, barcode, location, "which tape holds this tar") are cached in the catalogue table `p5_cache` by `catalog_search` and the web page; `cacheTtlMinutes` (default 60, 0 = off); an expired entry is served, marked stale, when P5 is unreachable. The SQL client in the catalogue container is detected (`mariadb` or `mysql`).

### Documentation
- README shortened; new `docs/` (configuration, CLI reference, operations, restore, D2D2T, index and search, web viewer); `web/README.md` points to `docs/web-viewer.md`.

### Earlier unreleased changes
- `pack --detach` runs a whole pack as one self-contained runner on the P5 host (survives a disconnect, resumable per tar); `pack_status` (progress, rate, ETA, log tail) and `pack_stop` (after the current tar). New `web/`: read-only catalogue web page (search, sets, browse, tape side, restore command, link to the P5 web UI).
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
