# SYNAPSE PHARM V1 PRODUCTION READINESS

Release: Synapse Pharm v1 candidate (not GREEN)
Commit: `cursor/pharm-v1-green-bf39` (see git log after merge)
APK: Expo 1.2.2 / Android versionCode 6 — EAS `21af12b8-2643-4f96-9ac1-9c742bed5220` (built before this SHA)
Database: live `qfqakzmjatszisuqjwon` now has ship/receive transfer RPCs, till columns, and `generate_synapse_id(text)` compat
Date: 2026-08-23

## Gate summary

| Gate | Result |
|------|--------|
| CI / local `verify:pharm-release` | PENDING until this SHA is run |
| DB parity | PASS (transfer RPCs + till columns applied and verified) |
| RLS | PARTIAL (policies exist; live JWT isolation not run) |
| RPC security | PASS for transfer RPCs (anon/authenticated execute = false, service_role = true) |
| Cross tenant | BLOCKED (no tenant A/B JWTs) |
| Store scope | PARTIAL (shared `requireStoreScope` + unit tests; live store proof not run) |
| Web smoke | BLOCKED |
| Android smoke | BLOCKED |
| Offline restart | BLOCKED |
| Replay | PARTIAL (unit PASS; device BLOCKED) |
| Printer | BLOCKED |
| Till reconciliation | PARTIAL (lifecycle + APIs + UI; no operator close) |
| Full pilot smoke | BLOCKED |

## What changed in this hardening pass

- PR #49 EAS packaging is on `main` (`215da03`).
- Live additive SQL: transfer execution, till session columns, identity text-overload compat.
- Shared pharmacy context: tenant + store + capability.
- Till lifecycle CLOSED → OPEN → ACTIVE → CLOSING → CLOSED; the till is optional and POS sales complete without one, but an open till is what cash totals reconcile against; refunds attach cash totals.
- Financial reports default to `pharmacy_pos_sales` only so one business sale is not double-counted.
- Offline SyncCommand payloads are AES-GCM encrypted at rest with a per-install SecureStore key.
- Release gate split: `verify:pharm-release` (local, no skips) and `verify:pharm-release:live` (fails closed).

## Capability notes

Do not mark OPERATIONAL without the matching evidence. Till is PARTIAL. `offline_durable_pos` stays PARTIAL until device B/C. `stock_transfers_execute` is PILOT_READY for schema/RPC presence only — a live two-store transfer is still required.

## Security

- No service role in the APK.
- Transfer RPCs are service_role only.
- Expo token previously pasted in chat must be rotated: https://expo.dev/settings/access-tokens
- Sensitive offline payloads use AES-GCM. Catalogue/stock snapshots stay minimally identifying.
- SQLite is not SQLCipher; threat model is stolen-phone + unlocked app process, not full disk encryption.

## Operator work that still blocks GREEN

1. Run `npm run verify:pharm-release` on this SHA and keep the log.
2. Supply tenant A/B JWTs and run `SYNAPSE_PHARM_LIVE=1 npm run verify:pharm-live`.
3. Build a new EAS APK from **merged main** (target 1.3.0 / versionCode 7).
4. Execute `docs/testing/PHARM_OFFLINE_DEVICE_GREEN.md` cases A–H.
5. Execute `docs/testing/PHARM_PRINTER_GREEN.md` on one 80mm printer.
6. Fill every box in `docs/release/PHARMACY_PILOT_SMOKE.md`, plus store transfer and till close.

## Production recommendation

```text
YELLOW — CONTROLLED PILOT ONLY
```

GREEN is not allowed while any required gate is BLOCKED or FAIL.
