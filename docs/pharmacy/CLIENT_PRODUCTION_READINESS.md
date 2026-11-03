# Client production readiness statement

A plain statement, for the pharmacy’s owners, of what the system does today,
what it needs from you, and what is not yet proven. It is written to be read
alongside [PRODUCTION_READINESS_PROGRESS.md](./PRODUCTION_READINESS_PROGRESS.md),
which holds the engineering detail.

Where this document and a demonstration disagree, the demonstration is wrong —
ask, and the statement gets corrected.

---

## 1. What you are getting

A pharmacy system that runs in a web browser on your tills, and on a phone, and
holds your sales, stock, batches, expiry dates, suppliers, purchases, customer
credit and accounting in one place, per pharmacy.

It does not require Tally to operate. Tally is used once, to bring your existing
history across.

---

## 2. What is ready

| Area | State |
|---|---|
| Selling at the till (POS), including packages, discounts and multiple payment methods | Ready |
| Receipt printing, with your header, footer, currency and paper size | Ready |
| Stock, batches, expiry tracking and reorder levels | Ready |
| Suppliers, purchase orders and receiving | Ready |
| Customer credit ledger | Ready |
| Reports | Ready |
| Staff accounts and per-section permissions | Ready |
| Separate data per pharmacy, enforced by the database itself | Ready |
| Till cash-up and end-of-day records | Ready |
| Working during an internet outage, and syncing afterwards | Ready for the parts of the till that support it |

---

## 3. What you must provide

1. A named administrator with an email address they control.
2. Your tax position: whether VAT applies and at what rate.
3. Your receipt wording — the legal name and contact line as you want them
   printed.
4. Your opening stock count, signed by someone accountable for it.
5. Your staff list, and who may issue refunds and who may buy stock.
6. A printer for each till, and the paper width it takes.

Onboarding is described line by line in
[CLIENT_ONBOARDING_CHECKLIST.md](./CLIENT_ONBOARDING_CHECKLIST.md).

---

## 4. What is not yet proven

Stated plainly, because you are making an operating decision.

| Item | Status | What it means for you |
|---|---|---|
| Bringing data across from Tally | Extraction, review and applying are built, but have not yet been run against a real Tally installation on a Windows PC | Do not schedule your Tally cut-over until that test is complete. Until then, keep Tally running in parallel |
| Working with Tally switched off after cut-over | Partly demonstrated; not end to end | Nothing in the till, stock or reports reaches Tally — that is now executed as a test, together with a sale completed with the Tally switch off and every outbound request blocked. What is missing is the same run in a browser on your PC after a real import. The disconnect test in `TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md` remains the gate |
| Refunds and manual stock adjustments on a newly created environment | Fixed and demonstrated on the test database | A rebuilt environment now builds completely and the refund and stock paths execute there; this has not yet been run on the live system, so keep backups and ask before relying on a rebuilt copy |
| “Require receipt print” setting | Enforced on both surfaces, not yet verified on hardware | Once switched on, the web till cannot be dismissed past the print prompt and the mobile receipt cannot be left without a print decision. Neither has been tried on a real printer or phone, so confirm it on your own equipment before depending on it |

None of these make the till unsafe to use. They are the reasons a cut-over date
is not yet something to commit to.

---

## 5. What the system protects

- Your data is separated from every other pharmacy’s at the database level, not
  only in the screens.
- Money is recomputed on the server; a till cannot invent a price.
- A discount above your approval threshold needs a supervisor.
- Every sale, refund, stock movement and setting change is attributable to a
  person.
- The Tally connection only ever reads from Tally. It never writes to your
  accounting books.

---

## 6. Support

| Situation | What to do |
|---|---|
| Cannot sign in | Contact your administrator first; then SYNAPSE support |
| A sale will not complete | Note the exact message, do not retry repeatedly, and send a screenshot |
| What the system says does not match the shelf | Record the product and both numbers; do not adjust stock to match the screen until it is understood |
| Anything involving Tally | Stop, and contact SYNAPSE before touching Tally |

When reporting a problem, always include: what you were doing, what you expected,
what happened, the time, and the user name. A description without those is a
conversation, not a fix.

---

## 7. Sign-off

By signing, the pharmacy acknowledges that it has read §4 and understands which
capabilities are proven and which are not.

| Role | Name | Date | Signature |
|---|---|---|---|
| Pharmacy owner / director | | | |
| SYNAPSE representative | | | |
