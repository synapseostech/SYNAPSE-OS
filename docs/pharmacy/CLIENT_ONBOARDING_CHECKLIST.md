# Client onboarding checklist

Everything a new pharmacy needs before its first real sale, in order. Each line
is ticked only when someone has seen the result, not when the step was attempted.

Do this in a staging or pilot tenant first. A tenant that has taken real sales
cannot be reset without deleting those sales.

---

## 0. Before the visit

| # | Item | Evidence |
|---|---|---|
| 0.1 | Client name, trading name, branch count and physical address confirmed | signed onboarding form |
| 0.2 | Business TIN / tax status confirmed (whether VAT applies, and at what rate) | client document |
| 0.3 | Named administrator with an email address they control | name and email |
| 0.4 | Printer model and paper width (58 mm or 80 mm) known | model number |
| 0.5 | Devices confirmed: which till PCs or tablets, which browser | list |
| 0.6 | If migrating from Tally: read `TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md` first | acknowledgement |

---

## 1. Tenant

| # | Item | Evidence |
|---|---|---|
| 1.1 | Facility created in the platform console | facility id |
| 1.2 | Pharmacy tenant provisioned and reachable on its host | the host URL loads the sign-in page |
| 1.3 | `GET /api/ready` returns `200` with `checks.database.ok: true` | response captured |
| 1.4 | Administrator account created and can sign in | sign-in screenshot |
| 1.5 | Administrator is confirmed as `ADMIN` (every area, including settings, staff and ledger) | the users screen |

---

## 2. Settings

Open **Settings**. Until these are right, receipts and reports will be wrong.

| # | Item | Evidence |
|---|---|---|
| 2.1 | Currency is `UGX` unless the client trades otherwise | settings screen |
| 2.2 | Receipt header carries the pharmacy’s legal name as registered | printed sample |
| 2.3 | Receipt footer carries the client’s contact line | printed sample |
| 2.4 | VAT enabled/disabled matches §0.2; rate correct if enabled | settings screen |
| 2.5 | Paper width and font scale match the printer | printed sample |
| 2.6 | Auto-print matches how the till is used | settings screen |
| 2.7 | If “Require receipt print” is enabled, exercise it on the actual device: the mobile receipt must refuse to be left until the print sheet is opened or “printer unavailable” is recorded, and the web till prompt must not be dismissed with **Escape**. The gate is implemented and unit-tested on both surfaces; neither has been run on real hardware, so treat 2.7 as unproven until this line is ticked | device observation |

---

## 3. Catalogue and stock

| # | Item | Evidence |
|---|---|---|
| 3.1 | Products loaded (import assistant, Tally cut-over, or manual entry) | product count |
| 3.2 | Every product has a selling price and a unit of sale | products screen |
| 3.3 | Batches and expiry dates present where the client tracks them | batch list |
| 3.4 | Opening quantities entered and reconciled to the client’s stock count | signed stock sheet |
| 3.5 | A spot check of five products matches the shelf | ticked count |
| 3.6 | Reorder levels set for the client’s fast movers | report |

---

## 4. People

| # | Item | Evidence |
|---|---|---|
| 4.1 | Each staff member has their own account — no shared logins | users screen |
| 4.2 | Profiles assigned from: **Pharmacy administrator**, **Sales & stock clerk**, **Cashier**, **Inventory officer** | users screen |
| 4.3 | Refunds are granted only to people who should issue them (`MANAGE_TRANSACTIONS`) | permission list |
| 4.4 | Purchasing is granted only to people who should buy (`purchasing.manage`) | permission list |
| 4.5 | Staff have signed in once, on the device they will use | sign-in record |

Every staff account opens POS, Till and Customers regardless of what is ticked.
That is deliberate; explain it so nobody thinks permissions are broken.

---

## 5. Till

| # | Item | Evidence |
|---|---|---|
| 5.1 | Opening float recorded for each till | till screen |
| 5.2 | Cash payment path exercised on a scratch sale | receipt |
| 5.3 | A non-cash path the client uses exercised | receipt |
| 5.4 | Discount approval threshold confirmed with the client | settings screen |
| 5.5 | End-of-day cash-up completed once, and the variance explained | cash-up record |

---

## 6. Training

| # | Item | Evidence |
|---|---|---|
| 6.1 | Cashiers can: add items, take payment, print, and start a new sale | observed |
| 6.2 | Cashiers know what to do when a product is not found or out of stock | observed |
| 6.3 | Someone can issue a refund, and knows when not to | observed |
| 6.4 | Someone can receive a purchase and record a supplier payment | observed |
| 6.5 | Someone can read the reports the client asked for | observed |
| 6.6 | The client knows how to reach support, and what to send with a problem | contact card issued |

---

## 7. Go-live

| # | Item | Evidence |
|---|---|---|
| 7.1 | A trial sale is completed on the live tenant and voided/refunded correctly | receipt + refund record |
| 7.2 | Backups and recovery expectations explained to the client | acknowledgement |
| 7.3 | Offline behaviour explained: what works without internet, what does not | acknowledgement |
| 7.4 | Go-live date agreed and recorded | date |
| 7.5 | Support window for the first week agreed | contact and hours |

---

## 8. First week

| # | Item | Evidence |
|---|---|---|
| 8.1 | Daily: sales reconcile to cash taken | daily cash-up |
| 8.2 | Stock movements checked against physical counts | variance list |
| 8.3 | Any product or price error corrected at source, not worked around | change log |
| 8.4 | Issues raised are logged with a reproduction, not just a description | ticket list |
| 8.5 | Week-one review held with the client | notes |

---

## 9. Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Client administrator | | | |
| SYNAPSE onboarding engineer | | | |

A checklist with unticked lines is a plan, not a completed onboarding. Name the
unticked lines explicitly when handing over.
