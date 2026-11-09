# Backup index copy and file search (optional)

This is an optional feature. Without it you can still list the versions of a path you already know (`restore_options <path>`) and search the tar catalogue (`catalog_search`). With it you can type a file name and get every backed-up version of every matching file, across all sources, with every place each version can be fetched from.

It needs the file catalogue database (see [d2d2t.md](d2d2t.md) and, for the easy way to get one, [web-viewer.md](web-viewer.md)).

## Why a copy of P5's index

P5 keeps a SQLite index per client under `<P5 config>/index/backup/bsx_<client>/` (`files.db` holds the files and their versions). It has no index on file names, so a name search there is a full scan: about 4.5 minutes for a 9.5 GB `files.db`, I/O bound. `index_sync` copies the index into the catalogue database, where a name search takes well under a second.

P5 itself is never touched. `index_sync` opens the SQLite files read-only (`sqlite3 -readonly`, `immutable=1`) on the P5 host and writes only to the catalogue database. The host needs `sqlite3`.

## What `index_sync` copies

Tables in the catalogue database, created by `catalog_init` and by `index_sync`:

| Table | Holds |
|---|---|
| `names` | One row per distinct file name (a hash column is the uniqueness key; a prefix index serves anchored globs such as `report*`) |
| `dirs` | One row per distinct parent directory. A full path is never stored per file row |
| `p5_dirs` | P5 directory entity id to `dirs` row, per client. How file rows find their directory |
| `p5_files` | One row per version row of P5's index: client, element id, backup time (`btime`), deletion time (`dtime`), modification time, size, type, name and directory ids |
| `index_state` | Per source and client: `last_id` (highest P5 element id read, the resume point), `last_btime` (newest backup time read), `rows`, `updated_at` |

## Run it

```
archiware index_sync
```

With no `--client` every client found under `<P5 config>/index/backup` is synced, one after the other.

| Option | Meaning |
|---|---|
| `--client C` | Only this P5 client (for example `localhost`) |
| `--full` | Reset the state of the client and read everything again. Idempotent |
| `--detach` | Start the run on the P5 host and return at once; see below |
| `--no-dtime` | Incremental runs skip the second part (versions that ended) |

MCP tool: `index_sync` (`client`, `full`, `detach`, `noDtime`).

### Full and incremental

- The first run for a client is a full run. Later runs are incremental.
- Incremental reads the rows with an element id above `last_id` (new versions) plus the versions whose `dtime` moved since `last_btime` (versions that ended). That is one sequential pass, because P5's tables have no index for either. `--no-dtime` skips the second part and is faster; versions that ended since the last run then keep their old end time.
- `--full` starts from zero. It is safe to rerun.
- A run that is killed resumes from its last checkpoint (every 200 000 rows).

### How it works

Phase 1 builds every directory path with one recursive query over the parent index of `files.db`. Phase 2 streams the version rows in one scan and merges them in batches of 200 000 rows into `names`, `p5_dirs` and `p5_files` inside the database. No id map is held in a client, so memory stays bounded. The pipeline runs at low priority (`nice`, `ionice` where available). The credentials file is streamed into the container ahead of the SQL and exists there only while the client runs.

### Foreground and detached

A foreground run prints progress lines and reports rows and rows per second. It has a 12 hour limit. For a big index start it on the host:

```
archiware index_sync --detach
archiware index_status
```

`--detach` starts a self-contained runner with `setsid nohup` on the P5 host (logs in `/tmp/archiware-sync/<client>.log`), so you can disconnect. Rerun `index_sync` to resume.

### Nightly

Run it incrementally every night from cron on a machine that has archiware-mcp configured:

```
15 2 * * * archiware index_sync >> /var/log/archiware-index.log 2>&1
```

### Check the state

```
archiware index_status
```

Shows per client the last id and backup time and the row count, approximate row counts of the four index tables (InnoDB estimates), and for each detached run its state (running, finished, failed), phase, rows, rows per second and the last log lines. MCP tool: `index_status`.

### Sizing

> **TODO (operator):** measured on a ~84M-entry index: TODO numbers.
>
> Fill in, from one real full run and one incremental run: number of version rows, run time of the full run, rows per second, size of `p5_files`, `names`, `dirs` in the catalogue database, run time of a nightly incremental run, and the extra disk space needed on the database volume.

