# Restore

archiware-mcp never restores in place by default, and it never starts anything without showing you a plan first. This page explains the restore tools, what each one runs by itself, and what it leaves to you.

## Which tool for what

| You want | Tool (CLI = MCP name) | Runs by itself? |
|---|---|---|
| List the backed-up versions of one path | `restore_options <path>` | read-only |
| Find a file by name, then restore one version | `find_file`, then `restore_version <path> <versionKey>` | disk tars: yes. P5 backup versions and tars only on tape: no, prints the steps |
| One file out of a packed tar set | `catalog_restore <path> --set NAME` | tar on disk: yes. Tar only on tape: no |
| One path of a P5 backup version | `restore --at "<start>" <path>` | No. Plan and exact P5 GUI steps |
| One entry of a P5 archive index | `restore_archive <path>` | Yes (P5 restore job) |
| Everything on one backup volume | `restore_volume <volume>` | Yes (P5 restore job), only when you ask for it explicitly |
| See what a backup volume holds | `restore_lookup <volume>` | read-only, slow on big volumes |

Every restore tool that can write has the same safety rules, described next.

## The plan, then the run

Without `--yes` a restore tool changes nothing and prints a plan. In the CLI the text form shows every field; `--json` shows the raw object.

| Field | Meaning |
|---|---|
| `planId` | Identifier of this plan, form `<YYYYMMDD-HHMMSS>-<6 hex>`. The stamp is the name of the restore folder |
| `source` | What is restored: the chosen version (backup time, level, or tar name and sha), and where from: `disk-tar <path>`, or the P5 volumes (label, volume id, barcode, location) |
| `host` | Machine that gets the files (`this machine`, the ssh host, or `<ssh host> (container <name>)` for P5-side restores) |
| `destination`, `destinationMode` | Absolute destination and its mode: `restore-folder` (default), `directory` (`--to <dir>`) or `original` |
| `bytesToWrite`, `entries` | Total size and number of entries |
| `freeBytesAtDestination` | Free space at the destination (`df` on the host, or in the P5 container for a P5 restore). Less than needed refuses the restore |
| `tree`, `treeMore` | The first 50 entries that will be written, and how many more |
| `conflicts` | Count, the first 50 destination files that already exist (current size and time next to restored size and time), and how many more |
| `conflictPolicy` | The policy in words |
| `warnings`, `notes` | For example a sync-root warning; for a folder, that only its direct entries are listed |
| `refused` | Present when something blocks the run; says what and how to resolve it |
| `manual` | Present when the tool does not run the restore itself: why, the P5 address, the numbered steps, and `volumesNeeded` (volume, label, barcode, location) |
| `next` | What to run to execute exactly this plan |

To run the plan, repeat the same command with `--yes --plan <planId>`:

```
archiware restore_version /data/projects/offer.docx 1760000000-48213
archiware restore_version /data/projects/offer.docx 1760000000-48213 --yes --plan 20261109-101500-3fa9c1
```

The plan id covers the source version, the destination, the policy and the list of conflicting files. If any of that changed since the preview (another destination, a new conflicting file), the run is refused and the new plan is shown; review it and repeat with the new id. A `--yes` without `--plan` is refused and shows the plan id. In MCP the arguments are `confirm: true` and `planId`.

## Destination

| `--to` | Result |
|---|---|
| not given | The default: a restore folder `<restoreRoot>/<YYYYMMDD-HHMMSS>/<original absolute path>`. `restoreRoot` defaults to `<packRoot>/restore`. For P5-side restores the path is translated with `packRootP5` |
| `--to <dir>` | An absolute directory on the P5 host (inside the container for P5-side restores). The original absolute path is placed below it |
| `--to original` | The original location. Only for single files from a tar (`catalog_restore`, and `restore_version` from a disk tar) |
| `--to /` | Refused. Say `--to original` |

P5 restores (`restore`, `restore_archive`, `restore_volume`, and `restore_version` for a version on a tape in the library) never accept `--to original`: the P5 restore job runs asynchronously inside P5, so conflicts cannot be checked at write time. Restore into a folder and move what you need.

