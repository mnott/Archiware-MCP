# Guide: pack a folder to tars on disk (D2D2T)

## Why

Large, finished data (a project archive, raw footage) is awkward to back up as millions of small files. You cut the folder into a few big tar files on disk, record every file in a catalogue, and let P5 back up the tars to tape. Later you can still find a single file by name, see which tar and which tape holds it, and restore just that file.

## What you do

1. Once: set up the catalogue database ([web viewer setup](web-viewer-setup.md) is the easy way) and run `catalog_init`.
2. Plan the pack: `pack <source dir> --set NAME --max 50G` (no `--yes`: walks the folder once, shows tar names, sizes, time estimate).
3. Run it. For TB-sized sets use `--detach --yes`: a runner on the P5 host, you can disconnect. Without `--detach` the call stays until done. Both resume per tar if repeated.
4. Follow a detached pack with `pack_status --set NAME`; stop after the current tar with `pack_stop --set NAME --yes`.
5. Make sure a P5 plan backs up the pack root.
6. Find: `catalog_sets` (what exists), `catalog_search "<pattern>" --set NAME`.
7. Restore one file: `catalog_restore <path> --set NAME` (preview), then `--yes --plan <planId>`.
8. Drop a set from the catalogue (test sets, re-packs): `catalog_drop --set NAME --yes`. Tars are not deleted.

## Example

```
archiware catalog_init
archiware pack /data/projects --set projects --max 50G
archiware pack /data/projects --set projects --max 50G --detach --yes
archiware pack_status --set projects
archiware catalog_sets
archiware catalog_search "offer*.docx" --set projects --limit 20
archiware catalog_restore data/projects/offer.docx --set projects
archiware catalog_restore data/projects/offer.docx --set projects --yes --plan 20261109-101500-3fa9c1
archiware catalog_drop --set projects --yes
```

MCP:

```
pack {"source":"/data/projects","set":"projects","max":"50G","detach":true,"confirm":true}
pack_status {"set":"projects"}
pack_stop {"set":"projects","confirm":true}
catalog_sets {}
catalog_search {"pattern":"offer*.docx","set":"projects"}
catalog_restore {"path":"data/projects/offer.docx","set":"projects"}
catalog_drop {"set":"projects","confirm":true}
```

`catalog_sets` with no set yet (real output):

```
{ "sets": [] }
```

`pack_status` for a set that was never packed (real output):

```
Error: no pack directory /srv/pack/x (set x was never packed with --yes)
```

## Watch out

- `pack` without `--yes` writes nothing. With `--yes` it writes tars under `<packRoot>/<set>/` and catalogue rows.
- `catalog_restore` takes the file path relative to the set's source root. A tar only on tape is not restored by the tool: you get the P5 GUI steps.
- `catalog_drop` removes catalogue rows only. Rows for a dropped set are gone; repack to get them back.
- A file name containing a newline cannot be packed (reported in the plan).

## See also

[D2D2T reference](../d2d2t.md) | [Restore](../restore.md) | [Find and restore a file guide](find-and-restore-a-file.md)
