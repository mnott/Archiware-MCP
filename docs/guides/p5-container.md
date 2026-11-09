# Guide: the P5 container (docker mode): backup and update

## Why

In docker mode P5 runs as a container. Updating P5 means installing a newer `.deb` inside it; if that goes wrong you want a cold copy of the P5 config to go back to. The tool refuses to stop or update the container while a job runs, and refuses an update without a backup younger than 24 hours.

## What you do

1. Look: `container_status` (state, image, P5 version, newest backup).
2. Make sure no job runs (`jobs`, `health`). Scheduled future runs do not block; running or waiting ones do.
3. Back up the P5 config: `container_backup` (preview), `container_backup --yes`. It stops the container for the copy; add `--restart` to start it again afterwards.
4. Download the new P5 `.deb` to the machine where you run the CLI.
5. Update: `container_update <file.deb>` (preview), then `--yes`. It copies the file, checks sha256, installs with dpkg inside the container, waits for P5 to answer and reports the new version and log errors.
6. Verify: `container_status`, `health`, `doctor`.
7. Manual control: `container_stop` and `container_start` (both guarded; start needs no guard).

## Example

```
$ archiware container_status
{
  "container": "archiware",
  "state": "running",
  "image": "example/archiware:7.4.5",
  "p5Version": "8.0.6",
  "lastBackup": { "dir": "/backup/archiware-update-20261108", "at": "2026-11-08T15:28:20.000Z" }
}
```

```
archiware container_backup --restart
archiware container_backup --restart --yes
archiware container_update ./p5-8.0.7.deb
archiware container_update ./p5-8.0.7.deb --yes
```

```
container_status {}
container_backup {"restart":true,"confirm":true}
container_update {"deb":"/path/to/p5-8.0.7.deb","confirm":true}
```

## Watch out

- `container_backup` stops the container: no backup or restore runs during that time.
- `container_update` refuses without a backup newer than 24 h (`--skip-backup-check` overrides; do not).
- `--force` overrides the running-job guard on stop, backup and update; a stopped running job is lost.
- Only in docker mode; in `ssh` and `local` mode the `container_*` tools answer "not applicable".
- P5's own maintenance restart window is separate and waits for idle by itself.

## See also

[Operations: restart guard, safety model](../operations.md) | [Configuration](../configuration.md) | [CLI reference](../cli.md) | [Daily checks](daily-checks.md)
