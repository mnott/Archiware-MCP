# Guide: set up file search over all backups

## Why

P5 has no index on file names, so finding "where is offer.docx in all my backups" in P5's own index is a full scan of a multi-GB SQLite file (minutes). `index_sync` copies that index into the catalogue database once; after that a name search takes well under a second and also shows where each version can be fetched from.

## What you do

1. Have a catalogue database (see [web viewer setup](web-viewer-setup.md)) and run `catalog_init`.
2. First sync: `index_sync --detach`. A big index has tens of millions of rows; `--detach` runs on the P5 host, you can disconnect. Without `--detach` a foreground run has a 12 hour limit.
3. Watch it: `index_status` (per client last id and backup time, rows, rows/s, state of the detached run).
4. Nightly: `index_sync` (incremental: only new versions plus versions that ended) from cron.
5. Search: `find_file <name|glob>` ([find and restore a file](find-and-restore-a-file.md)).

## Example

```
archiware catalog_init
archiware index_sync --detach
archiware index_status
```

MCP: `index_sync {"detach":true}`, `index_status {}`.

`index_status` (real output shape, anonymised; before the first sync the counters are zero):

```
{
  "clients": [
    { "client": "localhost", "lastBtime": 0, "lastId": 0, "rows": 0, "updatedAt": "2026-11-09 08:41:18" }
  ],
  "tables": [
    { "table": "dirs", "approxRows": 4820721 },
    { "table": "names", "approxRows": 0 },
    ...
  ]
}
```

Options: `--client C` (one client), `--full` (read everything again, safe to rerun), `--no-dtime` (incremental without the second pass over ended versions; faster, deleted-file status lags until the next full pass).

Cron, every night at 02:15:

```
15 2 * * * archiware index_sync >> /var/log/archiware-index.log 2>&1
```

First search once it ran:

```
archiware find_file "report-2026-*" --under /data/projects --since 2026-01-01 --limit 50
```

```
find_file {"pattern":"report-2026-*","under":"/data/projects","since":"2026-01-01","limit":50}
```

With an empty copy a search returns only the tar catalogue (real output):

```
{ "pattern": "report", "hits": [], "limited": false, "notes": [], "ranking": "disk-tar (1) < tape in library / tar on tape in library (2) < tape offline (3)" }
```

## Watch out

- `index_sync` only reads P5's index (read-only, immutable) and writes to the catalogue database; P5 is not disturbed. It runs at low I/O priority.
- The P5 host needs `sqlite3`.
- A killed run resumes from its last checkpoint; rerun the same command.
- Versions made after the last sync are not found; schedule it nightly.

## See also

[Index and search](../index-and-search.md) | [D2D2T](../d2d2t.md) | [Web viewer](../web-viewer.md)
