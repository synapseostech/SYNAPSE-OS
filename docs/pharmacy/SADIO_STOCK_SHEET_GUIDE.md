# SADIO PHARMACY — filling the StockBatches sheet

This is the operator instruction for the one piece of data Tally's export cannot
supply: the batch and expiry behind the opening stock. It is written against the
staged export of **SADIO PHARMACY** (15 files, stated period 2025-10-01 →
2026-11-30). Filling it changes nothing in Tally.

## 1. Why the sheet is needed

Tally's masters export states each stock item's opening quantity and value, but
it names no batch and no expiry for that stock. Synapse will not invent either.
Without both, opening stock stays in the ledger only: it appears as a value, but
it cannot be sold, allocated or recalled, and every sale replays against empty
shelves.

The sheet closes that gap. It is the operator's own statement of how the opening
stock is held, and the import judges it with the same stock guards as everything
else.

## 2. Download it

1. Open the staged SADIO import in the portal.
2. Find the section **Stock sheet — batch and expiry**.
3. Choose **Download stock sheet**. The file is `tally-stock-sheet.xlsx`.

The download only works after the masters file is staged; the sheet is built
from it.

## 3. What is already filled in

The **StockBatches** sheet has one row per stock item that opens with stock —
1,112 rows for this export — and these columns:

| Column | State | What to do |
|---|---|---|
| `stock_item` | filled | Leave exactly as it is. It is matched to the masters by name. |
| `batch` | empty | Type the batch name, if Tally uses one. |
| `expiry` | empty | Type the batch expiry date. |
| `quantity` | filled | The units the item opens with. Leave it as exported. |
| `amount` | filled | Tally's opening value. Leave it as exported. |
| `godown` | empty | Optional. Type one only if the batch sits somewhere other than the main location. |

The quantities are the opening position at the start of the exported period,
**1 October 2025**. They are Tally's figures. Do not change them to make the
sheet balance: if an opening quantity is wrong, that is a correction in Tally,
not in this sheet.

The second tab, **Read me**, repeats these instructions. It is not imported.

## 4. What you fill in

For every item, state how its opening stock is held:

- **One row per batch.** If an item opens with 10 units and they expire on two
  different dates, insert one extra row beneath it, repeat `stock_item`, and
  split the quantity between the two rows (for example 6 and 4). The rows for an
  item together should add up to the quantity that was pre-filled; the preview
  reports it if they do not, and imports the batches as listed.
- **Batch name** — type the name Tally uses. If Tally holds no batch names,
  leave the cell blank; Synapse gives the batch a key built from the item and
  its position in the list, marked as its own key rather than a Tally name it
  never had.
- **Expiry** — type the date as `YYYY-MM-DD` or `DD/MM/YYYY`. The batch is
  judged against 1 October 2025: an expiry before that date has already lapsed
  and is not received into sellable stock.
- **Whole units only.** A fraction of a unit cannot become a batch, and the
  preview reports the item if Tally's opening quantity carries one.
- **A row with no expiry creates no batch.** Its value stays in the ledger; the
  stock is not sellable.

Worked example (invented values):

| stock_item | batch | expiry | quantity | amount | godown |
|---|---|---|---|---|---|
| Example Tablet 500mg | B-2401 | 2027-03-31 | 6 | 3000 | |
| Example Tablet 500mg | B-2402 | 2027-09-30 | 4 | 2000 | |

Do not rename items, delete rows, add columns or change the sheet name. The
import reads the sheet named `StockBatches`.

## 5. Attach it

1. Save the workbook as `.xlsx`.
2. On the same import page, choose **Attach filled sheet** and pick the file.
   The portal confirms how many rows it read, raises the first problem it found
   if there is one, and runs the preview again by itself.
3. The preview merges the sheet into the masters and judges them with it. Each
   item now opens with the batches you stated. An item whose row carried no
   expiry appears in the review as opening stock without a batch: its value
   stays in the ledger, its stock is not sellable.
4. Check the review's stock findings for any item you expected to become a batch
   but did not. Item names are matched to the masters exactly, so use the
   downloaded sheet as it is rather than retyping a name.

If the batch quantities for an item do not add up to its opening quantity, the
preview says so. The batches are imported as listed; the message is there so the
difference is not silent.

## 6. What the sheet does not fix

The sheet fills **opening stock**. Three other gaps come from Tally's voucher
lines and masters, and need a different answer.

### 6.1 Inbound lines with no expiry — 4,552

Batch names exist — `Primary Batch` on 47,259 allocation lines and `524039` on
4 — but no allocation carries an expiry date. That leaves 4,552 inbound lines
(receipts and stock-journal lines) with no expiry. Until the absence is accepted
at preview, replay refuses those receipts and no purchase movement is built.

Accepting it is an explicit, recorded decision: the receipts import under
Tally's batch name with no expiry, and that stock cannot be expiry-tracked or
recalled by expiry. Stock received after cut-over is unaffected.

If you want expiry-tracked history, turn on batch expiry in Tally, re-export the
affected months, and stage them again. The sheet cannot supply this.

### 6.2 Lines with a value and no quantity — 5 lines

These cannot be replayed as written, and Synapse will not invent a quantity.
Correct them in Tally and re-export, or confirm in writing that the quantity
cannot be established.

| Voucher | Date | Line | Item | Line value |
|---|---|---|---:|---:|
| Purchase 74 | 2025-11-04 | 2 | Swazi Tab 500mg (Azithromycin) | 20,000 |
| Purchase 122 | 2025-11-16 | 0 | Savlon 200mls | 10,500 |
| Purchase 351 | 2026-01-25 | 5 | A.Plaster 2 | 8,000 |
| Purchase 351 | 2026-01-25 | 6 | Normal Saline Infusion | 17,000 |
| Physical Stock 123 | 2026-02-13 | 19 | Furosimide Uk 40mg | 276 |

### 6.3 Two items the export cannot order

The export carries no time of day. For two items, a physical count and another
voucher on the same day could have been posted in either order, and Tally's
closing figure implies an order the file does not record. The preview reports
them as differences rather than guessing:

- `Vicryl No.1 Round Bodied` — Tally closes at 26, replay reaches 30.
- `Supirocin Ointment (A)` — Tally closes at 12, replay reaches 7.

Confirm that these differences are understood and acceptable. Nothing in the
sheet changes them.

## 7. Before you attach — checklist

- [ ] Every row that should create stock has an expiry.
- [ ] Batch rows for each item add up to the quantity that was pre-filled.
- [ ] Quantities are whole units.
- [ ] No `stock_item` name was edited, and no column or sheet was renamed.
- [ ] The five lines in §6.2 are corrected at source or confirmed in writing.
- [ ] You have decided on the no-expiry receipts in §6.1.
- [ ] The file is saved as `.xlsx` and not re-saved through another program that
      renames the sheet.
