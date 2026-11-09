# Guide: find a file in all backups and restore it

## Why

Someone deleted or overwrote a file and you only remember its name. You want every backed-up version, across P5 backups and tar packs, with the cheapest place to fetch each from, and then a restore that cannot hurt anything: always into a restore folder unless you say otherwise, always planned before it runs.

## What you do

1. Find: `find_file <name|glob>`; narrow with `--under`, `--since`, `--client`, `--limit`. This needs the index copy ([index search setup](index-search-setup.md)); if you know the exact path, `restore_options <path>` works without it.
2. Pick a version: its key is `<mtime>-<size>`. Locations are ranked: 1 disk-tar, 2 tape in library, 3 tape offline (shows the barcode to insert).
3. Preview: `restore_version <path> <versionKey>` prints a plan with a `planId` (destination, bytes, free space, tree, existing files that would conflict).
4. Run it: repeat the same command with `--yes --plan <planId>`.
5. Three outcomes depending on where the version is:
   - Tar on disk: the tool extracts the file.
   - Archive entry (P5 archive index): `restore_archive <path>` runs a P5 restore job (preview, then `--yes --plan <id>`).
   - P5 backup version: P5's CLI and REST cannot select one path, so the plan carries `manual` with the exact P5 GUI steps and the volumes to have in the library. `--yes --plan` only prepares the destination folder.

## Example

```
$ archiware find_file offer.docx --limit 2
```

MCP: `find_file {"pattern":"offer.docx","limit":2}`. The result (shortened and anonymised):

```
/data/projects/offer.docx
  1760000000-48213   (mtime 2026-10-09, 48213 bytes)
    1 disk-tar        set projects, tar projects-0003.tar
    2 tape-library    volume Daily.0001, TAPE001L6, slot 14
```

Preview and run:

```
archiware restore_version /data/projects/offer.docx 1760000000-48213
archiware restore_version /data/projects/offer.docx 1760000000-48213 --yes --plan 20261109-101500-3fa9c1
```

```
restore_version {"path":"/data/projects/offer.docx","version":"1760000000-48213"}
restore_version {"path":"/data/projects/offer.docx","version":"1760000000-48213","confirm":true,"planId":"20261109-101500-3fa9c1"}
```

Destination and conflicts:

```
archiware restore_version <path> <key> --to /data/restore-test --on-conflict rename
archiware restore_version <path> <key> --to original --on-conflict refuse
archiware restore_version <path> <key> --from <location id>
```

A P5 backup version found with `restore_options`:

```
archiware restore_options /data/projects/offer.docx --since 2026-01-01
archiware restore --at "2026-11-09 03:00" /data/projects/offer.docx
```

MCP: `restore_options {"path":"/data/projects/offer.docx"}`, `restore {"at":"2026-11-09 03:00","path":"/data/projects/offer.docx"}`.

## Watch out

- Default destination: `<restoreRoot>/<YYYYMMDD-HHMMSS>/<original path>`. `--to <dir>` places the original path below that directory.
- `--to original` is only for tar extracts, never for P5 restores; below a `syncRoots` path it also needs `--force-sync`.
- Conflicts: `refuse` (default) stops on any existing file, `rename` keeps both (`<name>.restored-YYYYMMDD`, tar restores only), `overwrite` replaces. A P5 restore can only `refuse` or `overwrite`.
- If the destination or the conflicting files changed since the preview, the run is refused and a new plan is shown.
- A version that is only on offline tapes is refused with "insert <barcode>"; see [offsite rotation](offsite-rotation.md).

## See also

[Restore](../restore.md) | [Index and search](../index-and-search.md) | [D2D2T](../d2d2t.md) | [D2D2T packs guide](d2d2t-packs.md)
