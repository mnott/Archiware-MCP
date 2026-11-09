# Guide: take tapes out and bring them back (offsite rotation)

## Why

A backup that lives only in the machine room is not safe against fire or theft. You rotate full tapes out of the house and bring them back when a pool needs them. The tool moves a tape between its slot and the mail slot, tells P5 about it with an inventory, and shows per pool how many tapes are in the library, in the mail slot or out.

## What you do

1. See where each pool stands: `offsite_status`. It warns about pools with no tape out of the house.
2. Export: `tape_export <barcode|label>` shows the plan; add `--yes` to move the tape to the first free mail slot. A P5 inventory follows.
3. Take the tape out of the mail slot by hand and store it offsite.
4. Later, put the tape into the mail slot and run `tape_import` (optionally with the mail slot number). It moves the tape to a free slot of its pool per `slotLayout`, else the first free slot.
5. Prefer a dialog with verified human steps: `library_plan export <tape>` / `library_plan import`, then `library_step <session> --yes` repeatedly ([library layout guide](library-layout.md)).
6. When you need a file from a tape that is out: `offsite_status --path <file>` prints the fetch list (which tapes to bring back).

## Example

```
$ archiware offsite_status
POOL     LIBRARY  MAIL  OUT
Daily    5        0     0
Archive  3        0     0
Weekly   0        0     3
WARNING: pool Daily: no volume of this pool is out of the house
WARNING: pool Archive: no volume of this pool is out of the house
```

MCP: `offsite_status {}` or `offsite_status {"path":"/data/projects/offer.docx"}`.

Export one tape, then import it back:

```
archiware tape_export TAPE001L6
archiware tape_export TAPE001L6 --yes
archiware tape_import
archiware tape_import 24 --yes
```

```
tape_export {"tape":"TAPE001L6"}
tape_export {"tape":"TAPE001L6","confirm":true}
tape_import {"mailSlot":24,"confirm":true}
```

## Watch out

- Without `--yes` / `confirm: true` nothing moves (dry plan).
- Refused while a drive is loaded or a P5 job runs (`--force` overrides; avoid it).
- The P5 location of a tape updates through the inventory at the end; cached tape locations in `catalog_search` and the web viewer may show the old place until `cacheTtlMinutes` expires.
- Putting a tape into the mail slot and taking it out is manual; only the library_plan dialog verifies it.

## See also

[Operations: mail slot, offsite view](../operations.md) | [Library layout guide](library-layout.md) | [Restore](../restore.md) | [CLI reference](../cli.md)
