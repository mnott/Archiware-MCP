# Guide: a routine copy of P5's configuration and indexes

## Why

P5's configuration and its backup/archive indexes are SQLite files in the config folder (the backup index `index/backup/bsx_<client>/files.db` is several GB). Today they are only (a) backed up by P5 itself to tape while P5 writes to them, so a live file copy can be inconsistent and a restore needs a working P5 and the right tape, and (b) copied once before an update by `container_backup`, which stops the container. Losing the P5 server then means re-indexing every tape, which takes days.

`p5_config_backup` makes a consistent copy on disk, outside P5, that can be restored without P5. P5 keeps running.

### P5's own copy on container volumes (offsite)

P5 itself writes a copy of its configuration database to the last volume of every backup job, and on container (disk or cloud) volumes also a copy of the backup indexes. The job protocol says so in its closing notice. A small backup plan that writes to a container volume backed by cloud storage therefore gives you an offsite copy of configuration and indexes every day, at no extra effort:

- a backup plan with a daily event into a pool of container volumes whose storage is a cloud object store (P5: Cloud storage, e.g. Google Cloud Storage, S3);
- as its task, the P5 installation folder (or any small folder: the point is the configuration and index copy P5 adds, not the files);
- a retention matching how far back you want to be able to rebuild.

Restoring from it needs a P5 with the same cloud credentials and the container volume attached. Use both: the cloud copy survives the loss of the site, the local `p5_config_backup` copy restores in minutes without P5 or network.

## What you do

1. Set `backupDir` (and optionally `p5ConfigBackupKeep`, default 7) in the config. `sqlite3`, `flock`, `ionice` and `sha256sum` must exist on the P5 host (the tool tells you which is missing).
2. Look at the plan: `archiware p5_config_backup` (sources, destination, estimated size, free space). Nothing is written.
3. Run it: `archiware p5_config_backup --yes`. It
   - finds every SQLite database under the config tree by its file header (not its extension) and copies each with SQLite's online backup (`sqlite3 .backup`), never with cp or tar;
   - runs `PRAGMA integrity_check` on each copy;
   - tars everything else (no databases, no lock, tmp, wal, shm or journal files);
   - writes `manifest.json` (P5 version, databases with size and page count, integrity result, duration) and `SHA256SUMS`, verifies them and marks the copy `VERIFIED`;
   - only then deletes copies beyond the newest N verified ones (and copies marked `FAILED`). `archiware-update-*` directories are never touched.
   It runs under `flock` (two runs never overlap) with `nice -n 19` and `ionice -c3`. It does not stop P5 and does not use nsdchat for the copy.
4. Check: `archiware p5_config_backup --status` lists copies with age, size and state. `health` and `doctor` warn when the newest verified copy is older than 36 h (only once at least one copy exists).

Destination: `<backupDir>/p5-config/<YYYYMMDD-HHMMSS>/` with `db/<same relative path as in the config tree>`, `config-rest.tar`, `manifest.json`, `SHA256SUMS`, `VERIFIED`.

## Example

```
$ archiware p5_config_backup
{ "confirmationRequired": true, "destination": "/backup/p5-config/20261109-030000/", "estimatedSizeMB": 36900, "freeSpaceMB": 8500000, ... }
$ archiware p5_config_backup --yes
{ "destination": "/backup/p5-config/20261109-030000", "result": "OK /backup/p5-config/20261109-030000 5412", "copies": 4, "p5Version": "8.0.6" }
$ archiware p5_config_backup --status
{ "copies": [ { "name": "20261109-030000", "age": "1 h", "sizeMB": 36900, "state": "verified" } ], "warning": null }
```

```
p5_config_backup {"confirm":true}
p5_config_backup {"status":true}
```

Cron, shortly before the nightly tape plan so that the copy also lands on tape (adjust the time to your plan; the run takes as long as the databases are big):

```
# P5 config copy at 01:00; the backup plan starting later also saves <backupDir>/p5-config
0 1 * * *  archiware p5_config_backup --yes >> /var/log/archiware-config-backup.log 2>&1
```

Restore without P5:

1. Stop the container: `archiware container_stop --yes` (or `docker stop -t 120 <container>`).
2. Verify the copy: `cd <backupDir>/p5-config/<stamp> && sha256sum -c SHA256SUMS`.
3. Move the current config aside: `mv <configDir> <configDir>.old-$(date +%Y%m%d)`; `mkdir <configDir>`.
4. Untar the rest: `tar -C <configDir> -xf <copy>/config-rest.tar`.
5. Copy the databases back, keeping the relative paths: `cp -a <copy>/db/. <configDir>/`. Fix ownership to what the old config had (`chown -R --reference=<configDir>.old-... <configDir>`).
6. Start: `archiware container_start --yes`. Check `health`, `container_status`, and that a backup index answers (`find_file <name>`).

## Watch out

- The integrity check reads each copied database completely; for a 10 GB index that takes minutes. Plan the run for a quiet hour.
- Copies need roughly the size of the config tree each; with the default of 7 keep free space for 7 times that, or lower `p5ConfigBackupKeep`.
- A database that P5 writes heavily during the copy makes the online backup restart; if a run fails, the failed copy is marked `FAILED` and older copies stay.
- The copy sits on the same host as P5 unless `backupDir` is on another disk or share; let your host backup or P5's own plan carry it away.
- Optional extra, not a backup: P5 Archive Export and the ArchiveIndex inventory TSV export give a human-readable list of archive contents. They cannot restore P5.

## See also

- [disaster-recovery](disaster-recovery.md): the small kit (config databases, keys, compose, image, program tree) for rebuilding the server
- [p5-container](p5-container.md): cold backup and update of the container
- [index-search-setup](index-search-setup.md): the searchable copy of the backup index
- [daily-checks](daily-checks.md)