## Find a file

```
archiware find_file offer.docx
archiware find_file "report-2026-*" --under /data/projects --since 2026-01-01 --limit 50
archiware find_file /data/projects/offer.docx --client localhost
```

MCP tool: `find_file` (`pattern`, `client`, `since`, `under`, `limit`).

### Query forms

| Pattern | Matches |
|---|---|
| `offer` | Substring of the file name |
| `offer*.docx`, `?.txt` | Glob: `*` any characters, `?` one character; anchored at both ends |
| `/data/projects/offer.docx`, `projects/offer*` | The text after the last `/` is matched against the file name as above, and the whole pattern against the full path: a substring of it without `*` or `?`, anchored with them |

| Option | Meaning |
|---|---|
| `--client C` | Only this P5 client |
| `--since YYYY-MM-DD` | Only versions modified on or after this date |
| `--under /path` | Only files below this directory |
| `--limit N` | Number of files to list; default 20, at most 200 |

If more than 5000 distinct file names match, or the limit cuts the list, the result says so in `notes`; narrow the pattern.

### What you get

For each matching file (full path), its versions, newest first. A version is a distinct modification time and size, shown as the version key `<mtime>-<size>`. The same path, modification time and size from several sources is one version with several locations. Each location has a stable id you can pass to `restore_version --from`.

### Ranking: cheapest place first

| Rank | Location kind | Meaning |
|---|---|---|
| 1 | `disk-tar` | The file is inside a catalogued tar that is still on disk under `packRoot`. No tape needed |
| 2 | `tape-library` | A P5 backup version on a volume that is in the library (slot, drive or mail slot) |
| 2 | `tar-on-tape` | A catalogued tar that is no longer on disk and whose tape is in the library |
| 3 | `tape-offline` | Only on volumes outside the library. Shows the barcode ("insert X") |
| 3 | `tar-on-tape` (offline) | A catalogued tar that is only on tapes outside the library |

Locations of one version are sorted by rank; the first is the one `restore_version` uses unless you name another with `--from`. A version with no known place shows no location.

For the tar side the tape lookup is done for the first 30 tars that are not on disk; the result says so when more exist. Further sources (Seafile history, Seafile object store) are reserved in the code but not implemented.

Modification times of tar entries are compared as the database sees them (`UNIX_TIMESTAMP` of the stored DATETIME). If the database time zone differs from the host's, a tar entry and a P5 row of the same file stay two versions.

### Restore the version you found

`restore_version <path> <versionKey>` takes the path and the version key from `find_file`. See [restore.md](restore.md): disk tars and tars on tape restore from the tool; P5 backup versions print the exact steps for the P5 GUI.

## How the web search uses it

The web viewer runs the same search against the same tables: it matches names in `names`, reads the version rows from `p5_files`, adds the tar catalogue, and groups the result by path. Versions are rows with location badges ("on disk", "tape in library", "tape offline: <barcode>") and the CLI command to copy, including the default destination and the `--plan` second step. A result lists at most 50 files. There is no restore button. See [web-viewer.md](web-viewer.md).

## When the index is not populated

| Situation | Behaviour |
|---|---|
| `index_sync` never ran | `find_file` and the web search return only what is in the tar catalogue. The web page shows a note that the P5 index copy is not searchable and says to run `index_sync` |
| No catalogue database configured | `find_file` fails with the database error. Set up the catalogue first |
| Copy exists but is old | Versions made since the last run are missing. Run `index_sync` (or schedule it nightly) |
| Restore preview | Uses the catalogue copy when it covers the chosen version (the copy's newest backup time is not older than the version); otherwise it reads P5's own SQLite index on the P5 host, which is slower |
| You know the path | `restore_options <path>` lists every version of a path straight from P5's SQLite index (needs `sqlite3` on the P5 host); it does not need the copy |
| P5 volumes or library unreadable | `find_file` still lists the versions, shows them as offline, and says in `notes` that tape locations are unknown |

For a walkthrough see [index search setup](guides/index-search-setup.md) and [find and restore a file](guides/find-and-restore-a-file.md).
