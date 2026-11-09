# Guide: keep the tapes in a fixed slot layout

## Why

A tape library works best when you always know where a tape is: daily tapes in slots 14-22, yearly tapes in 9-12, the cleaning tape in 24. Then a person at the mail slot, a script and P5 all agree. Over time tapes drift (a new tape goes into the first free slot, a tape comes back from offsite somewhere else). You declare the layout once in the config and let the tool show and fix the difference with the fewest possible moves.

## What you do

1. Declare the layout in the config (`slotLayout`, optionally `mailSlots`, `cleaningSlot`), see [configuration](../configuration.md):
   `"slotLayout": {"Yearly": "9-12", "Daily": "14-22"}`
2. Look at the library: `library_layout`. Status per slot: `ok`, `misplaced` (tape of another pool), `foreign` (barcode unknown to P5), `empty`.
3. Plan a rearrangement as a dialog: `library_plan arrange` returns a session id and the steps. Nothing moves yet. Add `--simulate` to walk it on a virtual library first.
4. Execute one step at a time: `library_step <session>` (preview) and `library_step <session> --yes`. Repeat until done. The last step runs a P5 inventory and `library_reconcile`.
5. Check progress with `library_status <session>`; stop cleanly with `library_abort <session>`.
6. Alternative without a dialog: `library_arrange` shows the whole move list, `library_arrange --yes` runs it in one go.

If a session was interrupted (ssh dropped, a human step not done): run `library_status <session>`, then `library_step <session>` again. Each step re-checks drives, running jobs and the expected slot contents and stops if reality differs from the plan. If the library moved on its own, drop the session with `library_abort` and plan again.

## Example

Look at the library (real output shape, anonymised; here without a `slotLayout`, so the target is empty):

```
$ archiware library_layout
SLOT  KIND     BARCODE   LABEL      POOL     TARGETPOOL  STATUS   NOTE
1     storage  TAPE001L6 Daily.0001 Daily    -           ok       slot not covered by slotLayout
...
15    storage  TAPE015L6 -          -        -           foreign  barcode unknown to P5
...
23    storage  CLNU00L1  -          -        -           ok       cleaning tape
24    mail     -         -          -        -           empty    -
```

MCP: `library_layout {}`. With `slotLayout` set, the TARGETPOOL column shows the pool each slot should hold and a tape in the wrong slot is `misplaced`.

Plan, then step (CLI and MCP):

```
archiware library_plan arrange --simulate
archiware library_plan arrange
archiware library_step 20261109-101500-ab12cd
archiware library_step 20261109-101500-ab12cd --yes
archiware library_status 20261109-101500-ab12cd
```

```
library_plan {"kind":"arrange"}
library_step {"session":"20261109-101500-ab12cd"}
library_step {"session":"20261109-101500-ab12cd","confirm":true}
library_status {"session":"20261109-101500-ab12cd"}
```

When the layout already matches (real output):

```
{ "nothingToDo": true, "note": "Library already matches the slotLayout.", "problems": [] }
```

After the moves: `archiware library_reconcile` (and `--yes` to let it update `cleaningSlot` if the cleaning tape moved).

## Watch out

- Real moves need `--yes` / `confirm: true`; without it you only see the plan.
- Moves are refused while a drive is loaded or a P5 job runs; `--force` overrides, do not use it during a backup.
- The tool never rewrites `slotLayout`; it is yours.
- Sessions are stored in `library_session.json` next to the config.
- P5 slot settings for reserved or mail slots cannot be set by the tool; `library_reconcile` lists them as a manual check.

## See also

[Operations: slot layout, conversational execution, after moves](../operations.md) | [Configuration](../configuration.md) | [CLI reference](../cli.md) | [Offsite rotation](offsite-rotation.md)
