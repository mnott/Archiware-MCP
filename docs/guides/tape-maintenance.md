# Guide: tape maintenance (clean, label, inventory, header, erase)

## Why

P5's CLI cannot clean a drive or erase a tape, and labelling and inventory are easier to run from one place. The host-side tools drive the library directly with `mtx`/`mt` on the P5 host, one tape at a time, and always unload the tape afterwards.

## What you do

1. See the library and which tapes P5 knows: `slots` (per slot: barcode, P5 volume, pool, mode), `volumes`, `pools`. A tape with `UNKNOWNTOP5 true` is new or foreign.
2. Clean a drive when `health` or `status` flags it: `clean_drive <p5 device|gen>` (for example `sg7` or `L6`).
3. Label new, empty tapes for a pool: `label_tapes <jukebox> <pool> <slot...>`.
4. After manual changes tell P5: `inventory <jukebox>` (add `--barcode` for a barcode scan).
5. Check what is on a tape without keeping it loaded: `tape_read_header <slot>`.
6. Re-use a tape: `tape_erase <slot...>`.
7. Load or unload by hand: `tape_load <slot>`, `tape_unload <slot>`.

## Example

```
$ archiware slots
SLOT  BARCODE    FULL  LOADEDINDRIVE  P5VOLUME  LABEL       POOL    MODE        STATE  UNKNOWNTOP5
14    TAPE014L6  true  false          10158     Daily.0001  Daily   Appendable  Ok     false
15    TAPE015L6  true  false          -         -           -       -           -      true
23    CLNU00L1   true  false          -         -           -       -           -      true
24    -          false false          -         -           -       -           -      true
```

MCP: `slots {}`.

```
archiware clean_drive L6
archiware clean_drive L6 --yes
archiware tape_read_header 15
archiware label_tapes Library1 Daily 15 --yes
archiware inventory Library1 --barcode --yes
archiware tape_erase 15
archiware tape_erase 15 --yes
archiware tape_erase 15 --yes --erase-known
```

```
clean_drive {"drive":"L6","confirm":true}
tape_read_header {"slot":15}
label_tapes {"jukebox":"Library1","pool":"Daily","slotIds":["15"],"confirm":true}
inventory {"jukebox":"Library1","barcode":true,"confirm":true}
tape_erase {"slots":[15]}
tape_erase {"slots":[15],"confirm":true}
tape_erase {"slots":[15],"confirm":true,"eraseKnown":true}
```

Without `--yes` / `confirm: true` the destructive tools print what they would run (`wouldRun`) and change nothing.

## Watch out

- `label_tapes` and `tape_erase` DESTROY the contents of the tapes in the given slots. `tape_erase` refuses a tape whose barcode P5 still knows as a volume (error names slot, barcode, volume id and pool) and a tape with an unreadable barcode, before loading anything; the preview lists these under `refused`. Recycle or remove the volume in P5 first, or pass `--erase-known` (MCP `eraseKnown: true`) to override. Still double-check the slot numbers.
- `label_tapes` only accepts new or empty tapes.
- All host-side tape tools refuse while a P5 job runs or a drive is loaded, unless `--force`.
- They need passwordless `sudo -n` for `mtx`, `mt`, `dd` on the P5 host.
- `tape_read_header` is read-only in data terms and unloads the tape afterwards.

## See also

[Operations: host-side tape operations, safety model](../operations.md) | [CLI reference](../cli.md) | [Library layout guide](library-layout.md)