## Conflicts: `--on-conflict`

| Value | Behaviour |
|---|---|
| `refuse` (default) | Any destination file that already exists refuses the whole restore |
| `rename` | The existing file stays; the restored one becomes `<name>.restored-YYYYMMDD`. Only for restores from a tar (extracted to a temporary directory next to the destination and moved) |
| `overwrite` | Existing destination files are replaced |

A P5 restore cannot `rename`, because the P5 job is asynchronous and nothing can be moved after it. It can `refuse` or `overwrite`.

## Sync roots: `syncRoots` and `--force-sync`

`syncRoots` in the config lists host paths whose content is synced to other machines (a Seafile library path, a sync mount). A destination below one gets a warning that restored files will be synced out. `--to original` below one is refused unless you add `--force-sync` (MCP: `forceSync: true`). Restoring to a folder and moving the file by hand is the safer way.

## Restore one version found by `find_file`

```
archiware find_file offer.docx
archiware restore_version /data/projects/offer.docx 1760000000-48213
```

`restore_version <path> <versionKey> [--to original|<dir>] [--on-conflict refuse|rename|overwrite] [--force-sync] [--from <location id>] [--client C]`. The version key is `<mtime>-<size>` as `find_file` shows it. The cheapest location is used unless `--from` names a location id (see [index-and-search.md](index-and-search.md) for the ranking).

| Location kind | What happens |
|---|---|
| `disk-tar` | The file is extracted from the tar on disk. Runs after `--yes --plan` |
| `tape-library` (P5 backup version, tape in the library) | Treated like `restore --at`: plan, then the P5 GUI steps. The tool prepares the destination folder and starts nothing |
| `tar-on-tape` (tar not on disk, tape in the library) | The plan is shown. With `--yes --plan` the tool stops with an error that tells you to restore the tar with the P5 GUI, put it back at its pack path and run the command again |
| `tape-offline`, or a tar only on offline tapes | Refused: "insert `<barcode>`, then run `tape_import`", then retry |

Example plan (placeholders):

```
$ archiware restore_version /data/projects/offer.docx 1760000000-48213
Restore plan 20261109-101500-3fa9c1
  source:       disk-tar /srv/archive/pack/projects/projects-0003.tar
  host:         p5host.example.org
  destination:  /srv/archive/pack/restore/20261109-101500 (restore-folder)
  bytes:        48213 bytes (0.0 MiB)
  free space:   912345678901 bytes (869981.2 MiB)
  entries:      1
  policy:       refuse: nothing is written when any destination file exists
  conflicts:    0
  tree:
    - /srv/archive/pack/restore/20261109-101500/data/projects/offer.docx (48213 bytes)

to run exactly this: repeat the call with confirm/--yes and plan 20261109-101500-3fa9c1
  i.e. --yes --plan 20261109-101500-3fa9c1
```

With `--to original` and an existing file, the plan lists the conflict with both sizes and times and a `REFUSED:` line. Add `--on-conflict rename` or `overwrite` to get a plan that can run.

## One path of a P5 backup version: `restore --at`

```
archiware restore_options /data/projects/offer.docx
archiware restore --at "2026-10-20 16:03" /data/projects/offer.docx
archiware restore --at "2026-10-20 16:03" /data/projects/offer.docx --yes --plan <planId>
```

`restore_options` lists every backed-up version of the path from P5's own per-client backup index, newest first: backup time (`start`), modification time, size, plan, level and every volume that holds a copy (label, pool, barcode, where the tape is now: drive, library slot n, mail slot, or not in the library). Tapes to bring back are listed in a fetch list. `--at` takes the `start` of the version you chose (or its backup time as a number). `--client C` selects another P5 client (default `localhost`). The path may be a file or a folder; for a folder the preview lists its direct entries.

`restore` never starts a P5 job for a backup version. The plan has the usual fields, plus `manual`: why, the volumes that hold the version with barcode and location, and numbered steps for the P5 GUI, for example:

