# File catalogue and packs (D2D2T, optional)

This is an optional feature for data that is packed into tar files on disk and then goes to tape (disk to disk to tape). If you only back up with P5 plans, you do not need it.

## How the tiers relate

1. **Disk tier.** `pack` cuts a source folder into tar files under `packRoot` (`<packRoot>/<set>/`) and records every file in the catalogue.
2. **Tape tier.** P5 backs the pack root up like any other folder. P5 knows which tar is on which tape; the catalogue knows which file is in which tar. `catalog_search` and `find_file` join the two.
3. When a tar is later removed from disk, its files stay in the catalogue. A search then shows the tar as "on tape" with the volume label, barcode and where the tape is (library slot, mail slot, or not in the library).

The catalogue is a MySQL / MariaDB database `archive_catalog` with the tables `sets`, `tars`, `entries` (plus the index copy tables and `p5_cache`, see [index-and-search.md](index-and-search.md)). It runs in a container on the P5 host and is reached like a host job: `docker exec -i <container> mysql --defaults-extra-file=/dev/stdin ... < <cnf>` over the normal transport. The credentials file stays on the host and is never printed. The SQL client is detected in the container (`mariadb`, else `mysql`), so both images work.

The easiest way to get the database is the web viewer deploy ([web-viewer.md](web-viewer.md)): it creates a database container and points the config at it. You can also use any MySQL container you maintain.

## Configuration

Keys (full table in [configuration.md](configuration.md)):

```json
{
  "catalogMysqlContainer": "mysql",
  "catalogDbCnf": "/root/.mysql-catalog.cnf",
  "packRoot": "/srv/archive/pack",
  "packRootP5": "",
  "packMBps": 150,
  "cacheTtlMinutes": 60
}
```

`catalogDbCnf` is a client file on the P5 host (mode 600):

```
[client]
user=catalog
password=<password of the catalogue user>
```

`packRootP5` is the pack root as the P5 container sees it (a docker mount point); empty means the same path. It is used to look tars up in P5's backup index.

## Create the schema

```
archiware catalog_init
```

Idempotent. Creates the tables, including the file index tables and `p5_cache`. There is no full-text index: substring search is a `LIKE` on the `(set_id, path)` and `basename` indexes.

## Pack a folder

```
archiware pack /data/projects --set projects --max 50G
archiware pack /data/projects --set projects --max 50G --yes
archiware pack /data/projects --set projects --max 50G --detach --yes
```

| Option | Meaning |
|---|---|
| `<source dir>` | Absolute path on the P5 host |
| `--set NAME` | Set name (letters, digits, `.`, `_`, `-`) |
| `--max SIZE` | Target tar size, for example `50G`, `500M`; default `50G` |
| `--into DIR` | Pack root to use instead of `packRoot` |
| `--replan` | Throw away the stored plan and plan again |
| `--detach` | Run the whole pack as one runner on the host; see below |
| `--yes` | Write. Without it only the plan is printed |

The plan (no `--yes`) is one low-priority `find` walk. The folder is cut along folder boundaries: a folder bigger than `--max` is split one level deeper, a single file bigger than `--max` gets its own tar. You see the tar names, sizes, file counts and a time estimate (from `packMBps`). File names that contain a newline cannot be packed and are reported in the plan; bytes in names that are not valid UTF-8 are dropped from the catalogue copy of the name.

With `--yes`, per tar: `tar --sort=inode` to a `.part` file, a sha256, a plain-text `<tar>.list` (path, size, mtime) next to the tar so the catalogue can be rebuilt from disk or tape alone, then the tar row and all its member rows in one transaction (batches of 2000 rows), then the `.done` marker. Run the same command again to resume; the plan is stored in `<tar dir>/.plan.json`. `pack` never takes the nsdchat lock.

### Detached packs

`--detach --yes` uploads one self-contained shell runner to `<tar dir>/.runner.sh` and starts it with `setsid nohup`. The client can disconnect. It does the same steps, is resumable per tar (`.done` markers) and logs to `<tar dir>/.runner.log`. The set status is `packing`, `packed` or `stopped`.

```
archiware pack_status --set projects
archiware pack_stop --set projects --yes
```

`pack_status` shows whether it runs, tars done and total, bytes, the current tar, the rate, the ETA and the last log lines. `pack_stop` writes a stop marker; the runner stops after the current tar. Rerun the same `pack --detach --yes` to resume.

## Look around

```
archiware catalog_sets
archiware catalog_search "offer*.docx" --set projects --limit 50
```

`catalog_sets` lists sets with tar count, file count, bytes and status. `catalog_search <pattern> [--set N] [--limit N]` takes a glob (`*`, `?`) or a substring; per hit it shows set, path, size, mtime, tar, whether the tar is still on disk, and the tape versions of that tar (date, plan, volume label, barcode, location). Default limit 20, at most 500. For one search across P5 backups and tars together, use `find_file` ([index-and-search.md](index-and-search.md)).

### Cache

The tape side of a hit (P5 backup index plus volume label, barcode, location) is slow to look up. `catalog_search` and the web page keep it in the table `p5_cache` for `cacheTtlMinutes` (default 60, `0` = off). If P5 cannot be asked, the expired entry is returned marked `stale`, with `cachedMinutesAgo` and a note. A tape that was just exported or imported shows its old location until the entry expires. Restores never use the cache for the restore itself.

## Restore one file from a set

```
archiware catalog_restore data/projects/offer.docx --set projects
archiware catalog_restore data/projects/offer.docx --set projects --yes --plan <planId>
```

Same plan and `--to`, `--on-conflict`, `--force-sync`, `--plan` rules as every restore, see [restore.md](restore.md). A tar that is on disk is extracted by the tool. A tar that is only on tape is not restored by the tool: P5 cannot restore one path of a backup version through its CLI or REST, so `catalog_restore` stops with the GUI steps (restore the tar, put it back at its pack path, run the command again). With no tape of it in the library it refuses and prints the fetch list.

## Drop a set

```
archiware catalog_drop --set projects --yes
```

Deletes the set's rows from the catalogue. The tars on disk and on tape are not touched.

## Move the catalogue

See `catalog_migrate` in [web-viewer.md](web-viewer.md#move-an-existing-catalogue-database-into-the-viewer).

For a walkthrough see [D2D2T packs](guides/d2d2t-packs.md).