1. open the P5 web address and sign in
2. Restore > Backup: client `<client>`
3. navigate to the path
4. pick the backup date
5. restore to the folder from the plan (the tool creates it when you run with `--yes --plan <planId>`)
6. keep the conflict policy shown

Run `--yes --plan` to have the tool create the destination folder; then do the steps in the GUI.

Why the tool does not run it: the documented CLI and REST of P5 cannot select one path of a backup version.

Sources: the [P5 CLI reference](https://support.archiware.com/downloads/cli.pdf) and the [P5 REST API](https://www.archiware.com/blog/redoc/p5_rest_api/awp5api.html). What was found when trying them against a live P5 8 server:

- Through the CLI (`nsdchat`), `RestoreSelection` has `addentry <handle>`, which needs an archive entry handle, and `addfromvolume <volume>`, which selects a whole volume. `findentry` on a backup index or backup plan answers `no such index or plan`, and `ArchiveEntry handle` knows only archive databases.
- Through REST, `POST restore/restoreselections` answered `Missing Client ID` for every body shape that was tried, so no single backup entry could be put into a selection.

Details are in [REST.md](../REST.md). If a later P5 version adds a way to select one backup path, this is the place to change.

The tool therefore does not guess: it uses `addfromvolume` only through the explicit `restore_volume`.

## Single-path restores in 0.2.0

Single-path restores in 0.2.0 used a whole-volume selection (`addfromvolume`) and restored the entire tape. This is fixed: `restore --at` and `restore_version` never select a volume any more. See [CHANGELOG.md](../CHANGELOG.md).

## Archive entries: `restore_archive`

```
archiware restore_archive /data/archive/2024/scan-0001.tif
archiware restore_archive /data/archive/2024/scan-0001.tif --yes --plan <planId>
```

`restore_archive <path> [--index Default-Archive] [--to <dir>] [--on-conflict refuse|overwrite]` restores one entry of a P5 archive index (a file, or a folder with everything below it). Archive entries have a handle, so P5 can select exactly that entry: the tool creates a restore selection for the destination, adds the entry, and submits it. It returns the P5 job id and does not wait for the job. The preview reads the selection back (entries and bytes as P5 counts them), then destroys the probe selection and submits nothing. It refuses when the entry is on no volume that is online: bring the tape in with `tape_import` and retry.

## Whole volume: `restore_volume`

```
archiware restore_volume <volume id>
archiware restore_volume <volume id> --yes --plan <planId>
```

`restore_volume <volume> [--to <dir>] [--on-conflict refuse|overwrite]` restores everything on one backup volume (all clients, all paths) to a folder. Use it only when you want exactly that. The plan shows the volume (label, barcode, location), its used size and the free space. The tree is not listed because a volume inventory takes minutes. The job runs in P5; the tool returns its id and does not wait. Nothing else in archiware-mcp ever selects a whole volume.

## One file out of a tar: `catalog_restore`

`catalog_restore <path> --set NAME [--to original|<dir>] [--on-conflict refuse|rename|overwrite] [--force-sync]`. The path is relative to the set's source root, as `catalog_search` shows it. A tar that is still on disk is extracted by the tool (plan, then `--yes --plan`). A tar that is only on tape needs a manual step first: restore the tar with the P5 GUI, put it back, run the command again. If no tape holding it is in the library the tool refuses and prints the fetch list. See [d2d2t.md](d2d2t.md).

## What runs automatically, in one table

| Source | Runs by itself | Does not run |
|---|---|---|
| Tar on disk | extraction of the one file (`catalog_restore`, `restore_version`) | |
| Archive entry | P5 restore job (`restore_archive`) | |
| Whole backup volume | P5 restore job, only via `restore_volume` | |
| Version in a P5 backup (path in a backup) | nothing: destination folder is created, you get the GUI steps | the restore itself |
| Tar only on tape | nothing: error with the GUI steps | restoring the tar from tape |

For a walkthrough see [find and restore a file](guides/find-and-restore-a-file.md).
